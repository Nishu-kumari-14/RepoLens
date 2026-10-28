import path from 'node:path';
import {
  EXCLUDED_DIRECTORIES,
  EXCLUDED_FILE_PATTERNS,
  INGESTION_LIMITS,
} from '../config/constants.js';

export const ALLOWED_EXTENSIONS = new Set([
  // JavaScript & TypeScript
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  // Python
  '.py',
  '.pyw',
  // JVM
  '.java',
  '.kt',
  '.kts',
  '.scala',
  // Systems languages
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.rs',
  '.go',
  // Other popular languages
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  // Web & formats
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  // Documentation
  '.md',
  '.markdown',
  '.rst',
  '.txt',
]);

export const ALLOWED_FILENAMES = new Set([
  'readme',
  'dockerfile',
  'containerfile',
  'makefile',
  'procfile',
  'cmakelists.txt',
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'requirements.txt',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'gemfile',
]);

const LINT_FORMATTER_PATTERNS = [
  /^\.eslintrc.*$/i,
  /^\.prettierrc.*$/i,
  /^\.editorconfig$/i,
  /^eslint\.config\..*$/i,
  /^prettier\.config\..*$/i,
];

const LICENSE_PATTERNS = [
  /^licen[sc]e(?:\..+)?$/i,
  /^copying(?:\..+)?$/i,
];

const LOCKFILE_PATTERNS = [
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /cargo\.lock$/i,
  /poetry\.lock$/i,
  /composer\.lock$/i,
  /gemfile\.lock$/i,
  /flake\.lock$/i,
];

/**
 * Evaluates whether a file should be included in indexing.
 *
 * @param {{ relativePath: string, sizeBytes?: number }} file
 * @param {object} [options]
 * @param {number} [options.maxFileSizeKb]
 * @returns {{ included: boolean, reason?: string }}
 */
export function filterFile(file, options = {}) {
  const relativePath = (file.relativePath || file.path || '').replace(/\\/g, '/');
  const basename = path.basename(relativePath);
  const ext = path.extname(basename).toLowerCase();
  const maxBytes =
    (options.maxFileSizeKb ?? INGESTION_LIMITS.DEFAULT_MAX_FILE_SIZE_KB) * 1024;

  // 1. Check directory path segments against excluded directories
  const segments = relativePath.split('/');
  segments.pop(); // Remove the filename segment

  for (const segment of segments) {
    if (EXCLUDED_DIRECTORIES.has(segment.toLowerCase())) {
      return { included: false, reason: `excluded_directory: ${segment}` };
    }
    if (segment.startsWith('.') && segment !== '.') {
      return { included: false, reason: `hidden_directory: ${segment}` };
    }
  }

  // 2. Check license files (skip entirely)
  for (const pattern of LICENSE_PATTERNS) {
    if (pattern.test(basename)) {
      return { included: false, reason: 'license_file' };
    }
  }

  // 3. Check linter and formatter config files
  for (const pattern of LINT_FORMATTER_PATTERNS) {
    if (pattern.test(basename)) {
      return { included: false, reason: 'linter_or_formatter_config' };
    }
  }

  // 2. Check lockfiles
  for (const pattern of LOCKFILE_PATTERNS) {
    if (pattern.test(basename)) {
      return { included: false, reason: 'lockfile' };
    }
  }

  // 3. Check minified & source maps
  if (/\.min\.(js|css)$/i.test(basename) || /\.map$/i.test(basename)) {
    return { included: false, reason: 'minified_or_sourcemap' };
  }

  // 4. Check excluded file patterns (binaries, archives, media)
  for (const pattern of EXCLUDED_FILE_PATTERNS) {
    if (pattern.test(basename)) {
      return { included: false, reason: 'binary_or_media' };
    }
  }

  // 5. Check file size if available
  if (typeof file.sizeBytes === 'number' && file.sizeBytes > maxBytes) {
    return {
      included: false,
      reason: `exceeds_size_limit (${Math.round(file.sizeBytes / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`,
    };
  }

  // 6. Check extension allowlist or recognized filename
  const isAllowedExt = ALLOWED_EXTENSIONS.has(ext);
  const isAllowedName = ALLOWED_FILENAMES.has(basename.toLowerCase());

  if (!isAllowedExt && !isAllowedName) {
    return { included: false, reason: `unsupported_extension: ${ext || 'none'}` };
  }

  return { included: true };
}

/**
 * Categorizes a list of files into included and skipped groups.
 *
 * @param {Array<{ relativePath: string, sizeBytes?: number, fullPath?: string }>} files
 * @param {object} [options]
 * @returns {{ included: Array<any>, skipped: Array<{ file: any, reason: string }>, groupedReasons: Record<string, number> }}
 */
export function filterFiles(files, options = {}) {
  const included = [];
  const skipped = [];
  const groupedReasons = {};

  for (const file of files) {
    const result = filterFile(file, options);
    if (result.included) {
      included.push(file);
    } else {
      skipped.push({ file, reason: result.reason });
      const rawCategory = result.reason.split(' ')[0] || 'other';
      const cleanCategory = rawCategory.replace(/:$/, '');
      groupedReasons[cleanCategory] = (groupedReasons[cleanCategory] || 0) + 1;
    }
  }

  return { included, skipped, groupedReasons };
}
