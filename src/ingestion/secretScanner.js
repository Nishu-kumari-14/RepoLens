import fs from 'node:fs';
import path from 'node:path';
import { SECRET_FILE_PATTERNS } from '../config/constants.js';

export const SECRET_RULES = [
  {
    name: 'Private Key Header',
    pattern: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/,
  },
  {
    name: 'AWS Access Key ID',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'GitHub Token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}\b|\bgithub_pat_[a-zA-Z0-9_]{22,}\b/,
  },
  {
    name: 'Generic API Key / Secret Token',
    pattern: /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*["'][a-zA-Z0-9_\-]{16,}["']/i,
  },
  {
    name: 'JWT (JSON Web Token)',
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
  },
  {
    name: 'Hardcoded Password Assignment',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
];

/**
 * Scans a file for potential secrets, private keys, or credentials.
 * SECURITY: NEVER returns or prints the matched secret content.
 *
 * @param {{ relativePath: string, content?: string, fullPath?: string }} file
 * @returns {{ hasSecret: boolean, reason?: string }}
 */
export function scanFile(file) {
  const basename = path.basename(file.relativePath);

  // 1. Filename-based checks
  for (const pattern of SECRET_FILE_PATTERNS) {
    if (pattern.test(basename)) {
      return {
        hasSecret: true,
        reason: `secret_filename: matches pattern ${pattern.toString()}`,
      };
    }
  }

  // 2. Content-based checks
  let content = file.content;
  if (content === undefined && file.fullPath) {
    try {
      content = fs.readFileSync(file.fullPath, 'utf8');
    } catch {
      // If unreadable, do not treat as secret (fileFilter handles binary/encoding issues)
      return { hasSecret: false };
    }
  }

  if (typeof content === 'string' && content.length > 0) {
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(content)) {
        return {
          hasSecret: true,
          reason: `secret_content: detected ${rule.name}`,
        };
      }
    }
  }

  return { hasSecret: false };
}

/**
 * Scans an array of files, returning safe files and files flagged for secrets.
 *
 * @param {Array<{ relativePath: string, content?: string, fullPath?: string }>} files
 * @returns {{ clean: Array<any>, flagged: Array<{ file: any, reason: string }> }}
 */
export function scanFiles(files) {
  const clean = [];
  const flagged = [];

  for (const file of files) {
    const result = scanFile(file);
    if (result.hasSecret) {
      flagged.push({ file, reason: result.reason });
    } else {
      clean.push(file);
    }
  }

  return { clean, flagged };
}
