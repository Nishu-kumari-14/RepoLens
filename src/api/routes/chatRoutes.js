/**
 * Chat routes:
 *   POST /api/repositories/:id/chat
 */
import { Router } from 'express';
import { defaultChatController } from '../controllers/chatController.js';
import { validateRepoIdParam, validateChatQuery } from '../middleware/validation.js';

export function createChatRoutes(controller = defaultChatController) {
  const router = Router();

  router.post('/:id/chat', validateRepoIdParam, validateChatQuery, controller.chat);

  return router;
}

export const defaultChatRoutes = createChatRoutes();
