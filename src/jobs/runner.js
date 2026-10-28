/**
 * In-process job runner and crash recovery engine.
 *
 * Manages background execution of repository ingestion and refresh jobs.
 * Enforces single-job concurrency to stay strictly within free-tier resource caps.
 * Recovers stalled or interrupted jobs upon server boot.
 */
import { indexRepo } from '../ingestion/indexer.js';
import { refreshRepo } from '../ingestion/diffIndexer.js';

export class JobRunner {
  constructor() {
    this.queue = [];
    this.running = false;
    this.currentJob = null;
    this.jobsMap = new Map();
  }

  /**
   * Enqueues a full repository ingestion job.
   *
   * @param {object} params
   * @param {string} params.repoId
   * @param {string} params.owner
   * @param {string} params.repo
   * @param {object} [params.repoDoc]
   * @param {object} [params.configOverrides]
   * @returns {string} jobId
   */
  enqueueIngest({ repoId, owner, repo, repoDoc = null, configOverrides = {} }) {
    const jobId = `ingest_${repoId}_${Date.now()}`;
    const job = {
      id: jobId,
      type: 'ingest',
      repoId,
      owner,
      repo,
      repoDoc,
      configOverrides,
      status: 'queued',
      error: null,
      result: null,
      createdAt: new Date(),
    };

    this.jobsMap.set(jobId, job);
    this.queue.push(job);
    this._processNext();
    return jobId;
  }

  /**
   * Enqueues an incremental refresh job.
   *
   * @param {object} params
   * @param {string} params.repoId
   * @param {string} params.owner
   * @param {string} params.repo
   * @param {object} [params.repoDoc]
   * @param {object} [params.configOverrides]
   * @returns {string} jobId
   */
  enqueueRefresh({ repoId, owner, repo, repoDoc = null, configOverrides = {} }) {
    const jobId = `refresh_${repoId}_${Date.now()}`;
    const job = {
      id: jobId,
      type: 'refresh',
      repoId,
      owner,
      repo,
      repoDoc,
      configOverrides,
      status: 'queued',
      error: null,
      result: null,
      createdAt: new Date(),
    };

    this.jobsMap.set(jobId, job);
    this.queue.push(job);
    this._processNext();
    return jobId;
  }

  /**
   * Gets details for a tracked job.
   * @param {string} jobId
   * @returns {object|null}
   */
  getJob(jobId) {
    return this.jobsMap.get(jobId) || null;
  }

  /**
   * Internal queue processor.
   */
  async _processNext() {
    if (this.running || this.queue.length === 0) {
      return;
    }

    this.running = true;
    const job = this.queue.shift();
    this.currentJob = job;
    job.status = 'running';

    try {
      if (job.type === 'ingest') {
        const result = await indexRepo({
          owner: job.owner,
          repo: job.repo,
          repoId: job.repoId,
          repoDoc: job.repoDoc,
          configOverrides: job.configOverrides,
          onProgress: (stage, detail) => {
            job.statusDetail = `[${stage}] ${detail}`;
          },
        });
        job.status = 'completed';
        job.result = result;
      } else if (job.type === 'refresh') {
        const result = await refreshRepo({
          owner: job.owner,
          repo: job.repo,
          repoId: job.repoId,
          repoDoc: job.repoDoc,
          configOverrides: job.configOverrides,
          onProgress: (stage, detail) => {
            job.statusDetail = `[${stage}] ${detail}`;
          },
        });
        job.status = 'completed';
        job.result = result;
      }
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      if (job.repoDoc) {
        job.repoDoc.status = 'failed';
        job.repoDoc.error = err.message;
        await job.repoDoc.save().catch(() => {});
      }
    } finally {
      this.currentJob = null;
      this.running = false;
      this._processNext();
    }
  }

  /**
   * Recovers stalled repository ingestion jobs from previous server crashes.
   *
   * @param {object} params
   * @param {object} params.RepositoryModel Mongoose Repository model
   * @param {Function} [params.logger]
   * @returns {Promise<{ recoveredCount: number }>}
   */
  async recoverStalledJobs({ RepositoryModel, logger = console.log }) {
    if (!RepositoryModel) {
      return { recoveredCount: 0 };
    }

    const inFlightStatuses = ['queued', 'fetching', 'processing', 'indexing'];
    try {
      const stalledRepos = await RepositoryModel.find({
        status: { $in: inFlightStatuses },
      });

      if (stalledRepos.length === 0) {
        return { recoveredCount: 0 };
      }

      logger(`Found ${stalledRepos.length} stalled repository jobs from a prior crash.`);

      for (const repo of stalledRepos) {
        repo.status = 'failed';
        repo.error = 'Process terminated abruptly. Safe recovery: please trigger refresh or re-index.';
        repo.statusDetail = 'Stalled job reset on server startup';
        await repo.save();
      }

      return { recoveredCount: stalledRepos.length };
    } catch (err) {
      logger(`Failed to recover stalled jobs: ${err.message}`);
      return { recoveredCount: 0 };
    }
  }
}

// Global default singleton runner
export const defaultJobRunner = new JobRunner();
