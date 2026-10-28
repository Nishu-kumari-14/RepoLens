/**
 * Ingestion pipeline orchestrator.
 *
 * Runs the complete Workflow A for one repository:
 *   fetch → filter → secret-scan → chunk → embed → store
 *
 * Writes MongoDB status at every stage so the UI can poll.
 * Supports resumable progress via repo.batchOffset.
 *
 * Usage:
 *   await indexRepo({ owner, repo, repoId, commitSha, ... })
 */
import fs from 'node:fs';
import path from 'node:path';
import { getLatestCommit, downloadRepoArchive } from '../adapters/github.js';
import { extractZipBuffer } from '../utils/zipExtractor.js';
import { filterFiles } from './fileFilter.js';
import { scanFiles } from './secretScanner.js';
import { chunkFile } from './chunker.js';
import { embed, BATCH_SIZE } from '../adapters/embedder.js';
import {
  upsertChunks,
  existingHashes,
  deleteByRepo,
} from '../adapters/vectorStore.js';
import { config } from '../config/env.js';

/**
 * Indexes a repository end-to-end.
 *
 * @param {object} params
 * @param {string}   params.owner
 * @param {string}   params.repo
 * @param {string}   [params.repoId]          MongoDB _id as string (for LanceDB partitioning)
 * @param {object}   [params.repoDoc]         Mongoose Repository doc (for status updates & resume)
 * @param {object}   [params.configOverrides] { wasmDir, lancedbDataDir, tempDir, maxArchiveSizeMb, ... }
 * @param {Function} [params.onProgress]      Callback: (stage, detail) → void
 * @returns {Promise<{ chunks: number, files: number, skipped: number, commitSha: string }>}
 */
