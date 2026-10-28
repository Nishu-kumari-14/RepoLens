import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../src/config/env.js';
import {
  INGESTION_LIMITS,
  RETRIEVAL_DEFAULTS,
  SECRET_FILE_PATTERNS,
  SECRET_CONTENT_PATTERNS,
  EXCLUDED_DIRECTORIES,
} from '../../src/config/constants.js';

describe('Milestone 0: Configuration & Environment Validation', () => {
  const validEnv = {
    PORT: '8080',
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/test_db',
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL_ID: 'text-embedding-004',
    EMBEDDING_DIMENSION: '768',
    LLM_PROVIDER: 'gemini',
    LLM_MODEL_ID: 'gemini-1.5-flash',
    GEMINI_API_KEY: 'test-key',
    GITHUB_TOKEN: 'ghp_dummytoken123456789012345678901234',
    LANCEDB_DATA_DIR: './data/test_lancedb',
    TEMP_DIR: './temp/test',
    WASM_DIR: './wasm',
    MAX_ARCHIVE_SIZE_MB: '25',
    MAX_FILE_COUNT: '500',
    MAX_FILE_SIZE_KB: '100',
    RATE_LIMIT_RPM: '30',
  };

  it('validates and loads full configuration correctly', () => {
    const config = validateConfig(validEnv);

    assert.equal(config.port, 8080);
    assert.equal(config.nodeEnv, 'test');
    assert.equal(config.mongoUri, 'mongodb://localhost:27017/test_db');
    assert.equal(config.embedding.modelId, 'text-embedding-004');
    assert.equal(config.embedding.dimension, 768);
    assert.equal(config.llm.modelId, 'gemini-1.5-flash');
    assert.equal(config.limits.maxArchiveSizeMb, 25);
    assert.equal(config.limits.maxFileCount, 500);
    assert.equal(config.limits.maxFileSizeKb, 100);
    assert.equal(config.limits.rateLimitRpm, 30);
  });

  it('fails validation when EMBEDDING_MODEL_ID is missing', () => {
    const invalidEnv = { ...validEnv, EMBEDDING_MODEL_ID: '' };
    assert.throws(
      () => validateConfig(invalidEnv),
      /EMBEDDING_MODEL_ID is required/
    );
  });

  it('fails validation when EMBEDDING_DIMENSION is invalid or non-numeric', () => {
    const invalidEnv = { ...validEnv, EMBEDDING_DIMENSION: 'invalid' };
    assert.throws(
      () => validateConfig(invalidEnv),
      /EMBEDDING_DIMENSION must be a positive integer/
    );
  });

  it('fails validation when LLM_MODEL_ID is missing', () => {
    const invalidEnv = { ...validEnv, LLM_MODEL_ID: '  ' };
    assert.throws(
      () => validateConfig(invalidEnv),
      /LLM_MODEL_ID is required/
    );
  });

  it('verifies system constants and security patterns', () => {
    assert.ok(INGESTION_LIMITS.DEFAULT_MAX_ARCHIVE_SIZE_MB > 0);
    assert.equal(RETRIEVAL_DEFAULTS.RRF_K, 60);
    assert.ok(EXCLUDED_DIRECTORIES.has('node_modules'));
    assert.ok(EXCLUDED_DIRECTORIES.has('.git'));

    // Verify secret file patterns match .env and private keys
    assert.ok(SECRET_FILE_PATTERNS.some((pat) => pat.test('.env')));
    assert.ok(SECRET_FILE_PATTERNS.some((pat) => pat.test('.env.production')));
    assert.ok(SECRET_FILE_PATTERNS.some((pat) => pat.test('server.key')));

    // Verify secret content patterns match AWS keys and private key headers
    assert.ok(
      SECRET_CONTENT_PATTERNS.some((pat) =>
        pat.test('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')
      )
    );
    assert.ok(
      SECRET_CONTENT_PATTERNS.some((pat) =>
        pat.test('aws_access_key_id = AKIAIOSFODNN7EXAMPLE')
      )
    );
  });
});
