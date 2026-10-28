/**
 * Express application server for RepoLens.
 */
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { connect } from '../db/mongo.js';
import { Repository } from '../db/models.js';
import { defaultJobRunner } from '../jobs/runner.js';
import { defaultRateLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createRepoRoutes } from './routes/repoRoutes.js';
import { createChatRoutes } from './routes/chatRoutes.js';

/**
 * Creates and configures the Express application.
 *
 * @param {object} [options]
 * @param {object} [options.repoController]
 * @param {object} [options.chatController]
 * @param {Function} [options.rateLimiter]
 * @param {string|Array<string>} [options.corsOrigin]
 * @returns {express.Application}
 */
export function createApp(options = {}) {
  const app = express();

  // 1. Security & CORS
  const allowedOrigins = options.corsOrigin || [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
  ];
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    })
  );

  // 2. Body Parsers & Rate Limiting
  app.use(express.json({ limit: '1mb' }));
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  if (limiter) {
    app.use(limiter);
  }

  // 3. Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // 4. API Routes
  const repoRoutes = createRepoRoutes(options.repoController);
  const chatRoutes = createChatRoutes(options.chatController);

  app.use('/api/repositories', repoRoutes);
  app.use('/api/repositories', chatRoutes);

  // 5. Centralized Error Handler
  app.use(errorHandler);

  return app;
}

/**
 * Boots the server and connects to database.
 */
export async function startServer(port = config.server?.port || 3000) {
  try {
    await connect();
    console.log('[server] Connected to MongoDB.');

    // Recover any stalled jobs from prior abnormal process termination
    await defaultJobRunner.recoverStalledJobs({ RepositoryModel: Repository });

    const app = createApp();
    const server = app.listen(port, () => {
      console.log(`[server] RepoLens API running on http://localhost:${port}`);
    });

    return server;
  } catch (err) {
    console.error(`[server] Startup failure: ${err.message}`);
    process.exit(1);
  }
}

// Direct execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
