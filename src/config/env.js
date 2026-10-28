import fs from 'node:fs';
import path from 'node:path';

// Attempt to load .env using Node's native process.loadEnvFile or fail silently if file does not exist
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

// Parse integer with default
function parseNumber(val, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : defaultVal;
}

/**
 * Validates and returns the application configuration object.
 * Strictly verifies that model IDs and dimensions are supplied by environment variables.
 *
 * @param {Record<string, string | undefined>} envSource
 * @returns {object} Validated config object
 */
export function validateConfig(envSource = process.env) {
  const errors = [];

  const embeddingModelId = envSource.EMBEDDING_MODEL_ID?.trim();
  if (!embeddingModelId) {
    errors.push('EMBEDDING_MODEL_ID is required and must not be empty (set via .env)');
  }

  const rawEmbeddingDim = envSource.EMBEDDING_DIMENSION?.trim();
  const embeddingDimension = rawEmbeddingDim ? Number(rawEmbeddingDim) : NaN;
  if (!Number.isInteger(embeddingDimension) || embeddingDimension <= 0) {
    errors.push('EMBEDDING_DIMENSION must be a positive integer (set via .env)');
  }

  const llmModelId = envSource.LLM_MODEL_ID?.trim();
  if (!llmModelId) {
    errors.push('LLM_MODEL_ID is required and must not be empty (set via .env)');
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
      dimension: embeddingDimension,
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

export const config = (() => {
  try {
    return validateConfig(process.env);
  } catch (err) {
    // If not in test environment or missing env, export a function/lazy proxy or rethrow
    if (process.env.NODE_ENV === 'test') {
      // In test runner, environment might be injected dynamically by test suite
      return null;
    }
    throw err;
  }
})();
