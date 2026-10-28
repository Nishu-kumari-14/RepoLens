/**
 * Central system constants, defaults, and security patterns.
 * Model IDs are strictly excluded here and loaded via src/config/env.js.
 */

export const INGESTION_LIMITS = {
  DEFAULT_MAX_ARCHIVE_SIZE_MB: 50,
  DEFAULT_MAX_FILE_COUNT: 1000,
  DEFAULT_MAX_FILE_SIZE_KB: 200,
  CHUNK_MAX_CHARACTERS: 1500,
  CHUNK_MAX_LINES: 80,
  FALLBACK_WINDOW_LINES: 60,
  FALLBACK_OVERLAP_LINES: 10,
};

export const RETRIEVAL_DEFAULTS = {
  VECTOR_TOP_K: 20,
  BM25_TOP_K: 20,
  RRF_K: 60,
  FINAL_TOP_K: 8,
};

export const REPOSITORY_STATUS = {
  QUEUED: 'queued',
  FETCHING: 'fetching',
  PROCESSING: 'processing',
  INDEXING: 'indexing',
  READY: 'ready',
  FAILED: 'failed',
};

export const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.github',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'out',
  'vendor',
  'target',
  'bin',
  'obj',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  'env',
]);

export const EXCLUDED_FILE_PATTERNS = [
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /\.lock$/i,
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /poetry\.lock$/i,
  /Cargo\.lock$/i,
  /^\.eslintrc.*$/i,
  /^\.prettierrc.*$/i,
  /^\.editorconfig$/i,
  /^licen[sc]e(?:\..+)?$/i,
  /\.(png|jpg|jpeg|gif|ico|svg|webp|bmp|tiff|pdf|zip|tar|gz|7z|exe|dll|so|dylib|bin|wasm)$/i,
];

export const SECRET_FILE_PATTERNS = [
  /(?:^|\.)env(?:\..+)?$/i,
  /\.(pem|key|crt|p12|pfx)$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
];

export const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/, // AWS Access Key
  /(api_key|apikey|secret|password|passwd|token)\s*[:=]\s*["'][a-zA-Z0-9_\-]{16,}["']/i,
  /ghp_[a-zA-Z0-9]{36}/, // GitHub personal access token
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, // JWT format
];
