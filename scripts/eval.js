#!/usr/bin/env node
/**
 * Evaluation Harness (MRR & Recall@k Benchmark).
 *
 * Evaluates retrieval performance across 3 configurations:
 *   1. Vector-Only (dense cosine similarity)
 *   2. BM25-Only (full-text lexical search)
 *   3. Hybrid Search (Vector + BM25 + Reciprocal Rank Fusion k=60)
 *
 * Metrics:
 *   - Recall@5
 *   - Recall@8
 *   - Mean Reciprocal Rank (MRR)
 *
 * Usage:
 *   node scripts/eval.js
 *   node scripts/eval.js --save
 *   node scripts/eval.js --repos=eval/repos.json --questions=eval/questions.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from '../src/config/env.js';
import { embed } from '../src/adapters/embedder.js';
import { vectorSearch, keywordSearch, existingHashes } from '../src/adapters/vectorStore.js';
import { hybridSearch } from '../src/retrieval/hybridSearch.js';
import {
  computeRecallAtK,
  computeReciprocalRank,
  aggregateMetrics,
} from '../src/retrieval/metrics.js';
import { indexRepo } from '../src/ingestion/indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Runs the full retrieval evaluation suite.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.repos]
 * @param {Array<object>} [options.questions]
 * @param {string} [options.lancedbDataDir]
 * @param {Function} [options.embedderFn]
 * @param {Function} [options.vectorSearchFn]
 * @param {Function} [options.keywordSearchFn]
 * @param {Function} [options.hybridSearchFn]
 * @param {number} [options.topK=8]
 * @param {boolean} [options.saveResults=false]
 * @param {string} [options.resultsPath]
 * @param {Function} [options.logger]
 * @param {boolean} [options.autoIndex=false]
 * @returns {Promise<object>} Benchmark results and formatted tables
 */
