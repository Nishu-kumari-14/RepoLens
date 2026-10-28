#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseRepoUrl } from '../src/ingestion/parseRepoUrl.js';
import { getLatestCommit, downloadRepoArchive } from '../src/adapters/github.js';
import { extractZipBuffer } from '../src/utils/zipExtractor.js';
import { filterFiles } from '../src/ingestion/fileFilter.js';
import { scanFiles } from '../src/ingestion/secretScanner.js';
import { chunkFile } from '../src/ingestion/chunker.js';
import { indexRepo } from '../src/ingestion/indexer.js';
import { refreshRepo } from '../src/ingestion/diffIndexer.js';
import { config } from '../src/config/env.js';

async function main() {
  const args = process.argv.slice(2);
  const isVerbose = args.includes('--verbose') || args.includes('-v');
  const showChunks = args.includes('--chunks');
  const runFullIndex = args.includes('--index');
  const isRefresh = args.includes('--refresh');
  const targetUrl = args.find((arg) => !arg.startsWith('-'));

  if (!targetUrl) {
    console.error('Usage: node scripts/index-repo.js <github-repo-url> [--verbose] [--chunks] [--index] [--refresh]');
    process.exit(1);
  }

  // 1. Validate repository URL
  let parsedRepo;
  try {
    parsedRepo = parseRepoUrl(targetUrl);
  } catch (err) {
    console.error(`URL Validation Error: ${err.message}`);
    process.exit(1);
  }

  const { owner, repo, canonicalUrl } = parsedRepo;

  if (isRefresh) {
    console.log(`\n======================================================`);
    console.log(` RepoLens Incremental Refresh: ${owner}/${repo}`);
    console.log(` Canonical URL:   ${canonicalUrl}`);
    console.log(`======================================================\n`);

    try {
      let repoDoc = null;
      try {
        const { connect } = await import('../src/db/mongo.js');
        const { Repository } = await import('../src/db/models.js');
        await connect();
        repoDoc = await Repository.findOne({ owner, name: repo });
      } catch (dbErr) {
        if (isVerbose) {
          console.warn(`[index-repo] MongoDB connection skipped or failed (${dbErr.message}).`);
        }
      }

      const result = await refreshRepo({
        owner,
        repo,
        repoId: repoDoc ? String(repoDoc._id) : `${owner}/${repo}`,
        repoDoc,
        onProgress: (stage, detail) => {
          console.log(`[${stage.toUpperCase()}] ${detail}`);
        },
      });

      console.log(`\n---------------- Refresh Summary ----------------`);
      console.log(`Repository:            ${owner}/${repo}`);
      console.log(`Commit SHA:            ${result.commitSha}`);
      console.log(`Up to Date:            ${result.upToDate ? 'YES' : 'NO'}`);
      console.log(`Files Added:           ${result.addedFiles ?? 0}`);
      console.log(`Files Modified:        ${result.modifiedFiles ?? 0}`);
      console.log(`Files Deleted:         ${result.deletedFiles ?? 0}`);
      console.log(`New Chunks Embedded:   ${result.newChunks ?? 0}`);
      console.log(`Overview Regenerated:  ${result.overviewRegenerated ? 'YES' : 'NO'}`);
      console.log(`Status:                READY\n`);
      return;
    } catch (err) {
      console.error(`\n[ERROR] Refresh failed: ${err.message}\n`);
      process.exit(1);
    }
  }

  if (runFullIndex) {
    console.log(`\n======================================================`);
    console.log(` RepoLens Ingestion Pipeline: ${owner}/${repo}`);
    console.log(` Canonical URL:   ${canonicalUrl}`);
    console.log(`======================================================\n`);

    try {
      let repoDoc = null;
      try {
        const { connect } = await import('../src/db/mongo.js');
        const { Repository } = await import('../src/db/models.js');
        await connect();
        repoDoc = await Repository.findOneAndUpdate(
          { owner, name: repo },
          { url: canonicalUrl, status: 'queued', statusDetail: 'Starting pipeline' },
          { upsert: true, new: true }
        );
      } catch (dbErr) {
        if (isVerbose) {
          console.warn(`[index-repo] MongoDB connection skipped or failed (${dbErr.message}). Continuing with local LanceDB indexing.`);
        }
      }

      const result = await indexRepo({
        owner,
        repo,
        repoId: repoDoc ? String(repoDoc._id) : `${owner}/${repo}`,
        repoDoc,
        onProgress: (stage, detail) => {
          console.log(`[${stage.toUpperCase()}] ${detail}`);
        },
      });

      console.log(`\n---------------- Ingestion Complete ----------------`);
      console.log(`Repository:     ${owner}/${repo}`);
      console.log(`Commit SHA:     ${result.commitSha}`);
      console.log(`Files Processed: ${result.files}`);
      console.log(`Total Chunks:   ${result.chunks}`);
      console.log(`New Embedded:   ${result.newChunks ?? 0}`);
      console.log(`Skipped (Dedup): ${result.skippedChunks ?? 0}`);
      console.log(`LanceDB Dir:    ${config.paths.lancedbDataDir}`);
      console.log(`Status:         READY\n`);
      return;
    } catch (err) {
      console.error(`\n[ERROR] Ingestion failed: ${err.message}\n`);
      process.exit(1);
    }
  }

  console.log(`\n======================================================`);
  console.log(` RepoLens Dry Run: ${owner}/${repo}`);
  console.log(` Canonical URL:   ${canonicalUrl}`);
  if (isVerbose) console.log(` Mode:            VERBOSE`);
  console.log(`======================================================\n`);

  const tempExtractDir = path.resolve(
    config.paths.tempDir,
    `repolens-${owner}-${repo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  try {
    // 2. Fetch latest commit SHA
    process.stdout.write(`Fetching latest commit SHA... `);
    const commitSha = await getLatestCommit({
      owner,
      repo,
      token: config.keys.githubToken,
    });
    console.log(`[OK] (${commitSha})`);

    // 3. Download repository archive
    process.stdout.write(`Downloading repository archive (zipball)... `);
    const archiveBuffer = await downloadRepoArchive({
      owner,
      repo,
      commitSha,
      token: config.keys.githubToken,
      maxArchiveSizeBytes: config.limits.maxArchiveSizeMb * 1024 * 1024,
    });
    console.log(`[OK] (${(archiveBuffer.length / 1024).toFixed(1)} KB)`);

    // 4. Safely extract files with actual decompressed byte limits & zip-slip checks
    process.stdout.write(`Extracting archive safely... `);
    const extractedFiles = await extractZipBuffer(archiveBuffer, tempExtractDir, {
      maxArchiveSizeBytes: config.limits.maxArchiveSizeMb * 1024 * 1024,
      maxFileCount: config.limits.maxFileCount,
      maxSingleFileSizeBytes: config.limits.maxFileSizeKb * 1024,
    });
    console.log(`[OK] (${extractedFiles.length} files extracted)`);

    // 5. Filter files (allow source, skip vendored/lockfiles/binaries)
    const { included: initiallyIncluded, skipped, groupedReasons } = filterFiles(
      extractedFiles,
      { maxFileSizeKb: config.limits.maxFileSizeKb }
    );

    // 6. Scan included files for secrets (flagged files are excluded entirely)
    const { clean: finalIncluded, flagged: secretFlagged } = scanFiles(initiallyIncluded);

    // Add secret flagged files to skipped counts
    if (secretFlagged.length > 0) {
      groupedReasons['secret_detected'] = secretFlagged.length;
    }

    // 7. Output formatted dry run results
    console.log(`\n---------------- Ingestion Summary ----------------`);
    console.log(`Repository:            ${owner}/${repo}`);
    console.log(`Commit SHA:            ${commitSha}`);
    console.log(`Total Files In Zip:    ${extractedFiles.length}`);
    console.log(`Files Included:        ${finalIncluded.length}`);
    console.log(`Files Skipped:         ${skipped.length + secretFlagged.length}`);
    console.log(`Files Flagged Secrets: ${secretFlagged.length}`);

    if (Object.keys(groupedReasons).length > 0) {
      console.log(`\nSkipped Reasons Breakdown:`);
      for (const [reason, count] of Object.entries(groupedReasons)) {
        const cleanReason = reason.replace(/:$/, '');
        console.log(`  - ${cleanReason.padEnd(28)}: ${count}`);
      }
    }

    // Verbose listing
    if (isVerbose) {
      console.log(`\n---------------- Verbose File Listing ----------------`);
      console.log(`\nIncluded Files (${finalIncluded.length}):`);
      for (const item of finalIncluded) {
        console.log(`  [INCLUDED] ${item.relativePath} (${item.sizeBytes ?? 0} bytes)`);
      }

      console.log(`\nSkipped Files (${skipped.length}):`);
      for (const item of skipped) {
        console.log(`  [SKIPPED]  ${item.file.relativePath} [${item.reason}]`);
      }

      if (secretFlagged.length > 0) {
        console.log(`\nFlagged Secret Files (${secretFlagged.length}) [EXCLUDED ENTIRELY, NEVER EMBEDDED OR PRINTED]:`);
        for (const item of secretFlagged) {
          console.log(`  [FLAGGED]  ${item.file.relativePath} [${item.reason}]`);
        }
      }
    } else if (secretFlagged.length > 0) {
      console.log(`\nFlagged Secret Files (Excluded Entirely):`);
      for (const item of secretFlagged) {
        console.log(`  - [EXCLUDED] ${item.file.relativePath} (${item.reason})`);
      }
    }

    // 8. If --chunks flag is set, chunk all included files
    if (showChunks) {
      console.log(`\n---------------- Chunker Breakdown (--chunks) ----------------`);
      const fileChunkCounts = [];
      let totalChunks = 0;
      const allSampleChunks = [];
      const codeSamples = [];
      const otherSamples = [];

      for (const item of finalIncluded) {
        if (!item.fullPath || !fs.existsSync(item.fullPath)) continue;
        const content = fs.readFileSync(item.fullPath, 'utf8');
        const chunks = await chunkFile(content, item.relativePath, {
          wasmDir: config.paths.wasmDir,
        });

        fileChunkCounts.push({
          file: item.relativePath,
          count: chunks.length,
        });
        totalChunks += chunks.length;

        for (const c of chunks) {
          if (c.symbolKind === 'function' || c.symbolKind === 'method' || c.symbolKind === 'class') {
            if (codeSamples.length < 2) codeSamples.push(c);
          } else {
            if (otherSamples.length < 2) otherSamples.push(c);
          }
          if (allSampleChunks.length < 3) {
            allSampleChunks.push(c);
          }
        }
      }

      console.log(`Chunk count per file:`);
      for (const entry of fileChunkCounts) {
        console.log(`  - ${entry.file.padEnd(35)}: ${entry.count} chunks`);
      }
      console.log(`\nTotal Chunks: ${totalChunks}`);

      const samplesToPrint = [...codeSamples, ...otherSamples].slice(0, 3);
      const finalSamples = samplesToPrint.length === 3 ? samplesToPrint : allSampleChunks.slice(0, 3);

      if (finalSamples.length > 0) {
        console.log(`\nSample Chunks (up to 3):`);
        for (let i = 0; i < finalSamples.length; i++) {
          const sample = finalSamples[i];
          const parentInfo = sample.parent ? ` (Parent: ${sample.parent})` : '';
          console.log(`\n--- Sample Chunk #${i + 1} ---`);
          console.log(`File:       ${sample.filePath}`);
          console.log(`Symbol:     ${sample.symbol} [${sample.symbolKind}]${parentInfo}`);
          console.log(`Lines:      ${sample.startLine}-${sample.endLine} (inclusive)`);
          console.log(`Hash:       ${sample.contentHash}`);
          const preview = sample.content.length > 300 ? `${sample.content.slice(0, 300)}...` : sample.content;
          console.log(`Content:\n${preview.trim()}`);
        }
      }
    }

    console.log(`\n[DRY RUN COMPLETE] Zero files were executed or sent to external models.\n`);
  } catch (err) {
    console.error(`\n[ERROR] Ingestion failed: ${err.cause ? (err.cause.message || err.cause) : err.message}\n`);
    process.exitCode = 1;
  } finally {
    // 8. Always delete temporary files on completion or error
    try {
      if (fs.existsSync(tempExtractDir)) {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.error(`Warning: Failed to clean up temp dir ${tempExtractDir}: ${cleanupErr.message}`);
    }
  }
}

main();
