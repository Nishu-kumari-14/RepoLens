import fs from 'node:fs';
import path from 'node:path';

export function initEnvFile(envPath = path.resolve(process.cwd(), '.env')) {
  if (fs.existsSync(envPath)) {
    if (typeof process.loadEnvFile === 'function') {
      try {
        process.loadEnvFile(envPath);
      } catch {
        // Ignored if already loaded or partially parsed
      }
    }
  }
}

function parseNumber(val, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : defaultVal;
}

/**
 * Validates and returns application configuration.
 * When requireCredentials is false (e.g. for CLI dry runs or testing),
 * missing model IDs or API keys will not throw an error.
 *
 * @param {Record<string, string | undefined>} envSource
 * @param {object} [options]
 * @param {boolean} [options.requireCredentials=false]
 * @returns {object} Validated config object
 */
export function validateConfig(envSource = process.env, { requireCredentials = false } = {}) {
  const errors = [];

  const embeddingModelId = envSource.EMBEDDING_MODEL_ID?.trim() || '';
  const rawEmbeddingDim = envSource.EMBEDDING_DIMENSION?.trim();
  const embeddingDimension = rawEmbeddingDim ? Number(rawEmbeddingDim) : NaN;
  const llmModelId = envSource.LLM_MODEL_ID?.trim() || '';

  if (requireCredentials) {
    if (!embeddingModelId) {
      errors.push('EMBEDDING_MODEL_ID is required and must not be empty (set via .env)');
    }
    if (!Number.isInteger(embeddingDimension) || embeddingDimension <= 0) {
      errors.push('EMBEDDING_DIMENSION must be a positive integer (set via .env)');
    }
    if (!llmModelId) {
      errors.push('LLM_MODEL_ID is required and must not be empty (set via .env)');
    }
  } else {
    // If provided even in non-strict mode, ensure dimension is valid if present
    if (rawEmbeddingDim && (!Number.isInteger(embeddingDimension) || embeddingDimension <= 0)) {
      errors.push('EMBEDDING_DIMENSION must be a positive integer (set via .env)');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration Validation Error:\n - ${errors.join('\n - ')}`);
  }

  return Object.freeze({
    port: parseNumber(envSource.PORT, 3000),
    nodeEnv: envSource.NODE_ENV || 'development',
    mongoUri: envSource.MONGODB_URI || 'mongodb://localhost:27017/repolens',
    embedding: {
      provider: envSource.EMBEDDING_PROVIDER || 'gemini',
      modelId: embeddingModelId,
      dimension: Number.isInteger(embeddingDimension) ? embeddingDimension : 768,
    },
    llm: {
      provider: envSource.LLM_PROVIDER || 'gemini',
      modelId: llmModelId,
    },
    keys: {
      geminiApiKey: envSource.GEMINI_API_KEY || '',
      githubToken: envSource.GITHUB_TOKEN || '',
    },
    paths: {
      lancedbDataDir: envSource.LANCEDB_DATA_DIR || './data/lancedb',
      tempDir: envSource.TEMP_DIR || './temp',
      wasmDir: envSource.WASM_DIR || './wasm',
    },
    limits: {
      maxArchiveSizeMb: parseNumber(envSource.MAX_ARCHIVE_SIZE_MB, 50),
      maxFileCount: parseNumber(envSource.MAX_FILE_COUNT, 1000),
      maxFileSizeKb: parseNumber(envSource.MAX_FILE_SIZE_KB, 200),
      rateLimitRpm: parseNumber(envSource.RATE_LIMIT_RPM, 60),
    },
  });
}

// Automatically load local .env on import
initEnvFile();

export const config = validateConfig(process.env, { requireCredentials: false });
