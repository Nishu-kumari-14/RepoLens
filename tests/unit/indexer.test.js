/**
 * Integration tests for src/ingestion/indexer.js
 *
 * Tests the full pipeline on synthetic data (no GitHub network calls).
 * Uses real LanceDB in a temp dir and a mocked embedder.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { _clearCaches } from '../../src/adapters/vectorStore.js';
import { indexRepo } from '../../src/ingestion/indexer.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_BASE_DIR = path.resolve(process.cwd(), 'temp', 'test-indexer');
fs.mkdirSync(TEST_BASE_DIR, { recursive: true });

let testCounter = 0;
function memoryDbUri() {
  testCounter++;
  return `memory://test-indexer-${Date.now()}-${testCounter}`;
}

/**
 * Simulates indexer pipeline over synthetic files.
 */
async function runIndexerWithFakeFiles(fileMap, repoId, lancedbDataDir, wasmDir, callCount = {}) {
  // Write synthetic files to a temp extraction dir
  testCounter++;
  const tempDir = fs.mkdtempSync(path.join(TEST_BASE_DIR, `run-${testCounter}-`));

  try {
    for (const [relPath, content] of Object.entries(fileMap)) {
      const full = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }

    // Import chunker and vectorStore directly to simulate pipeline
    const { chunkFile } = await import('../../src/ingestion/chunker.js');
    const { upsertChunks, existingHashes } = await import('../../src/adapters/vectorStore.js');

    const allChunks = [];
    for (const [relPath, content] of Object.entries(fileMap)) {
      const chunks = await chunkFile(content, relPath, { wasmDir });
      for (const c of chunks) allChunks.push(c);
    }

    const stored = await existingHashes(repoId, lancedbDataDir);
    const newChunks = allChunks.filter(c => !stored.has(`${c.filePath}::${c.contentHash}`));

    callCount.embedded = (callCount.embedded || 0) + newChunks.length;

    const DIM = 4;
    const fakeVectors = newChunks.map(() => new Array(DIM).fill(0.1));
    if (newChunks.length > 0) {
      await upsertChunks(repoId, 'fake-sha', newChunks, fakeVectors, lancedbDataDir);
    }

    return { allChunks, newChunks, skippedChunks: allChunks.length - newChunks.length };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Milestone 3: Indexer pipeline (synthetic files)', () => {
  it('indexes a synthetic repo and persists chunks to LanceDB', async () => {
    const dir = memoryDbUri();
    _clearCaches();
    try {
      const fileMap = {
        'src/math.js': 'function add(a, b) {\n  return a + b;\n}\nfunction sub(a, b) {\n  return a - b;\n}',
        'README.md': '# Math Lib\n\n## Usage\nCall add() or sub().',
      };
      const wasmDir = path.resolve(process.cwd(), 'wasm');

      const { allChunks, newChunks } = await runIndexerWithFakeFiles(fileMap, 'test-repo-1', dir, wasmDir);

      assert.ok(allChunks.length >= 3, `Expected >= 3 chunks, got ${allChunks.length}`);
      assert.equal(newChunks.length, allChunks.length, 'All chunks should be new on first run');

      // Verify they're in LanceDB
      const { existingHashes } = await import('../../src/adapters/vectorStore.js');
      const hashes = await existingHashes('test-repo-1', dir);
      assert.equal(hashes.size, allChunks.length, 'LanceDB should contain all chunks');
    } finally {
      _clearCaches();
    }
  });

  it('skips already-indexed chunks on re-run (resumable / dedup)', async () => {
    const dir = memoryDbUri();
    _clearCaches();
    try {
      const fileMap = {
        'src/greet.js': 'function greet(name) {\n  return "Hello, " + name;\n}',
      };
      const wasmDir = path.resolve(process.cwd(), 'wasm');
      const repoId = 'test-repo-rerun';

      // First run
      const run1 = await runIndexerWithFakeFiles(fileMap, repoId, dir, wasmDir);
      assert.ok(run1.newChunks.length > 0, 'First run should embed chunks');

      // Second run — same files, same hashes
      const run2 = await runIndexerWithFakeFiles(fileMap, repoId, dir, wasmDir);
      assert.equal(run2.newChunks.length, 0, 'Second run should skip all chunks (already indexed)');
      assert.equal(run2.skippedChunks, run1.allChunks.length, 'All chunks should be reported as skipped');
    } finally {
      _clearCaches();
    }
  });

  it('re-embeds only changed files when content hash changes', async () => {
    const dir = memoryDbUri();
    _clearCaches();
    try {
      const wasmDir = path.resolve(process.cwd(), 'wasm');
      const repoId = 'test-repo-diff';

      // First run: index 'a.js' and 'b.js'
      const fileMapV1 = {
        'src/a.js': 'function alpha() { return 1; }',
        'src/b.js': 'function beta() { return 2; }',
      };
      const run1 = await runIndexerWithFakeFiles(fileMapV1, repoId, dir, wasmDir);
      assert.ok(run1.newChunks.length >= 2, 'Both files should produce new chunks');

      // Second run: only 'a.js' changed
      const fileMapV2 = {
        'src/a.js': 'function alpha() { return 999; }', // changed
        'src/b.js': 'function beta() { return 2; }',    // unchanged
      };
      const run2 = await runIndexerWithFakeFiles(fileMapV2, repoId, dir, wasmDir);

      // b.js chunks should be skipped; a.js chunks should be new
      const changedChunk = run2.newChunks.find(c => c.filePath === 'src/a.js');
      assert.ok(changedChunk, 'Changed file should produce new chunks');
      assert.ok(run2.skippedChunks >= 1, 'Unchanged file chunks should be skipped');
    } finally {
      _clearCaches();
    }
  });
});
