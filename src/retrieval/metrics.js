/**
 * Evaluation metrics for retrieval benchmarking (Recall@k and Mean Reciprocal Rank).
 */

/**
 * Normalizes file paths for robust matching across OS separators.
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Computes Recall@k for a single query.
 * Returns 1 if any retrieved chunk in top-k belongs to expectedFiles, else 0.
 *
 * @param {Array<object>} retrievedChunks Array of retrieved chunk objects with .filePath
 * @param {Array<string>} expectedFiles   Array of expected relative file paths
 * @param {number} k                      Cutoff rank (e.g. 5 or 8)
 * @returns {number} 1 or 0
 */
export function computeRecallAtK(retrievedChunks = [], expectedFiles = [], k = 5) {
  if (!expectedFiles || expectedFiles.length === 0) return 0;
  const expectedSet = new Set(expectedFiles.map(normalizePath));
  const topK = retrievedChunks.slice(0, k);

  for (const chunk of topK) {
    const chunkPath = normalizePath(chunk.filePath);
    if (expectedSet.has(chunkPath)) {
      return 1;
    }
  }

  return 0;
}

/**
 * Computes Reciprocal Rank for a single query.
 * Returns 1 / rank of the first relevant chunk, or 0 if none found.
 *
 * @param {Array<object>} retrievedChunks Array of retrieved chunk objects with .filePath
 * @param {Array<string>} expectedFiles   Array of expected relative file paths
 * @returns {number}
 */
export function computeReciprocalRank(retrievedChunks = [], expectedFiles = [], maxRank = 20) {
  if (!expectedFiles || expectedFiles.length === 0) return 0;
  const expectedSet = new Set(expectedFiles.map(normalizePath));
  const limit = Math.min(retrievedChunks.length, maxRank);

  for (let i = 0; i < limit; i++) {
    const chunkPath = normalizePath(retrievedChunks[i].filePath);
    if (expectedSet.has(chunkPath)) {
      return 1 / (i + 1);
    }
  }

  return 0;
}

/**
 * Aggregates benchmark metrics across an array of query evaluation runs.
 *
 * @param {Array<object>} queryEvaluations
 * @returns {object} Summary table metrics for vector, bm25, and hybrid
 */
export function aggregateMetrics(queryEvaluations = []) {
  if (queryEvaluations.length === 0) {
    return {
      count: 0,
      recallAt5: 0,
      recallAt8: 0,
      mrr: 0,
    };
  }

  const n = queryEvaluations.length;
  let sumRecall5 = 0;
  let sumRecall8 = 0;
  let sumRR = 0;

  for (const item of queryEvaluations) {
    sumRecall5 += item.recallAt5 ?? 0;
    sumRecall8 += item.recallAt8 ?? 0;
    sumRR += item.reciprocalRank ?? 0;
  }

  return {
    count: n,
    recallAt5: Number((sumRecall5 / n).toFixed(4)),
    recallAt8: Number((sumRecall8 / n).toFixed(4)),
    mrr: Number((sumRR / n).toFixed(4)),
  };
}
