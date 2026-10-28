/**
 * Repository management controller.
 * Handles: POST /api/repositories, GET /api/repositories/:id,
 *          POST /api/repositories/:id/refresh, GET /api/repositories/:id/sessions/:sessionId
 */
import { Repository, Message } from '../../db/models.js';
import { defaultJobRunner } from '../../jobs/runner.js';

export function createRepoController({
  jobRunner = defaultJobRunner,
  RepositoryModel = Repository,
  MessageModel = Message,
} = {}) {
  return {
    /**
     * POST /api/repositories
     * Initiates asynchronous repository ingestion.
     */
    async createRepository(req, res, next) {
      try {
        const { owner, repo, canonicalUrl } = req.repoInfo;

        const repoDoc = await RepositoryModel.findOneAndUpdate(
          { owner, name: repo },
          {
            $set: {
              url: canonicalUrl,
              status: 'queued',
              statusDetail: 'Ingestion job queued',
              error: null,
            },
          },
          { upsert: true, new: true }
        );

        const repoId = String(repoDoc._id);
        const jobId = jobRunner.enqueueIngest({
          repoId,
          owner,
          repo,
          repoDoc,
        });

        res.status(202).json({
          repositoryId: repoId,
          jobId,
          status: 'queued',
          message: 'Repository ingestion job accepted and queued.',
        });
      } catch (err) {
        next(err);
      }
    },

    /**
     * GET /api/repositories/:id
     * Returns repository metadata, status, stats, and overview.
     */
    async getRepository(req, res, next) {
      try {
        const repoId = req.cleanRepoId;
        let repoDoc;

        // Support lookup by ObjectId or owner/repo string
        if (/^[0-9a-fA-F]{24}$/.test(repoId)) {
          repoDoc = await RepositoryModel.findById(repoId);
        } else if (repoId.includes('/')) {
          const [owner, name] = repoId.split('/');
          repoDoc = await RepositoryModel.findOne({ owner, name });
        }

        if (!repoDoc) {
          return res.status(404).json({
            error: `Repository with ID or slug "${repoId}" was not found.`,
          });
        }

        res.json({
          id: String(repoDoc._id),
          owner: repoDoc.owner,
          name: repoDoc.name,
          url: repoDoc.url,
          defaultBranch: repoDoc.defaultBranch,
          status: repoDoc.status,
          statusDetail: repoDoc.statusDetail,
          stats: repoDoc.stats,
          overview: repoDoc.overview,
          indexedCommitSha: repoDoc.indexedCommitSha,
          error: repoDoc.error,
          createdAt: repoDoc.createdAt,
          updatedAt: repoDoc.updatedAt,
        });
      } catch (err) {
        next(err);
      }
    },

    /**
     * POST /api/repositories/:id/refresh
     * Triggers incremental refresh using GitHub compare API.
     */
    async refreshRepository(req, res, next) {
      try {
        const repoId = req.cleanRepoId;
        const repoDoc = /^[0-9a-fA-F]{24}$/.test(repoId)
          ? await RepositoryModel.findById(repoId)
          : await RepositoryModel.findOne({
              owner: repoId.split('/')[0],
              name: repoId.split('/')[1],
            });

        if (!repoDoc) {
          return res.status(404).json({
            error: `Repository with ID "${repoId}" not found.`,
          });
        }

        if (['fetching', 'processing', 'indexing'].includes(repoDoc.status)) {
          return res.status(409).json({
            error: `Repository is currently busy in state "${repoDoc.status}". Please wait for it to finish.`,
          });
        }

        const jobId = jobRunner.enqueueRefresh({
          repoId: String(repoDoc._id),
          owner: repoDoc.owner,
          repo: repoDoc.name,
          repoDoc,
        });

        res.status(202).json({
          repositoryId: String(repoDoc._id),
          jobId,
          status: 'queued',
          message: 'Incremental refresh job accepted and queued.',
        });
      } catch (err) {
        next(err);
      }
    },

    /**
     * GET /api/repositories/:id/sessions/:sessionId
     * Returns chat history for a session.
     */
    async getSessionMessages(req, res, next) {
      try {
        const { sessionId } = req.params;
        const messages = await MessageModel.find({
          sessionId,
        }).sort({ createdAt: 1 });

        res.json({
          sessionId,
          messages: messages.map((m) => ({
            id: String(m._id),
            role: m.role,
            content: m.content,
            citations: m.citations,
            createdAt: m.createdAt,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  };
}

export const defaultRepoController = createRepoController();