export async function indexRepo({
  owner,
  repo,
  repoId = `${owner}/${repo}`,
  repoDoc = null,
  configOverrides = {},
  onProgress = () => {},
}) {
  const wasmDir = configOverrides.wasmDir || config.paths.wasmDir;
  const lancedbDataDir = configOverrides.lancedbDataDir || config.paths.lancedbDataDir;
  const tempBaseDir = configOverrides.tempDir || config.paths.tempDir;
  const maxArchiveSizeBytes =
    (configOverrides.maxArchiveSizeMb || config.limits.maxArchiveSizeMb) * 1024 * 1024;
  const maxFileCount = configOverrides.maxFileCount || config.limits.maxFileCount;
  const maxFileSizeKb = configOverrides.maxFileSizeKb || config.limits.maxFileSizeKb;
  const token = configOverrides.githubToken || config.keys.githubToken;

  const tempDir = path.resolve(
    tempBaseDir,
    `repolens-${owner}-${repo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  async function setStatus(status, detail = '') {
    onProgress(status, detail);
    if (repoDoc) {
      repoDoc.status = status;
      repoDoc.statusDetail = detail;
      await repoDoc.save().catch(() => {});
    }
  }

  try {
    // ── 1. Fetch latest commit SHA ────────────────────────────────────────────
    await setStatus('fetching', 'Getting latest commit SHA');
    const commitSha = await getLatestCommit({ owner, repo, token });

    // ── 2. Download archive ───────────────────────────────────────────────────
    await setStatus('fetching', 'Downloading zipball archive');
    const archiveBuffer = await downloadRepoArchive({
      owner,
      repo,
      commitSha,
      token,
      maxArchiveSizeBytes,
    });

    // ── 3. Extract ────────────────────────────────────────────────────────────
    await setStatus('processing', 'Extracting archive');
    const extractedFiles = await extractZipBuffer(archiveBuffer, tempDir, {
      maxArchiveSizeBytes,
      maxFileCount,
      maxSingleFileSizeBytes: maxFileSizeKb * 1024,
    });

    // ── 4. Filter ─────────────────────────────────────────────────────────────
    await setStatus('processing', 'Filtering files');
    const { included: filtered, skipped } = filterFiles(extractedFiles, { maxFileSizeKb });

    // ── 5. Secret scan ────────────────────────────────────────────────────────
    await setStatus('processing', 'Scanning for secrets');
    const { clean: includedFiles, flagged } = scanFiles(filtered);
    const totalSkipped = skipped.length + flagged.length;

    // ── 6. Chunk all included files ───────────────────────────────────────────
    await setStatus('processing', `Chunking ${includedFiles.length} files`);
    const allChunks = [];

    for (const file of includedFiles) {
      if (!file.fullPath || !fs.existsSync(file.fullPath)) continue;
      let content;
      try {
        content = fs.readFileSync(file.fullPath, 'utf8');
      } catch {
        continue;
      }
      const chunks = await chunkFile(content, file.relativePath, { wasmDir });
      for (const chunk of chunks) {
        allChunks.push(chunk);
      }
    }

    // ── 7. Dedup: skip chunks whose contentHash is already in LanceDB ─────────
    await setStatus('indexing', 'Checking existing chunk hashes');
    const stored = await existingHashes(repoId, lancedbDataDir);

    const newChunks = allChunks.filter(
      (c) => !stored.has(`${c.filePath}::${c.contentHash}`)
    );
    const skippedChunks = allChunks.length - newChunks.length;

    if (newChunks.length === 0) {
      await setStatus('ready', `All ${allChunks.length} chunks already indexed (no changes)`);
      return {
        commitSha,
        files: includedFiles.length,
        chunks: allChunks.length,
        skipped: totalSkipped,
        newChunks: 0,
        skippedChunks,
      };
    }

    // ── 8. Embed in batches, resumable ────────────────────────────────────────
    const texts = newChunks.map((c) => c.embeddingText);
    const startBatch = repoDoc?.batchOffset || 0;
    const totalBatches = Math.ceil(texts.length / BATCH_SIZE);

    await setStatus('indexing', `Embedding ${newChunks.length} chunks (${totalBatches} batches)`);

    // Accumulate vectors and flush to LanceDB per batch
    const embeddingModelLabel = `${config.embedding.modelId}:${config.embedding.dimension}`;
    let batchVectors = [];
    let batchChunks = [];
    let currentBatchStart = startBatch * BATCH_SIZE;

    const onBatchComplete = async (completedBatchIdx, vectors) => {
      // completedBatchIdx is 1-based (the batch just finished)
      const globalBatchIdx = startBatch + completedBatchIdx - 1;
      const start = globalBatchIdx * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, newChunks.length);
      const batchChunkSlice = newChunks.slice(start, end);

      await upsertChunks(repoId, commitSha, batchChunkSlice, vectors, lancedbDataDir);

      // Save checkpoint
      if (repoDoc) {
        repoDoc.batchOffset = globalBatchIdx + 1;
        repoDoc.statusDetail = `Embedded batch ${globalBatchIdx + 1}/${totalBatches}`;
        await repoDoc.save().catch(() => {});
      }

      const pct = Math.round(((globalBatchIdx + 1) / totalBatches) * 100);
      onProgress('indexing', `Embedded batch ${globalBatchIdx + 1}/${totalBatches} (${pct}%)`);
    };

    await embed(texts, {
      startBatch,
      onBatchComplete,
    });

    // ── 9. Overview Generation (Phase 6) ──────────────────────────────────────
    let generatedOverview = null;
    if (configOverrides.generateOverview || (repoDoc && !repoDoc.overview)) {
      try {
        const { generateOverview } = await import('../generation/overview.js');
        const overviewFiles = [];
        for (const f of includedFiles) {
          if (f.fullPath && fs.existsSync(f.fullPath)) {
            try {
              overviewFiles.push({
                filePath: f.relativePath,
                content: fs.readFileSync(f.fullPath, 'utf8'),
              });
            } catch {}
          }
        }

        const overviewResult = await generateOverview({
          files: overviewFiles,
          llmGenerateFn: configOverrides.llmGenerateFn,
        });
        generatedOverview = overviewResult.rawMarkdown;
        if (repoDoc) {
          repoDoc.overview = generatedOverview;
        }
      } catch (overviewErr) {
        console.warn(`[indexer] Overview generation skipped: ${overviewErr.message}`);
      }
    }

    // ── 10. Update repo metadata ──────────────────────────────────────────────
    if (repoDoc) {
      repoDoc.status = 'ready';
      repoDoc.statusDetail = `Indexed ${newChunks.length} new chunks`;
      repoDoc.indexedCommitSha = commitSha;
      repoDoc.batchOffset = 0; // reset for next run
      repoDoc.embeddingModel = embeddingModelLabel;
      repoDoc.stats = {
        files: includedFiles.length,
        chunks: allChunks.length,
        skippedFiles: totalSkipped,
      };
      await repoDoc.save().catch(() => {});
    }

    return {
      commitSha,
      files: includedFiles.length,
      chunks: allChunks.length,
      skipped: totalSkipped,
      newChunks: newChunks.length,
      skippedChunks,
      overview: generatedOverview,
    };
  } finally {
    // ── 10. Always clean temp files ───────────────────────────────────────────
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`[indexer] Failed to clean up temp dir ${tempDir}: ${e.message}`);
    }
  }
}
