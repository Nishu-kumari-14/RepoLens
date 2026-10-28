import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runEvaluation } from '../../scripts/eval.js';

describe('Milestone 5: Evaluation Runner (runEvaluation)', () => {
  const sampleRepos = [
    {
      id: 'sample/repo',
      owner: 'sample',
      repo: 'repo',
      commitSha: 'abcdef123456',
    },
  ];

  const sampleQuestions = [
    {
      id: 'q1',
      repoId: 'sample/repo',
      question: 'Where is auth handled?',
      expectedFiles: ['auth.js'],
    },
    {
      id: 'q2',
      repoId: 'sample/repo',
      question: 'Where is database config stored?',
      expectedFiles: ['db.js'],
    },
  ];

  it('runs benchmarks and computes metrics across vector, bm25, and hybrid modes', async () => {
    // Mock vector search: returns auth.js at rank 1 for q1, but misses q2
    const mockVectorSearch = async (repoId, vector, topK) => {
      return [
        { filePath: 'auth.js', startLine: 1, endLine: 20 },
        { filePath: 'other.js', startLine: 1, endLine: 20 },
      ];
    };

    // Mock keyword search: returns db.js at rank 1 for q2, but misses q1
    const mockKeywordSearch = async (repoId, text, topK) => {
      return [
        { filePath: 'db.js', startLine: 1, endLine: 20 },
        { filePath: 'other.js', startLine: 1, endLine: 20 },
      ];
    };

    // Mock hybrid search: combines both so both q1 and q2 succeed
    const mockHybridSearch = async ({ query }) => {
      if (query.includes('auth')) {
        return [{ filePath: 'auth.js', startLine: 1, endLine: 20 }];
      }
      return [{ filePath: 'db.js', startLine: 1, endLine: 20 }];
    };

    const mockEmbedder = async () => [[0.1, 0.2]];

    const results = await runEvaluation({
      repos: sampleRepos,
      questions: sampleQuestions,
      embedderFn: mockEmbedder,
      vectorSearchFn: mockVectorSearch,
      keywordSearchFn: mockKeywordSearch,
      hybridSearchFn: mockHybridSearch,
      logger: () => {}, // silent
    });

    assert.equal(results.vector.count, 2);
    // Vector search found q1 (auth.js rank 1) but q2 returned [auth.js, other.js] which misses db.js
    assert.equal(results.vector.recallAt5, 0.5);
    assert.equal(results.vector.mrr, 0.5);

    // BM25 search found q2 (db.js rank 1) but q1 returned [db.js, other.js] which misses auth.js
    assert.equal(results.bm25.recallAt5, 0.5);
    assert.equal(results.bm25.mrr, 0.5);

    // Hybrid search found both at rank 1!
    assert.equal(results.hybrid.recallAt5, 1.0);
    assert.equal(results.hybrid.mrr, 1.0);

    // Markdown table generated
    assert.ok(results.markdown.includes('Retrieval Evaluation Benchmark Results'));
    assert.ok(results.markdown.includes('Hybrid (Vector + BM25 + RRF)'));
  });

  it('saves markdown report to resultsPath when saveResults is true', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repolens-eval-test-'));
    const resultsPath = path.join(tmpDir, 'results.md');

    try {
      await runEvaluation({
        repos: sampleRepos,
        questions: sampleQuestions,
        embedderFn: async () => [[0.1]],
        vectorSearchFn: async () => [],
        keywordSearchFn: async () => [],
        hybridSearchFn: async () => [],
        saveResults: true,
        resultsPath,
        logger: () => {},
      });

      assert.ok(fs.existsSync(resultsPath));
      const content = fs.readFileSync(resultsPath, 'utf8');
      assert.ok(content.includes('# Retrieval Evaluation Benchmark Results'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
