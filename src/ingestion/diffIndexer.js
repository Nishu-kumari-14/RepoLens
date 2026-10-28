/**
 * Incremental Indexing Engine (Phase 7).
 *
 * Checks latest commit SHA against indexedCommitSha.
 * When changes are detected:
 *   1. Queries GitHub compare API to identify added, modified, and removed files.
 *   2. Extracts and filters changed files.
 *   3. Chunks and embeds new/modified files.
 *   4. Implements SAFE REPLACEMENT: inserts new chunks before deleting outdated ones,
 *      ensuring continuous query availability.
 *   5. Regenerates repository overview only if README, manifests, or entry points changed.
 *   6. Updates MongoDB indexedCommitSha and metadata.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getLatestCommit, downloadRepoArchive, compareCommits } from '../adapters/github.js';
import { extractZipBuffer } from '../utils/zipExtractor.js';
import { filterFiles } from './fileFilter.js';
import { scanFiles } from './secretScanner.js';
import { chunkFile } from './chunker.js';
import { embed, BATCH_SIZE } from '../adapters/embedder.js';
import { upsertChunks, deleteByFile } from '../adapters/vectorStore.js';
import { isReadme, isManifest, isEntryPoint, generateOverview } from '../generation/overview.js';
import { config } from '../config/env.js';

/**
 * Checks whether any of the changed file paths could affect the repository overview.
 *
 * @param {Array<string>} changedPaths
 * @returns {boolean}
 */
export function affectsOverview(changedPaths = []) {
  return changedPaths.some(
    (filePath) => isReadme(filePath) || isManifest(filePath) || isEntryPoint(filePath)
  );
}

/**
 * Performs incremental refresh on an indexed repository.
 *
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} [params.repoId]
 * @param {string} [params.indexedCommitSha]
 * @param {object} [params.repoDoc]
 * @param {object} [params.configOverrides]
 * @param {Function} [params.onProgress]
 * @param {object} [params.adapters] Optional overrides for unit testing
 * @returns {Promise<object>} Summary of the refresh operation
 */
