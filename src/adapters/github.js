import { INGESTION_LIMITS } from '../config/constants.js';

/**
 * Creates standard GitHub API headers.
 * SECURITY: Never logs or leaks token values.
 *
 * @param {string} [token]
 * @returns {Record<string, string>}
 */
function createHeaders(token) {
  const headers = {
    'User-Agent': 'RepoLens-Agent',
    Accept: 'application/vnd.github+json',
  };

  const cleanToken = token?.trim();
  if (cleanToken) {
    headers.Authorization = `Bearer ${cleanToken}`;
  }

  return headers;
}

/**
 * Handles error status codes from GitHub API calls safely.
 *
 * @param {Response} response
 * @param {string} owner
 * @param {string} repo
 */
async function handleApiError(response, owner, repo) {
  const status = response.status;
  const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');

  if (status === 403 || status === 429) {
    if (rateLimitRemaining === '0') {
      const resetTime = response.headers.get('x-ratelimit-reset');
      const resetDate = resetTime ? new Date(Number(resetTime) * 1000).toISOString() : 'soon';
      throw new Error(
        `GitHub API rate limit exceeded for "${owner}/${repo}". Reset at ${resetDate}. Set or verify GITHUB_TOKEN in .env to increase limits.`
      );
    }
    throw new Error(
      `Access forbidden (HTTP 403) for "${owner}/${repo}". The repository may be private or require authentication.`
    );
  }

  if (status === 404) {
    throw new Error(
      `Repository "${owner}/${repo}" was not found or is private (HTTP 404).`
    );
  }

  let errorDetail = '';
  try {
    const errorJson = await response.json();
    errorDetail = errorJson.message ? `: ${errorJson.message}` : '';
  } catch {
    // Non-JSON response
  }

  throw new Error(`GitHub API request failed with status ${status}${errorDetail}.`);
}

/**
 * Fetches the latest commit SHA for a repository's default branch.
 *
 * @param {{ owner: string, repo: string, token?: string }} params
 * @returns {Promise<string>} Latest commit SHA
 */
export async function getLatestCommit({ owner, repo, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`;
  const headers = createHeaders(token);

  const response = await fetch(url, { headers });

  if (!response.ok) {
    await handleApiError(response, owner, repo);
  }

  const commits = await response.json();
  if (!Array.isArray(commits) || commits.length === 0 || !commits[0].sha) {
    throw new Error(`No commits found for repository "${owner}/${repo}".`);
  }

  return commits[0].sha;
}

/**
 * Downloads the repository archive (zipball) as a Buffer with size capping.
 * Enforces maxArchiveSizeBytes while streaming the download even when Content-Length is missing.
 *
 * @param {{ owner: string, repo: string, commitSha?: string, token?: string, maxArchiveSizeBytes?: number }} params
 * @returns {Promise<Buffer>} ZIP archive buffer
 */
export async function downloadRepoArchive({
  owner,
  repo,
  commitSha = '',
  token,
  maxArchiveSizeBytes = INGESTION_LIMITS.DEFAULT_MAX_ARCHIVE_SIZE_MB * 1024 * 1024,
}) {
  const ref = commitSha ? `/${commitSha}` : '';
  const url = `https://api.github.com/repos/${owner}/${repo}/zipball${ref}`;
  const headers = createHeaders(token);

  const response = await fetch(url, {
    headers,
    redirect: 'follow',
  });

  if (!response.ok) {
    await handleApiError(response, owner, repo);
  }

  // Pre-check Content-Length header if provided
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxArchiveSizeBytes) {
    throw new Error(
      `Archive download aborted: Content-Length (${contentLength} bytes) exceeds limit of ${maxArchiveSizeBytes} bytes.`
    );
  }

  // Stream chunks and enforce size limits even when Content-Length is missing
  const chunks = [];
  let downloadedBytes = 0;

  if (response.body) {
    if (typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) {
        const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        downloadedBytes += chunkBuf.length;
        if (downloadedBytes > maxArchiveSizeBytes) {
          throw new Error(
            `Archive download exceeded maximum allowed archive size of ${maxArchiveSizeBytes} bytes.`
          );
        }
        chunks.push(chunkBuf);
      }
    } else if (typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkBuf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        downloadedBytes += chunkBuf.length;
        if (downloadedBytes > maxArchiveSizeBytes) {
          reader.cancel();
          throw new Error(
            `Archive download exceeded maximum allowed archive size of ${maxArchiveSizeBytes} bytes.`
          );
        }
        chunks.push(chunkBuf);
      }
    }
  } else {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxArchiveSizeBytes) {
      throw new Error(
        `Archive download exceeded maximum allowed archive size of ${maxArchiveSizeBytes} bytes.`
      );
    }
    return Buffer.from(arrayBuffer);
  }

  return Buffer.concat(chunks);
}
