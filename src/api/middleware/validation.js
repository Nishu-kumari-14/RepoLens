/**
 * Request payload and parameter validation middleware.
 */
import { parseRepoUrl } from '../../ingestion/parseRepoUrl.js';

/**
 * Validates repository URL for POST /api/repositories.
 */
export function validateRepoUrl(req, res, next) {
  const { repoUrl } = req.body || {};

  if (!repoUrl || typeof repoUrl !== 'string' || repoUrl.trim().length === 0) {
    return res.status(400).json({
      error: 'Missing or empty "repoUrl" in request body.',
    });
  }

  try {
    const parsed = parseRepoUrl(repoUrl.trim());
    req.repoInfo = parsed; // { owner, repo, canonicalUrl }
    next();
  } catch (err) {
    return res.status(400).json({
      error: `Invalid repository URL: ${err.message}`,
    });
  }
}

/**
 * Validates chat query for POST /api/repositories/:id/chat.
 */
export function validateChatQuery(req, res, next) {
  const { question } = req.body || {};

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({
      error: 'Missing or empty "question" in request body.',
    });
  }

  const clean = question.trim();
  if (clean.length > 2000) {
    return res.status(400).json({
      error: 'Question exceeds maximum length limit of 2000 characters.',
    });
  }

  req.cleanQuestion = clean;
  next();
}

/**
 * Validates repository ID parameter in URL.
 */
export function validateRepoIdParam(req, res, next) {
  const { id } = req.params || {};

  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    return res.status(400).json({
      error: 'Invalid or missing repository ID parameter.',
    });
  }

  req.cleanRepoId = id.trim();
  next();
}
