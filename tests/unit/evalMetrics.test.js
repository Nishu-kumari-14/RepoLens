import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRecallAtK,
  computeReciprocalRank,
  aggregateMetrics,
  normalizePath,
} from '../../src/retrieval/metrics.js';

describe('Milestone 5: Retrieval Evaluation Metrics (Recall@k & MRR)', () => {
  it('normalizes file paths with mixed backslashes and relative prefixes', () => {
    assert.equal(normalizePath('src\\adapters\\llm.js'), 'src/adapters/llm.js');
    assert.equal(normalizePath('./src/adapters/llm.js'), 'src/adapters/llm.js');
    assert.equal(normalizePath(''), '');
  });

  describe('computeRecallAtK', () => {
    const retrieved = [
      { filePath: 'src/utils/math.js' },
      { filePath: 'src/adapters/vectorStore.js' },
      { filePath: 'src/generation/answer.js' },
      { filePath: 'scripts/ask.js' },
      { filePath: 'index.js' },
      { filePath: 'README.md' },
    ];

    it('returns 1 when expected file is within top-k', () => {
      // index.js is at index 4 (rank 5)
      const recallAt5 = computeRecallAtK(retrieved, ['index.js'], 5);
      assert.equal(recallAt5, 1);

      // math.js is at rank 1
      const recallAt1 = computeRecallAtK(retrieved, ['src/utils/math.js'], 1);
      assert.equal(recallAt1, 1);
    });

    it('returns 0 when expected file is beyond top-k', () => {
      // README.md is at index 5 (rank 6)
      const recallAt5 = computeRecallAtK(retrieved, ['README.md'], 5);
      assert.equal(recallAt5, 0);

      // But it is in top-8
      const recallAt8 = computeRecallAtK(retrieved, ['README.md'], 8);
      assert.equal(recallAt8, 1);
    });

    it('returns 0 when expected file is absent or expectedFiles is empty', () => {
      assert.equal(computeRecallAtK(retrieved, ['nonexistent.js'], 10), 0);
      assert.equal(computeRecallAtK(retrieved, [], 10), 0);
      assert.equal(computeRecallAtK([], ['index.js'], 10), 0);
    });
  });

  describe('computeReciprocalRank', () => {
    const retrieved = [
      { filePath: 'src/utils/math.js' },        // rank 1 -> 1 / 1 = 1.0
      { filePath: 'src/adapters/vectorStore.js' }, // rank 2 -> 1 / 2 = 0.5
      { filePath: 'src/generation/answer.js' },    // rank 3 -> 1 / 3 =~ 0.3333
      { filePath: 'scripts/ask.js' },             // rank 4 -> 1 / 4 = 0.25
    ];

    it('returns 1.0 for rank 1 match', () => {
      const rr = computeReciprocalRank(retrieved, ['src/utils/math.js']);
      assert.equal(rr, 1.0);
    });

    it('returns 0.5 for rank 2 match', () => {
      const rr = computeReciprocalRank(retrieved, ['src/adapters/vectorStore.js']);
      assert.equal(rr, 0.5);
    });

    it('returns 1/3 for rank 3 match', () => {
      const rr = computeReciprocalRank(retrieved, ['src/generation/answer.js']);
      assert.ok(Math.abs(rr - (1 / 3)) < 1e-6);
    });

    it('returns 0 when expected file is not found in retrieved list', () => {
      const rr = computeReciprocalRank(retrieved, ['unknown.js']);
      assert.equal(rr, 0);
    });

    it('matches the earliest rank when multiple expected files appear', () => {
      // Both rank 2 and rank 4 are expected -> first is rank 2 (0.5)
      const rr = computeReciprocalRank(retrieved, ['scripts/ask.js', 'src/adapters/vectorStore.js']);
      assert.equal(rr, 0.5);
    });
  });

  describe('aggregateMetrics', () => {
    it('accurately calculates mean Recall@5, Recall@8, and MRR', () => {
      const queryEvaluations = [
        { recallAt5: 1, recallAt8: 1, reciprocalRank: 1.0 },   // rank 1
        { recallAt5: 0, recallAt8: 1, reciprocalRank: 0.1667 }, // rank 6
        { recallAt5: 0, recallAt8: 0, reciprocalRank: 0 },      // not found
        { recallAt5: 1, recallAt8: 1, reciprocalRank: 0.5 },    // rank 2
      ];

      const summary = aggregateMetrics(queryEvaluations);
      assert.equal(summary.count, 4);
      assert.equal(summary.recallAt5, 0.5); // (1 + 0 + 0 + 1) / 4 = 0.5
      assert.equal(summary.recallAt8, 0.75); // (1 + 1 + 0 + 1) / 4 = 0.75
      // MRR: (1.0 + 0.1667 + 0 + 0.5) / 4 = 1.6667 / 4 = 0.4167
      assert.ok(Math.abs(summary.mrr - 0.4167) < 1e-4);
    });

    it('handles empty query list gracefully', () => {
      const summary = aggregateMetrics([]);
      assert.equal(summary.count, 0);
      assert.equal(summary.recallAt5, 0);
      assert.equal(summary.recallAt8, 0);
      assert.equal(summary.mrr, 0);
    });
  });
});