export async function runEvaluation({
  repos = null,
  questions = null,
  lancedbDataDir = config.paths.lancedbDataDir,
  embedderFn = embed,
  vectorSearchFn = vectorSearch,
  keywordSearchFn = keywordSearch,
  hybridSearchFn = hybridSearch,
  topK = 8,
  saveResults = false,
  resultsPath = path.join(ROOT_DIR, 'eval', 'results.md'),
  logger = console.log,
  autoIndex = false,
} = {}) {
  // 1. Load repos and questions from files if not directly provided
  const reposList =
    repos ||
    JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'eval', 'repos.json'), 'utf8'));
  const questionsList =
    questions ||
    JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'eval', 'questions.json'), 'utf8'));

  logger(`Loaded ${reposList.length} repository definitions and ${questionsList.length} benchmark questions.`);

  // 2. Ensure repos are indexed if autoIndex is enabled
  if (autoIndex) {
    for (const r of reposList) {
      try {
        const hashes = await existingHashes(r.id, lancedbDataDir);
        if (hashes.size === 0) {
          logger(`Repo ${r.id} not indexed. Indexing now...`);
          await indexRepo({
            owner: r.owner,
            repo: r.repo,
            repoId: r.id,
            configOverrides: { lancedbDataDir },
            onProgress: (stage, detail) => logger(`  [${stage}] ${detail}`),
          });
        } else {
          logger(`Repo ${r.id} is already indexed (${hashes.size} chunk hashes found).`);
        }
      } catch (err) {
        logger(`Warning: Failed checking/indexing ${r.id}: ${err.message}`);
      }
    }
  }

  // 3. Evaluate each question across all 3 strategies
  const vectorEvals = [];
  const bm25Evals = [];
  const hybridEvals = [];
  const detailedBreakdown = [];

  for (const item of questionsList) {
    const { id, repoId, question, expectedFiles } = item;
    logger(`\nEvaluating [${id}] "${question}" (Expected: ${expectedFiles.join(', ')})`);

    // A. Vector-Only Search
    let vectorChunks = [];
    try {
      const qVectors = await embedderFn([question]);
      if (qVectors && qVectors[0]) {
        vectorChunks = await vectorSearchFn(repoId, qVectors[0], topK, lancedbDataDir);
      }
    } catch (err) {
      logger(`  Vector search failed for ${id}: ${err.message}`);
    }

    const vRecall5 = computeRecallAtK(vectorChunks, expectedFiles, 5);
    const vRecall8 = computeRecallAtK(vectorChunks, expectedFiles, 8);
    const vRR = computeReciprocalRank(vectorChunks, expectedFiles);
    vectorEvals.push({ recallAt5: vRecall5, recallAt8: vRecall8, reciprocalRank: vRR });

    // B. BM25-Only Search
    let bm25Chunks = [];
    try {
      bm25Chunks = await keywordSearchFn(repoId, question, topK, lancedbDataDir);
    } catch (err) {
      logger(`  BM25 search failed for ${id}: ${err.message}`);
    }

    const bRecall5 = computeRecallAtK(bm25Chunks, expectedFiles, 5);
    const bRecall8 = computeRecallAtK(bm25Chunks, expectedFiles, 8);
    const bRR = computeReciprocalRank(bm25Chunks, expectedFiles);
    bm25Evals.push({ recallAt5: bRecall5, recallAt8: bRecall8, reciprocalRank: bRR });

    // C. Hybrid Search (RRF)
    let hybridChunks = [];
    try {
      hybridChunks = await hybridSearchFn({
        repoId,
        query: question,
        topK,
        lancedbDataDir,
        embedderFn,
        vectorSearchFn,
        keywordSearchFn,
      });
    } catch (err) {
      logger(`  Hybrid search failed for ${id}: ${err.message}`);
    }

    const hRecall5 = computeRecallAtK(hybridChunks, expectedFiles, 5);
    const hRecall8 = computeRecallAtK(hybridChunks, expectedFiles, 8);
    const hRR = computeReciprocalRank(hybridChunks, expectedFiles);
    hybridEvals.push({ recallAt5: hRecall5, recallAt8: hRecall8, reciprocalRank: hRR });

    logger(`  -> Vector: Recall@5=${vRecall5}, MRR=${vRR.toFixed(3)} | BM25: Recall@5=${bRecall5}, MRR=${bRR.toFixed(3)} | Hybrid: Recall@5=${hRecall5}, MRR=${hRR.toFixed(3)}`);

    detailedBreakdown.push({
      id,
      question,
      expectedFiles,
      vector: { recallAt5: vRecall5, recallAt8: vRecall8, rr: vRR, topFiles: vectorChunks.slice(0, 3).map((c) => c.filePath) },
      bm25: { recallAt5: bRecall5, recallAt8: bRecall8, rr: bRR, topFiles: bm25Chunks.slice(0, 3).map((c) => c.filePath) },
      hybrid: { recallAt5: hRecall5, recallAt8: hRecall8, rr: hRR, topFiles: hybridChunks.slice(0, 3).map((c) => c.filePath) },
    });
  }

  // 4. Aggregate metrics
  const vectorSummary = aggregateMetrics(vectorEvals);
  const bm25Summary = aggregateMetrics(bm25Evals);
  const hybridSummary = aggregateMetrics(hybridEvals);

  // 5. Generate Markdown Table
  const timestamp = new Date().toISOString();
  const markdown = [
    '# Retrieval Evaluation Benchmark Results',
    '',
    `*Run timestamp:* \`${timestamp}\`  `,
    `*Benchmark queries evaluated:* ${questionsList.length}  `,
    `*Repositories:* ${reposList.map((r) => r.id).join(', ')}  `,
    '',
    '## Overall Performance Summary',
    '',
    '| Retrieval Strategy | Recall@5 | Recall@8 | MRR |',
    '|---|---|---|---|',
    `| Vector-Only | ${vectorSummary.recallAt5.toFixed(4)} | ${vectorSummary.recallAt8.toFixed(4)} | ${vectorSummary.mrr.toFixed(4)} |`,
    `| BM25-Only | ${bm25Summary.recallAt5.toFixed(4)} | ${bm25Summary.recallAt8.toFixed(4)} | ${bm25Summary.mrr.toFixed(4)} |`,
    `| **Hybrid (Vector + BM25 + RRF)** | **${hybridSummary.recallAt5.toFixed(4)}** | **${hybridSummary.recallAt8.toFixed(4)}** | **${hybridSummary.mrr.toFixed(4)}** |`,
    '',
    '## Per-Query Breakdown',
    '',
    '| Query ID | Expected File(s) | Vector RR | BM25 RR | Hybrid RR |',
    '|---|---|---|---|---|',
    ...detailedBreakdown.map(
      (d) =>
        `| ${d.id} | \`${d.expectedFiles.join(', ')}\` | ${d.vector.rr.toFixed(3)} | ${d.bm25.rr.toFixed(3)} | **${d.hybrid.rr.toFixed(3)}** |`
    ),
    '',
  ].join('\n');

  // 6. Save results to markdown file if requested
  if (saveResults && resultsPath) {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, markdown, 'utf8');
    logger(`\nSaved benchmark results to ${resultsPath}`);
  }

  return {
    timestamp,
    vector: vectorSummary,
    bm25: bm25Summary,
    hybrid: hybridSummary,
    detailedBreakdown,
    markdown,
  };
}

// CLI Execution Entry Point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shouldSave = process.argv.includes('--save') || !process.argv.includes('--no-save');
  const shouldAutoIndex = process.argv.includes('--index');

  runEvaluation({
    saveResults: shouldSave,
    autoIndex: shouldAutoIndex,
  })
    .then((res) => {
      console.log('\n========================================');
      console.log(res.markdown);
      console.log('========================================\n');
    })
    .catch((err) => {
      console.error('Fatal evaluation runner error:', err);
      process.exit(1);
    });
}
