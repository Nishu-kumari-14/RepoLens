/**
 * Chat controller supporting Server-Sent Events (SSE) streaming answers and citations.
 */
import { Repository } from '../../db/models.js';
import { ask } from '../../generation/answer.js';

export function createChatController({
  RepositoryModel = Repository,
  askFn = ask,
} = {}) {
  return {
    /**
     * POST /api/repositories/:id/chat
     * Streams or returns grounded Q&A responses with citations.
     */
    async chat(req, res, next) {
      try {
        const repoId = req.cleanRepoId;
        const question = req.cleanQuestion;
        const sessionId = req.body?.sessionId || `session_${Date.now()}`;

        // 1. Verify repository exists
        let repoDoc;
        if (/^[0-9a-fA-F]{24}$/.test(repoId)) {
          repoDoc = await RepositoryModel.findById(repoId);
        } else if (repoId.includes('/')) {
          const [owner, name] = repoId.split('/');
          repoDoc = await RepositoryModel.findOne({ owner, name });
        }

        if (!repoDoc) {
          return res.status(404).json({
            error: `Repository with ID "${repoId}" not found.`,
          });
        }

        // 2. Check if repository is indexed
        if (repoDoc.status !== 'ready') {
          return res.status(400).json({
            error: `Repository is not ready for chat (status: "${repoDoc.status}"). Ingestion must complete first.`,
          });
        }

        const isStream =
          req.headers.accept?.includes('text/event-stream') ||
          req.query?.stream === 'true' ||
          req.body?.stream !== false;

        if (isStream) {
          // Setup Server-Sent Events headers
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });

          const onToken = (token) => {
            res.write(`data: ${JSON.stringify({ type: 'token', token })}\n\n`);
          };

          try {
            const result = await askFn({
              repoId: String(repoDoc._id),
              question,
              sessionId,
              overview: repoDoc.overview,
              onToken,
            });

            res.write(
              `data: ${JSON.stringify({
                type: 'done',
                answer: result.answer,
                citations: result.citations,
                queryType: result.queryType,
                sessionId,
              })}\n\n`
            );
            res.end();
          } catch (streamErr) {
            res.write(
              `data: ${JSON.stringify({
                type: 'error',
                error: streamErr.message,
              })}\n\n`
            );
            res.end();
          }
        } else {
          // Standard JSON response
          const result = await askFn({
            repoId: String(repoDoc._id),
            question,
            sessionId,
            overview: repoDoc.overview,
          });

          res.json({
            sessionId,
            answer: result.answer,
            citations: result.citations,
            queryType: result.queryType,
          });
        }
      } catch (err) {
        next(err);
      }
    },
  };
}

export const defaultChatController = createChatController();
