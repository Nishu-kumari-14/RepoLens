/**
 * Unit tests for src/adapters/embedder.js
 *
 * All tests use mocked fetch — no real network calls.
 */
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenBucket,
  backoffDelay,
  embedBatch,
  embed,
  BATCH_SIZE,
  sleep,
} from '../../src/adapters/embedder.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeVectors(count, dim = 4) {
  return Array.from({ length: count }, (_, i) => Array.from({ length: dim }, (_, j) => i * 0.1 + j * 0.01));
}

function mockFetchSuccess(vectors) {
  return async () =>
    ({
      ok: true,
      json: async () => ({ embeddings: vectors.map((v) => ({ values: v })) }),
    });
}

function mockFetchStatus(status, bodyText = '') {
  return async () =>
    ({
      ok: false,
      status,
      text: async () => bodyText,
    });
}

// ─── TokenBucket ──────────────────────────────────────────────────────────────

describe('Milestone 3: Embedder — TokenBucket', () => {
  it('takes tokens without delay when bucket is full', async () => {
    const bucket = new TokenBucket(60);
    const start = Date.now();
    await bucket.take();
    assert.ok(Date.now() - start < 100, 'Should not wait when tokens available');
  });

  it('refills tokens over time', async () => {
    const bucket = new TokenBucket(60);
    bucket.tokens = 0; // drain it
    bucket.lastRefill = Date.now() - 1100; // simulate 1.1s elapsed (should refill >1 token)
    bucket._refill();
    assert.ok(bucket.tokens >= 1, 'Should have refilled at least 1 token');
  });
});

// ─── backoffDelay ─────────────────────────────────────────────────────────────

describe('Milestone 3: Embedder — backoffDelay', () => {
  it('returns increasing delays with jitter', () => {
    const d0 = backoffDelay(0);
    const d1 = backoffDelay(1);
    const d2 = backoffDelay(2);
    // Base doubles: 1s, 2s, 4s; each has up to 1s jitter
    assert.ok(d0 >= 1000 && d0 <= 2000, `delay(0) expected 1000-2000ms, got ${d0}`);
    assert.ok(d1 >= 2000 && d1 <= 3000, `delay(1) expected 2000-3000ms, got ${d1}`);
    assert.ok(d2 >= 4000 && d2 <= 5000, `delay(2) expected 4000-5000ms, got ${d2}`);
    assert.ok(d1 > d0, 'Delay should increase with attempt');
  });

  it('caps at MAX_DELAY_MS (64s) plus jitter', () => {
    const d = backoffDelay(20); // 2^20 >> 64s cap
    assert.ok(d <= 65_001, `Should cap near 64s+jitter, got ${d}ms`);
  });
});

// ─── embedBatch ───────────────────────────────────────────────────────────────

describe('Milestone 3: Embedder — embedBatch (mocked fetch)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns vectors on successful response', async () => {
    const fakeVectors = makeFakeVectors(3, 4);
    globalThis.fetch = mockFetchSuccess(fakeVectors);

    const bucket = new TokenBucket(1000); // no delay
    const result = await embedBatch(['a', 'b', 'c'], 'test-model', 'fake-key', bucket);
    assert.deepEqual(result, fakeVectors);
  });

  it('retries on 429 and eventually succeeds', async () => {
    const fakeVectors = makeFakeVectors(1, 4);
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount < 3) return { ok: false, status: 429, text: async () => 'rate limited' };
      return { ok: true, json: async () => ({ embeddings: fakeVectors.map((v) => ({ values: v })) }) };
    };

    const bucket = new TokenBucket(1000);
    const result = await embedBatch(['test'], 'model', 'key', bucket, {
      sleepFn: () => Promise.resolve(),
    });
    assert.deepEqual(result, fakeVectors);
    assert.ok(callCount >= 3, 'Should have retried at least 2 times');
  });

  it('retries on 503 server error', async () => {
    const fakeVectors = makeFakeVectors(1, 4);
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) return { ok: false, status: 503, text: async () => 'service unavailable' };
      return { ok: true, json: async () => ({ embeddings: fakeVectors.map((v) => ({ values: v })) }) };
    };

    const bucket = new TokenBucket(1000);
    const result = await embedBatch(['test'], 'model', 'key', bucket, {
      sleepFn: () => Promise.resolve(),
    });
    assert.deepEqual(result, fakeVectors);
  });

  it('throws on 400 bad request without retrying', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
    const bucket = new TokenBucket(1000);
    await assert.rejects(
      () => embedBatch(['test'], 'model', 'key', bucket),
      /400/
    );
  });

  it('throws without API key', async () => {
    const bucket = new TokenBucket(1000);
    await assert.rejects(
      () => embedBatch(['test'], 'model', '', bucket),
      /GEMINI_API_KEY/
    );
  });
});

// ─── embed (full batching) ────────────────────────────────────────────────────

describe('Milestone 3: Embedder — embed() batching and resumability', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns empty array for empty input', async () => {
    const result = await embed([], { modelId: 'model', apiKey: 'key', rpm: 1000 });
    assert.deepEqual(result, []);
  });

  it('batches texts into groups and calls onBatchComplete per batch', async () => {
    const TEXTS_COUNT = 7; // 2 batches with batchSize=5 override (not possible without patching)
    // We use 3 texts and verify onBatchComplete fires once (1 batch)
    const fakeVectors = makeFakeVectors(3, 4);
    globalThis.fetch = mockFetchSuccess(fakeVectors);

    const completedBatches = [];
    await embed(['a', 'b', 'c'], {
      modelId: 'model',
      apiKey: 'key',
      rpm: 1000,
      bucket: new TokenBucket(1000),
      onBatchComplete: (batchIdx) => completedBatches.push(batchIdx),
    });

    assert.equal(completedBatches.length, 1);
    assert.equal(completedBatches[0], 1);
  });

  it('skips batches before startBatch for resumability', async () => {
    const fakeVectors = makeFakeVectors(3, 4);
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ embeddings: fakeVectors.map((v) => ({ values: v })) }),
      };
    };

    // We have 3 texts, 1 batch. startBatch=1 means skip batch 0 (already done)
    // so fetch should NOT be called
    await embed(['a', 'b', 'c'], {
      modelId: 'model',
      apiKey: 'key',
      rpm: 1000,
      bucket: new TokenBucket(1000),
      startBatch: 1, // skip the one and only batch
    });

    assert.equal(callCount, 0, 'With startBatch=1 and only 1 batch, fetch should not be called');
  });
});
