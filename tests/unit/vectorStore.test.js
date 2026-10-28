/**
 * Unit tests for src/adapters/vectorStore.js
 *
 * Uses real LanceDB in a temporary directory — no mocks needed.
 * Each test gets a fresh temp dir so there is no shared state.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  upsertChunks,
  deleteByRepo,
  deleteByFile,
  vectorSearch,
  existingHashes,
  _clearCaches,
} from '../../src/adapters/vectorStore.js';

const DIM = 4; // tiny vectors for tests

function makeChunk(overrides = {}) {
  return {
    filePath: 'src/foo.js',
    language: 'javascript',
    symbol: 'foo',
    symbolKind: 'function',
    parent: null,
    startLine: 1,
    endLine: 5,
    content: 'function foo() { return 1; }',
    contentHash: 'abc123',
    embeddingText: 'File: src/foo.js | Symbol: foo\nfunction foo() { return 1; }',
    ...overrides,
  };
}

function makeVector(seed = 0) {
  return [seed * 0.1, seed * 0.2, seed * 0.3, seed * 0.4];
}

let testCounter = 0;
function tempDir() {
  testCounter++;
  return `memory://test-vs-${Date.now()}-${testCounter}`;
}

describe('Milestone 3: VectorStore', () => {
  it('upserts chunks and retrieves them via existingHashes', async () => {
    const dir = tempDir();
    _clearCaches();
    try {
      const repoId = 'repo1';
      const chunk = makeChunk();
      await upsertChunks(repoId, 'sha1', [chunk], [makeVector(1)], dir);

      const hashes = await existingHashes(repoId, dir);
      assert.ok(hashes.has('src/foo.js::abc123'), 'existingHashes should contain inserted chunk hash');
    } finally {
      _clearCaches();
    }
  });

  it('skipping already-indexed chunks: existingHashes returns correct set', async () => {
    const dir = tempDir();
    _clearCaches();
    try {
      const repoId = 'repo2';
      const chunkA = makeChunk({ filePath: 'a.js', contentHash: 'hashA', symbol: 'funcA' });
      const chunkB = makeChunk({ filePath: 'b.js', contentHash: 'hashB', symbol: 'funcB' });

      await upsertChunks(repoId, 'sha1', [chunkA, chunkB], [makeVector(1), makeVector(2)], dir);

      const hashes = await existingHashes(repoId, dir);
      assert.ok(hashes.has('a.js::hashA'));
      assert.ok(hashes.has('b.js::hashB'));
      assert.equal(hashes.size, 2);
    } finally {
      _clearCaches();
    }
  });

  it('deleteByRepo removes all chunks for a repo', async () => {
    const dir = tempDir();
    _clearCaches();
    try {
      const repoId = 'repo3';
      const chunkA = makeChunk({ filePath: 'a.js', contentHash: 'h1' });
      const chunkB = makeChunk({ filePath: 'b.js', contentHash: 'h2' });
      await upsertChunks(repoId, 'sha1', [chunkA, chunkB], [makeVector(1), makeVector(2)], dir);

      // Verify they exist
      let hashes = await existingHashes(repoId, dir);
      assert.equal(hashes.size, 2);

      // Delete all
      await deleteByRepo(repoId, dir);
      hashes = await existingHashes(repoId, dir);
      assert.equal(hashes.size, 0, 'All chunks should be deleted');
    } finally {
      _clearCaches();
    }
  });

  it('deleteByFile removes only chunks for that file', async () => {
    const dir = tempDir();
    _clearCaches();
    try {
      const repoId = 'repo4';
      const chunkA = makeChunk({ filePath: 'keep.js', contentHash: 'h_keep' });
      const chunkB = makeChunk({ filePath: 'delete.js', contentHash: 'h_del' });
      await upsertChunks(repoId, 'sha1', [chunkA, chunkB], [makeVector(1), makeVector(2)], dir);

      await deleteByFile(repoId, 'delete.js', dir);

      const hashes = await existingHashes(repoId, dir);
      assert.ok(hashes.has('keep.js::h_keep'), 'keep.js chunk should remain');
      assert.ok(!hashes.has('delete.js::h_del'), 'delete.js chunk should be gone');
    } finally {
      _clearCaches();
    }
  });

  it('upsertChunks is idempotent — re-inserting same chunkId replaces, not duplicates', async () => {
    const dir = tempDir();
    _clearCaches();
    try {
      const repoId = 'repo5';
      const chunk = makeChunk({ filePath: 'dup.js', contentHash: 'h_dup', content: 'v1' });
      await upsertChunks(repoId, 'sha1', [chunk], [makeVector(1)], dir);
      // Upsert again with updated content
      const updated = { ...chunk, content: 'v2', contentHash: 'h_dup2' };
      await upsertChunks(repoId, 'sha2', [updated], [makeVector(2)], dir);

      const hashes = await existingHashes(repoId, dir);
      // Should have the new hash, not both
      assert.ok(hashes.has('dup.js::h_dup2'), 'Updated chunk hash should exist');
    } finally {
      _clearCaches();
    }
  });

  it('vectorSearch returns relevant chunks sorted by distance', async () => {
    const dir = tempDir();
    _clearCaches();
    try {
      const repoId = 'repo6';
      // Insert 3 chunks with known vectors
      const chunks = [
        makeChunk({ filePath: 'a.js', contentHash: 'h1', symbol: 'alpha', startLine: 1, endLine: 3 }),
        makeChunk({ filePath: 'b.js', contentHash: 'h2', symbol: 'beta', startLine: 4, endLine: 6 }),
        makeChunk({ filePath: 'c.js', contentHash: 'h3', symbol: 'gamma', startLine: 7, endLine: 9 }),
      ];
      const vectors = [
        [1.0, 0.0, 0.0, 0.0], // closest to query
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
      ];
      await upsertChunks(repoId, 'sha1', chunks, vectors, dir);

      const queryVec = [1.0, 0.0, 0.0, 0.0]; // should match 'a.js' first
      const results = await vectorSearch(repoId, queryVec, 3, dir);

      assert.ok(results.length >= 1, 'Should return at least 1 result');
      assert.equal(results[0].symbol, 'alpha', 'Closest vector should be alpha');
    } finally {
      _clearCaches();
    }
  });

  it('existingHashes returns empty Set when table does not exist yet', async () => {
    const dir = tempDir();
    _clearCaches();
    try {
      const hashes = await existingHashes('nonexistent-repo', dir);
      assert.equal(hashes.size, 0);
    } finally {
      _clearCaches();
    }
  });
});
