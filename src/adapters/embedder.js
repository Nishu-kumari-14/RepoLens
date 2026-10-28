/**
 * Gemini embedding adapter.
 *
 * Interface: embed(texts: string[]) -> number[][]
 *
 * Features:
 *  - Batches input into groups of BATCH_SIZE (default 50)
 *  - Token-bucket rate cap: respects RATE_LIMIT_RPM from env
 *  - Exponential backoff with jitter on 429 / 5xx responses
 *  - Resumable: caller passes batchOffset; embed() starts from that batch
 *    and calls onBatchComplete(newOffset) after each successful batch
 */
import { config } from '../config/env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const BATCH_SIZE = 50;
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1_000; // 1 s before first retry
const MAX_DELAY_MS = 64_000; // cap at 64 s

const GEMINI_EMBED_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── Token bucket (RPM enforcer) ─────────────────────────────────────────────

export class TokenBucket {
  /**
   * @param {number} rpm  Max requests per minute
   */
  constructor(rpm) {
    this.rpm = rpm;
    this.tokens = rpm;
    this.lastRefill = Date.now();
    this._intervalMs = 60_000 / rpm; // ms between tokens
  }

  async take() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait until next token
    const wait = this._intervalMs - (Date.now() - this.lastRefill);
    if (wait > 0) await sleep(wait);
    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = (elapsed / 60_000) * this.rpm;
    this.tokens = Math.min(this.rpm, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Jittered exponential backoff delay for attempt N (0-indexed).
 * delay = min(BASE * 2^attempt, MAX) + random jitter up to 1s
 */
export function backoffDelay(attempt) {
  const exp = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = Math.random() * 1_000;
  return exp + jitter;
}

// ─── Core API call ───────────────────────────────────────────────────────────

/**
 * Calls the Gemini embedContent (batch) endpoint for one batch of texts.
 * Returns an array of float32 vectors, one per input text.
 *
 * @param {string[]} texts
 * @param {string} modelId
 * @param {string} apiKey
 * @param {TokenBucket} bucket
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts, modelId, apiKey, bucket, opts = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Cannot embed.');

  const sleepFn = opts.sleepFn || sleep;
  const backoffFn = opts.backoffDelayFn || backoffDelay;

  const url = `${GEMINI_EMBED_BASE}/${modelId}:batchEmbedContents?key=${apiKey}`;
  const dimension = config.embedding.dimension;
  const body = JSON.stringify({
    requests: texts.map((text) => {
      const req = {
        model: `models/${modelId}`,
        content: { parts: [{ text }] },
      };
      if (dimension) {
        req.outputDimensionality = dimension;
      }
      return req;
    }),
  });

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await bucket.take();

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (networkErr) {
      lastErr = networkErr;
      const delay = backoffFn(attempt);
      console.warn(`[embedder] Network error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${networkErr.message}. Retrying in ${Math.round(delay)}ms...`);
      await sleepFn(delay);
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      // Gemini batchEmbedContents response shape:
      // { embeddings: [ { values: [float, ...] }, ... ] }
      if (!data.embeddings || !Array.isArray(data.embeddings)) {
        throw new Error(`Unexpected Gemini embed response shape: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return data.embeddings.map((e) => e.values);
    }

    // 429 or 5xx → retry with backoff
    const shouldRetry = res.status === 429 || res.status >= 500;
    if (!shouldRetry || attempt === MAX_RETRIES) {
      let body = '';
      try { body = await res.text(); } catch { /**/ }
      throw new Error(`Gemini embed API returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const delay = backoffFn(attempt);
    console.warn(`[embedder] HTTP ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Retrying in ${Math.round(delay)}ms...`);
    await sleepFn(delay);
    lastErr = new Error(`HTTP ${res.status}`);
  }

  throw lastErr || new Error('Embedding failed after max retries');
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Embeds an array of texts in batches.
 *
 * @param {string[]} texts
 * @param {object} [opts]
 * @param {number}   [opts.startBatch=0]        Skip this many leading batches (resume support)
 * @param {Function} [opts.onBatchComplete]      Called with (batchIndex, vectors) after each batch
 * @param {string}   [opts.modelId]              Override model from env
 * @param {string}   [opts.apiKey]               Override API key from env
 * @param {number}   [opts.rpm]                  Override RPM cap from env
 * @param {TokenBucket} [opts.bucket]            Inject pre-built bucket (for testing)
 * @returns {Promise<number[][]>}  All vectors in the same order as texts
 */
export async function embed(texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const modelId = opts.modelId || config.embedding.modelId;
  const apiKey = opts.apiKey || config.keys.geminiApiKey;
  const rpm = opts.rpm || config.limits.rateLimitRpm || 60;
  const startBatch = opts.startBatch || 0;
  const bucket = opts.bucket || new TokenBucket(rpm);

  if (!modelId) throw new Error('EMBEDDING_MODEL_ID is not configured.');

  // Split into batches
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const allVectors = new Array(texts.length);

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    // Skip already-completed batches (resume support)
    if (batchIdx < startBatch) {
      // Fill with nulls; caller already has these from a prior run
      const batchStart = batchIdx * BATCH_SIZE;
      for (let j = 0; j < batches[batchIdx].length; j++) {
        allVectors[batchStart + j] = null;
      }
      continue;
    }

    const batch = batches[batchIdx];
    const vectors = await embedBatch(batch, modelId, apiKey, bucket, opts);

    const batchStart = batchIdx * BATCH_SIZE;
    for (let j = 0; j < vectors.length; j++) {
      allVectors[batchStart + j] = vectors[j];
    }

    if (opts.onBatchComplete) {
      await opts.onBatchComplete(batchIdx + 1, vectors);
    }
  }

  return allVectors;
}