export async function refreshRepo({
  owner,
  repo,
  repoId = `${owner}/${repo}`,
  indexedCommitSha = null,
  repoDoc = null,
  configOverrides = {},
  onProgress = () => {},
  adapters = {},
}) {
  const getLatestCommitFn = adapters.getLatestCommit || getLatestCommit;
  const compareCommitsFn = adapters.compareCommits || compareCommits;
  const downloadArchiveFn = adapters.downloadRepoArchive || downloadRepoArchive;
  const extractZipFn = adapters.extractZipBuffer || extractZipBuffer;
  const embedFn = adapters.embed || embed;
  const upsertChunksFn = adapters.upsertChunks || upsertChunks;
  const deleteByFileFn = adapters.deleteByFile || deleteByFile;
  const generateOverviewFn = adapters.generateOverview || generateOverview;
  const chunkFileFn = adapters.chunkFile || chunkFile;

  const wasmDir = configOverrides.wasmDir || config.paths.wasmDir;
  const lancedbDataDir = configOverrides.lancedbDataDir || config.paths.lancedbDataDir;
  const tempBaseDir = configOverrides.tempDir || config.paths.tempDir;
  const token = configOverrides.githubToken || config.keys.githubToken;

  const effectiveBaseSha = indexedCommitSha || repoDoc?.indexedCommitSha;

  // 1. Fetch latest commit SHA for default branch
  onProgress('fetch', `Checking latest commit for ${owner}/${repo}...`);
  const headSha = await getLatestCommitFn({ owner, repo, token });

  // 2. If commit SHA matches indexedCommitSha, repo is up to date
  if (effectiveBaseSha && effectiveBaseSha === headSha) {
    onProgress('ready', `Repository is already up to date at commit ${headSha}.`);
    return {
      upToDate: true,
      commitSha: headSha,
      addedFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      newChunks: 0,
      overviewRegenerated: false,
    };
  }

  // If no previous commit was indexed, full index should be performed
  if (!effectiveBaseSha) {
    throw new Error(
      `Repository "${owner}/${repo}" has no indexedCommitSha. Perform a full initial indexing first.`
    );
  }

  onProgress(
    'diff',
    `Comparing base commit ${effectiveBaseSha.slice(0, 7)} to HEAD ${headSha.slice(0, 7)}...`
  );

  // 3. Compare commits via GitHub Compare API
  const comparison = await compareCommitsFn({
    owner,
    repo,
    base: effectiveBaseSha,
    head: headSha,
    token,
  });

  const changedFileList = comparison.files || [];
  const addedFiles = changedFileList.filter((f) => f.status === 'added').map((f) => f.filename);
  const modifiedFiles = changedFileList.filter((f) => f.status === 'modified').map((f) => f.filename);
  const deletedFiles = changedFileList
    .filter((f) => f.status === 'removed' || (f.status === 'renamed' && f.previousFilename))
    .map((f) => f.previousFilename || f.filename);

  onProgress(
    'diff',
    `Diff found: ${addedFiles.length} added, ${modifiedFiles.length} modified, ${deletedFiles.length} deleted files.`
  );

  const filesToFetch = new Set([...addedFiles, ...modifiedFiles]);
  let newChunks = [];

  const tempDir = path.resolve(
    tempBaseDir,
    `repolens-diff-${owner}-${repo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  try {
    let includedFiles = [];

    if (filesToFetch.size > 0) {
      // 4. Download updated archive at HEAD to extract modified/added files
      onProgress('fetch', `Downloading HEAD archive at ${headSha.slice(0, 7)}...`);
      const zipBuffer = await downloadArchiveFn({
        owner,
        repo,
        commitSha: headSha,
        token,
      });

      fs.mkdirSync(tempDir, { recursive: true });
      const extractResult = await extractZipFn({
        zipBuffer,
        destDir: tempDir,
      });

      // Filter and scan secrets on the downloaded files
      const candidateFiles = extractResult.files
        .filter((f) => filesToFetch.has(f.path || f.relativePath))
        .map((f) => ({
          relativePath: f.relativePath || f.path,
          path: f.path || f.relativePath,
          content: f.content,
          sizeBytes: f.sizeBytes ?? Buffer.byteLength(f.content || '', 'utf8'),
        }));
      const { included } = filterFiles(candidateFiles);
      const { clean } = scanFiles(included);
      includedFiles = clean;

      // 5. Chunk updated files
      onProgress('chunk', `Chunking ${includedFiles.length} updated files...`);
      for (const file of includedFiles) {
        const fileChunks = await chunkFileFn({
          filePath: file.path,
          content: file.content,
          wasmDir,
        });
        newChunks.push(...fileChunks);
      }
    }

    // 6. Embed new chunks in batches
    if (newChunks.length > 0) {
      onProgress('embed', `Embedding ${newChunks.length} new chunks...`);
      const texts = newChunks.map((c) => c.embeddingText || c.content);
      const vectors = await embedFn(texts);

      // 7. SAFE SWAP: Insert new chunks before deleting outdated ones
      onProgress('store', `Upserting ${newChunks.length} chunks into LanceDB...`);
      await upsertChunksFn(repoId, headSha, newChunks, vectors, lancedbDataDir);
    }

    // 8. Delete outdated chunks for modified and deleted files
    const filesToPurge = new Set([...modifiedFiles, ...deletedFiles]);
    if (filesToPurge.size > 0) {
      onProgress('cleanup', `Purging old chunks for ${filesToPurge.size} modified/deleted files...`);
      for (const filePath of filesToPurge) {
        await deleteByFileFn(repoId, filePath, lancedbDataDir);
      }
    }

    // 9. Check if overview needs regeneration
    let overviewRegenerated = false;
    const allChanged = [...addedFiles, ...modifiedFiles, ...deletedFiles];
    if (affectsOverview(allChanged)) {
      onProgress('overview', 'Key manifests or README changed. Regenerating overview...');
      try {
        const overviewResult = await generateOverviewFn({
          files: includedFiles.map((f) => ({ filePath: f.path, content: f.content })),
        });
        if (repoDoc && overviewResult?.rawMarkdown) {
          repoDoc.overview = overviewResult.rawMarkdown;
        }
        overviewRegenerated = true;
      } catch (e) {
        // Non-fatal
      }
    }

    // 10. Update MongoDB repository doc
    if (repoDoc) {
      repoDoc.indexedCommitSha = headSha;
      repoDoc.status = 'ready';
      repoDoc.statusDetail = `Refreshed to ${headSha.slice(0, 7)}: +${addedFiles.length} ~${modifiedFiles.length} -${deletedFiles.length}`;
      await repoDoc.save().catch(() => {});
    }

    onProgress('ready', `Incremental refresh complete. Indexed commit: ${headSha}.`);

    return {
      upToDate: false,
      commitSha: headSha,
      addedFiles: addedFiles.length,
      modifiedFiles: modifiedFiles.length,
      deletedFiles: deletedFiles.length,
      newChunks: newChunks.length,
      overviewRegenerated,
    };
  } finally {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
