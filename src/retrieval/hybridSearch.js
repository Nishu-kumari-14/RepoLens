/**
 * Hybrid retrieval engine combining vector search and BM25 full-text search.
 * Merges results using Reciprocal Rank Fusion (RRF).
 */
import { embed } from '../adapters/embedder.js';
import { vectorSearch, keywordSearch } from '../adapters/vectorStore.js';
import { RETRIEVAL_DEFAULTS } from '../config/constants.js';

/**
 * Calculates Reciprocal Rank Fusion (RRF) scores across multiple ranked lists.
 * Formula: score(d) = sum(1 / (k + rank_i(d)))
 *
 * @param {Array<object>} vectorList   Ranked array of chunks from vector search
 * @param {Array<object>} keywordList  Ranked array of chunks from BM25 search
 * @param {object} [options]
 * @param {number} [options.k=60]      RRF smoothing constant (default 60)
 * @param {number} [options.topK=8]    Max results to return
 * @returns {Array<object>} Merged, deduplicated and re-ranked chunks with rrfScore
 */
export function reciprocalRankFusion(vectorList = [], keywordList = [], options = {}) {
  const k = options.k ?? RETRIEVAL_DEFAULTS.RRF_K ?? 60;
  const topK = options.topK ?? RETRIEVAL_DEFAULTS.FINAL_TOP_K ?? 8;

  const scoreMap = new Map();

  function getChunkKey(chunk) {
    if (chunk.chunkId) return chunk.chunkId;
    return `${chunk.repositoryId || ''}:${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
  }

  // 1. Process vector results
  vectorList.forEach((chunk, idx) => {
    const key = getChunkKey(chunk);
    const rank = idx + 1; // 1-based rank
    const contribution = 1 / (k + rank);

    if (!scoreMap.has(key)) {
      scoreMap.set(key, {
        chunk,
        score: contribution,
        vectorRank: rank,
        keywordRank: null,
      });
    } else {
      const entry = scoreMap.get(key);
      entry.score += contribution;
      entry.vectorRank = rank;
    }
  });

  // 2. Process keyword results
  keywordList.forEach((chunk, idx) => {
    const key = getChunkKey(chunk);
    const rank = idx + 1; // 1-based rank
    const contribution = 1 / (k + rank);

    if (!scoreMap.has(key)) {
      scoreMap.set(key, {
        chunk,
        score: contribution,
        vectorRank: null,
        keywordRank: rank,
      });
    } else {
      const entry = scoreMap.get(key);
      entry.score += contribution;
      entry.keywordRank = rank;
    }
  });

  // 3. Sort by combined RRF score descending
  const sorted = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);

  // 4. Return formatted topK chunks
  return sorted.slice(0, topK).map((entry) => ({
    ...entry.chunk,
    rrfScore: entry.score,
    vectorRank: entry.vectorRank,
    keywordRank: entry.keywordRank,
  }));
}

/**
 * Executes hybrid search for a query against a indexed repository.
 *
 * @param {object} params
 * @param {string} params.repoId
 * @param {string} params.query
 * @param {number} [params.topK]
 * @param {number} [params.vectorTopK]
 * @param {number} [params.bm25TopK]
 * @param {string} [params.lancedbDataDir]
 * @param {Function} [params.embedderFn] Optional embedder override for testing
 * @returns {Promise<Array<object>>}
 */
export async function hybridSearch({
  repoId,
  query,
  topK = RETRIEVAL_DEFAULTS.FINAL_TOP_K ?? 8,
  vectorTopK = RETRIEVAL_DEFAULTS.VECTOR_TOP_K ?? 20,
  bm25TopK = RETRIEVAL_DEFAULTS.BM25_TOP_K ?? 20,
  lancedbDataDir,
  embedderFn = embed,
  vectorSearchFn = vectorSearch,
  keywordSearchFn = keywordSearch,
}) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return [];
  }

  // 1. Embed query
  const queryVectors = await embedderFn([query.trim()]);
  const queryVector = queryVectors[0];

  // 2. Parallel retrieval: vector search + BM25 keyword search
  const [vectorResults, keywordResults] = await Promise.all([
    queryVector ? vectorSearchFn(repoId, queryVector, vectorTopK, lancedbDataDir).catch(() => []) : Promise.resolve([]),
    keywordSearchFn(repoId, query.trim(), bm25TopK, lancedbDataDir).catch(() => []),
  ]);

  // 3. Merge with Reciprocal Rank Fusion
  return reciprocalRankFusion(vectorResults, keywordResults, {
    k: RETRIEVAL_DEFAULTS.RRF_K ?? 60,
    topK,
  });
}
