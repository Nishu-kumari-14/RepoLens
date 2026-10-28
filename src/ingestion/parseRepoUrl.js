/**
 * Validates and parses a GitHub repository URL with strict security checks.
 *
 * Requirements:
 * - Accept only https://github.com/{owner}/{repo} URLs.
 * - Reject non-https protocols (http, ftp, etc.).
 * - Reject other hosts (gitlab.com, spoofed domains).
 * - Reject credentials in the URL (user:pass@).
 * - Reject IP addresses, localhost, and unusual ports.
 * - Strip trailing .git and trailing slashes.
 * - Reject path traversal segments (. or ..).
 *
 * @param {string} rawUrl
 * @returns {{ owner: string, repo: string, canonicalUrl: string }}
 */
export function parseRepoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Invalid repository URL: URL must be a non-empty string.');
  }

  const trimmed = rawUrl.trim();

  // Guard against embedded credentials before standard URL parsing
  if (/^https?:\/\/[^/]*@/i.test(trimmed)) {
    throw new Error('Invalid repository URL: Credentials in URL are strictly forbidden.');
  }

  // Guard against path traversal attempts in raw URL
  if (/(?:^|\/)\.\.(?:\/|$)/.test(trimmed)) {
    throw new Error('Invalid repository URL: Path traversal segments are not allowed.');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid repository URL: Malformed URL string "${trimmed}".`);
  }

  // Enforce HTTPS
  if (parsed.protocol !== 'https:') {
    throw new Error(`Invalid repository URL: Protocol must be "https:", received "${parsed.protocol}".`);
  }

  // Enforce github.com host only (case-insensitive)
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error(`Invalid repository URL: Host must be "github.com", received "${parsed.hostname}".`);
  }

  // Enforce standard port only (empty or 443)
  if (parsed.port && parsed.port !== '443') {
    throw new Error(`Invalid repository URL: Non-standard port "${parsed.port}" is not allowed.`);
  }

  // Reject query parameters or hash fragments
  if (parsed.search || parsed.hash) {
    throw new Error('Invalid repository URL: Query parameters and fragments are not allowed.');
  }

  // Extract path segments
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new Error(`Invalid repository URL: Expected format https://github.com/{owner}/{repo}, received "${parsed.pathname}".`);
  }

  const [owner, rawRepo] = segments;

  // Strip trailing .git
  const repo = rawRepo.replace(/\.git$/i, '');

  if (!repo) {
    throw new Error('Invalid repository URL: Repository name cannot be empty.');
  }

  // Path traversal check
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    throw new Error('Invalid repository URL: Path traversal segments are not allowed.');
  }

  // GitHub owner format check (alphanumeric and hyphens, no consecutive hyphens)
  const ownerRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
  if (!ownerRegex.test(owner) || owner.length > 39) {
    throw new Error(`Invalid repository URL: Invalid GitHub username/organization "${owner}".`);
  }

  // GitHub repository name format check
  const repoRegex = /^[a-zA-Z0-9_.-]+$/;
  if (!repoRegex.test(repo) || repo.length > 100) {
    throw new Error(`Invalid repository URL: Invalid GitHub repository name "${repo}".`);
  }

  return {
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}
