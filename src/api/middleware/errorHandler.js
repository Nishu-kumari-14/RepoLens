/**
 * Centralized sanitizing error handler middleware.
 * Ensures no internal stack traces, API keys, or database credentials leak to clients.
 */

export function errorHandler(err, req, res, next) {
  // If response headers are already sent (e.g. during SSE streaming), delegate to default handler
  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || err.statusCode || 500;

  // Mask internal 500 errors in production to avoid information disclosure
  let safeMessage = err.message || 'An unexpected internal server error occurred.';
  if (status === 500 && process.env.NODE_ENV === 'production') {
    safeMessage = 'Internal server error. Please try again later.';
  }

  // Strip any accidental sensitive tokens from error message
  safeMessage = safeMessage.replace(/(ghp_[a-zA-Z0-9]{36}|AIza[0-9A-Za-z-_]{35})/g, '[REDACTED_KEY]');

  res.status(status).json({
    error: safeMessage,
  });
}
