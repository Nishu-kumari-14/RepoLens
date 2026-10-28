import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion, hybridSearch } from '../../src/retrieval/hybridSearch.js';

describe('Milestone 4: Hybrid Search & Reciprocal Rank Fusion', () => {
  it('correctly calculates RRF scores using the formula 1 / (60 + rank)', () => {
    const chunkA = { chunkId: 'c_a', filePath: 'a.js', startLine: 1, endLine: 10 };
    const chunkB = { chunkId: 'c_b', filePath: 'b.js', startLine: 1, endLine: 10 };

    // vector list: [chunkA (rank 1), chunkB (rank 2)]
    const vectorList = [chunkA, chunkB];
    // keyword list empty
    const merged = reciprocalRankFusion(vectorList, [], { k: 60 });

    assert.equal(merged.length, 2);
    // Rank 1: 1 / (60 + 1) = 1 / 61
    const expectedScoreA = 1 / 61;
    // Rank 2: 1 / (60 + 2) = 1 / 62
    const expectedScoreB = 1 / 62;

    assert.ok(Math.abs(merged[0].rrfScore - expectedScoreA) < 1e-6);
    assert.ok(Math.abs(merged[1].rrfScore - expectedScoreB) < 1e-6);
  });

  it('boosts chunks present in both vector and keyword results', () => {
    const chunkA = { chunkId: 'c_a', filePath: 'a.js', startLine: 1, endLine: 10 };
    const chunkB = { chunkId: 'c_b', filePath: 'b.js', startLine: 1, endLine: 10 };
    const chunkC = { chunkId: 'c_c', filePath: 'c.js', startLine: 1, endLine: 10 };

    // chunkB appears in BOTH lists
    // vector: chunkA (rank 1), chunkB (rank 2)
    // keyword: chunkB (rank 1), chunkC (rank 2)
    const vectorList = [chunkA, chunkB];
    const keywordList = [chunkB, chunkC];

    const merged = reciprocalRankFusion(vectorList, keywordList, { k: 60 });

    // chunkB score: 1/(60+2) + 1/(60+1) = 1/62 + 1/61 =~ 0.0325
    // chunkA score: 1/(60+1) = 1/61 =~ 0.01639
    // chunkC score: 1/(60+2) = 1/62 =~ 0.01613
    assert.equal(merged[0].chunkId, 'c_b', 'Chunk present in both lists should be ranked #1');
    assert.equal(merged[0].vectorRank, 2);
    assert.equal(merged[0].keywordRank, 1);
    assert.equal(merged[1].chunkId, 'c_a');
    assert.equal(merged[2].chunkId, 'c_c');
  });

  it('deduplicates chunks and limits output to topK', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      chunkId: `c_${i}`,
      filePath: `file_${i}.js`,
      startLine: 1,
      endLine: 10,
    }));

    const merged = reciprocalRankFusion(items, [], { topK: 5 });
    assert.equal(merged.length, 5);
  });

  it('hybridSearch integrates embedding, vector search, and keyword search', async () => {
    const mockVectorChunk = { chunkId: 'v1', filePath: 'auth.js', startLine: 10, endLine: 20 };
    const mockKeywordChunk = { chunkId: 'k1', filePath: 'login.js', startLine: 5, endLine: 15 };

    const fakeEmbedder = async () => [[0.1, 0.2, 0.3]];
    const fakeVectorSearch = async () => [mockVectorChunk];
    const fakeKeywordSearch = async () => [mockKeywordChunk];

    const results = await hybridSearch({
      repoId: 'test-repo',
      query: 'how is authentication handled',
      topK: 5,
      embedderFn: fakeEmbedder,
      vectorSearchFn: fakeVectorSearch,
      keywordSearchFn: fakeKeywordSearch,
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].chunkId, 'v1');
    assert.equal(results[1].chunkId, 'k1');
  });

  it('hybridSearch handles missing table gracefully without throwing', async () => {
    const fakeEmbedder = async () => [[0.1, 0.2, 0.3]];
    const results = await hybridSearch({
      repoId: 'test-repo',
      query: 'some query',
      topK: 5,
      embedderFn: fakeEmbedder,
    });
    assert.ok(Array.isArray(results));
  });

  it('returns empty array when query is empty or whitespace', async () => {
    const emptyResult = await hybridSearch({ repoId: 'test-repo', query: '' });
    assert.deepEqual(emptyResult, []);

    const whitespaceResult = await hybridSearch({ repoId: 'test-repo', query: '   ' });
    assert.deepEqual(whitespaceResult, []);
  });
});
