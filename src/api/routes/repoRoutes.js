/**
 * Repository routes:
 *   POST /api/repositories
 *   GET  /api/repositories/:id
 *   POST /api/repositories/:id/refresh
 *   GET  /api/repositories/:id/sessions/:sessionId
 */
import { Router } from 'express';
import { defaultRepoController } from '../controllers/repoController.js';
import { validateRepoUrl, validateRepoIdParam } from '../middleware/validation.js';

export function createRepoRoutes(controller = defaultRepoController) {
  const router = Router();

  router.post('/', validateRepoUrl, controller.createRepository);
  router.get('/:id', validateRepoIdParam, controller.getRepository);
  router.post('/:id/refresh', validateRepoIdParam, controller.refreshRepository);
  router.get('/:id/sessions/:sessionId', validateRepoIdParam, controller.getSessionMessages);

  return router;
}

export const defaultRepoRoutes = createRepoRoutes();
