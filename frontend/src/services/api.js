/**
 * RepoLens Frontend API Client.
 * Communicates with backend endpoints and parses Server-Sent Events (SSE).
 */

const BASE_URL = '/api';

/**
 * Validates a GitHub repository URL client-side.
 * Accepts only https://github.com/{owner}/{repo} format.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isValidGitHubUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const pattern = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git|\/)?$/;
  return pattern.test(url.trim());
}

/**
 * Submits a new repository URL for ingestion.
 *
 * @param {string} repoUrl
 * @returns {Promise<{ repositoryId: string, status: string }>}
 */
export async function submitRepository(repoUrl) {
  const response = await fetch(`${BASE_URL}/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl: repoUrl.trim() }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to submit repository');
  }

  return data;
}

/**
 * Fetches current repository metadata, ingestion status, stats, and overview.
 *
 * @param {string} repoId
 * @returns {Promise<object>}
 */
export async function getRepository(repoId) {
  const response = await fetch(`${BASE_URL}/repositories/${encodeURIComponent(repoId)}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to fetch repository status');
  }
  return data;
}

/**
 * Triggers an incremental refresh for an indexed repository.
 *
 * @param {string} repoId
 * @returns {Promise<{ repositoryId: string, status: string }>}
 */
export async function refreshRepository(repoId) {
  const response = await fetch(`${BASE_URL}/repositories/${encodeURIComponent(repoId)}/refresh`, {
    method: 'POST',
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to trigger refresh');
  }
  return data;
}

/**
 * Streams chat responses and citations using Server-Sent Events.
 *
 * @param {object} params
 * @param {string} params.repoId
 * @param {string} params.question
 * @param {string} [params.sessionId]
 * @param {Function} [params.onToken] Callback for incoming tokens
 * @param {Function} [params.onComplete] Callback on stream completion
 * @param {Function} [params.onError] Callback on error
 * @returns {Promise<void>}
 */
export async function streamChat({
  repoId,
  question,
  sessionId,
  onToken = () => {},
  onComplete = () => {},
  onError = () => {},
}) {
  try {
    const response = await fetch(`${BASE_URL}/repositories/${encodeURIComponent(repoId)}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ question, sessionId }),
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      throw new Error(errJson.error || `HTTP ${response.status}: Request failed`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || ''; // retain incomplete trailing chunk

      for (const block of lines) {
        const trimmed = block.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);
        try {
          const payload = JSON.parse(jsonStr);
          if (payload.type === 'token') {
            onToken(payload.token);
          } else if (payload.type === 'done') {
            onComplete({
              answer: payload.answer,
              citations: payload.citations || [],
              queryType: payload.queryType,
              sessionId: payload.sessionId,
            });
          } else if (payload.type === 'error') {
            onError(new Error(payload.error));
          }
        } catch {
          // ignore malformed SSE block
        }
      }
    }
  } catch (err) {
    onError(err);
  }
}
