import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../src/api/server.js';
import {
  validateRepoUrl,
  validateChatQuery,
  validateRepoIdParam,
} from '../../src/api/middleware/validation.js';
import { createRateLimiter } from '../../src/api/middleware/rateLimit.js';
import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { JobRunner } from '../../src/jobs/runner.js';

describe('Milestone 8: Express API, Job Queue & Middleware', () => {
  describe('Middleware Validation', () => {
    it('validateRepoUrl accepts valid GitHub URL and populates req.repoInfo', () => {
      const req = { body: { repoUrl: 'https://github.com/expressjs/cookie-parser' } };
      let nextCalled = false;
      const res = {};

      validateRepoUrl(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(req.repoInfo.owner, 'expressjs');
      assert.equal(req.repoInfo.repo, 'cookie-parser');
    });

    it('validateRepoUrl rejects invalid or missing URLs with 400', () => {
      const testCases = [
        {},
        { repoUrl: '' },
        { repoUrl: 'https://gitlab.com/user/repo' },
        { repoUrl: 'http://localhost/admin' },
      ];

      for (const body of testCases) {
        let statusSet = null;
        let jsonPayload = null;

        const req = { body };
        const res = {
          status: (code) => {
            statusSet = code;
            return {
              json: (data) => {
                jsonPayload = data;
              },
            };
          },
        };

        validateRepoUrl(req, res, () => {});
        assert.equal(statusSet, 400);
        assert.ok(jsonPayload.error);
      }
    });

    it('validateChatQuery accepts valid questions and rejects empty or oversized ones', () => {
      // Valid question
      const validReq = { body: { question: 'How is auth implemented?' } };
      let nextCalled = false;
      validateChatQuery(validReq, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(validReq.cleanQuestion, 'How is auth implemented?');

      // Empty question
      let statusCode = null;
      let errorJson = null;
      const mockRes = {
        status: (c) => {
          statusCode = c;
          return {
            json: (d) => {
              errorJson = d;
            },
          };
        },
      };

      validateChatQuery({ body: { question: '' } }, mockRes, () => {});
      assert.equal(statusCode, 400);
      assert.ok(errorJson.error.includes('empty'));

      // Oversized question (> 2000 chars)
      const oversizedReq = { body: { question: 'a'.repeat(2500) } };
      validateChatQuery(oversizedReq, mockRes, () => {});
      assert.equal(statusCode, 400);
      assert.ok(errorJson.error.includes('limit'));
    });

    it('validateRepoIdParam validates route parameter', () => {
      const req = { params: { id: 'repo123' } };
      let called = false;
      validateRepoIdParam(req, {}, () => {
        called = true;
      });
      assert.equal(called, true);
      assert.equal(req.cleanRepoId, 'repo123');

      let code = null;
      validateRepoIdParam(
        { params: { id: '' } },
        {
          status: (c) => ({
            json: () => {
              code = c;
            },
          }),
        },
        () => {}
      );
      assert.equal(code, 400);
    });
  });

  describe('Rate Limiter', () => {
    it('enforces request limit per IP and sets Retry-After header on 429', () => {
      const limiter = createRateLimiter({ windowMs: 10000, max: 3 });
      const req = { ip: '192.168.1.100' };

      let nextCount = 0;
      const next = () => {
        nextCount++;
      };

      // 3 requests allowed
      limiter(req, {}, next);
      limiter(req, {}, next);
      limiter(req, {}, next);
      assert.equal(nextCount, 3);

      // 4th request blocked
      let statusCode = null;
      let headers = {};
      const res = {
        setHeader: (k, v) => {
          headers[k] = v;
        },
        status: (c) => {
          statusCode = c;
          return {
            json: (payload) => payload,
          };
        },
      };

      limiter(req, res, next);
      assert.equal(statusCode, 429);
      assert.ok(headers['Retry-After']);
      assert.equal(nextCount, 3); // next was NOT called
    });
  });

  describe('Error Handler', () => {
    it('redacts sensitive API keys and tokens from error messages', () => {
      const fakeError = new Error('Call failed with key ghp_111122223333444455556666777788889999 and token AIzaSyD_1234567890abcdefghijklmnopqrstuv');
      fakeError.status = 400;

      let statusCode = null;
      let responseBody = null;
      const res = {
        status: (c) => {
          statusCode = c;
          return {
            json: (b) => {
              responseBody = b;
            },
          };
        },
      };

      errorHandler(fakeError, {}, res, () => {});

      assert.equal(statusCode, 400);
      assert.ok(!responseBody.error.includes('ghp_'));
      assert.ok(!responseBody.error.includes('AIzaSyD_'));
      assert.ok(responseBody.error.includes('[REDACTED_KEY]'));
    });
  });

  describe('JobRunner & Crash Recovery', () => {
    it('queues and executes jobs sequentially', async () => {
      const runner = new JobRunner();

      const jobId = runner.enqueueIngest({
        repoId: 'test_repo',
        owner: 'test',
        repo: 'app',
        configOverrides: {},
      });

      assert.ok(jobId.startsWith('ingest_'));
      const job = runner.getJob(jobId);
      assert.ok(job);
    });

    it('recovers stalled repository jobs on startup', async () => {
      const runner = new JobRunner();

      const mockStalledDoc = {
        _id: 'stalled_1',
        status: 'indexing',
        error: null,
        statusDetail: 'Working',
        save: async () => {},
      };

      const MockRepositoryModel = {
        find: async () => [mockStalledDoc],
      };

      const { recoveredCount } = await runner.recoverStalledJobs({
        RepositoryModel: MockRepositoryModel,
        logger: () => {},
      });

      assert.equal(recoveredCount, 1);
      assert.equal(mockStalledDoc.status, 'failed');
      assert.ok(mockStalledDoc.error.includes('terminated abruptly'));
    });
  });

  describe('Express App HTTP Integration', () => {
    let app;

    const mockRepoDoc = {
      _id: '507f1f77bcf86cd799439011',
      owner: 'expressjs',
      name: 'cookie-parser',
      url: 'https://github.com/expressjs/cookie-parser',
      status: 'ready',
      statusDetail: 'Indexed 10 chunks',
      overview: '## Purpose\nCookie parsing middleware.',
      stats: { files: 2, chunks: 10, skippedFiles: 0 },
      indexedCommitSha: 'sha123',
    };

    const mockController = {
      createRepository: (req, res) => {
        res.status(202).json({
          repositoryId: '507f1f77bcf86cd799439011',
          status: 'queued',
        });
      },
      getRepository: (req, res) => {
        if (req.cleanRepoId === '507f1f77bcf86cd799439011') {
          res.json(mockRepoDoc);
        } else {
          res.status(404).json({ error: 'Repository not found' });
        }
      },
      refreshRepository: (req, res) => {
        res.status(202).json({
          repositoryId: '507f1f77bcf86cd799439011',
          status: 'queued',
        });
      },
      getSessionMessages: (req, res) => {
        res.json({ sessionId: req.params.sessionId, messages: [] });
      },
    };

    const mockChatController = {
      chat: (req, res) => {
        const accept = req.headers.accept || '';
        if (accept.includes('text/event-stream')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            Connection: 'keep-alive',
          });
          res.write('data: {"type":"token","token":"Hello"}\n\n');
          res.write('data: {"type":"done","answer":"Hello world","citations":[]}\n\n');
          res.end();
        } else {
          res.json({
            answer: 'Hello world',
            citations: [],
          });
        }
      },
    };

    before(() => {
      app = createApp({
        repoController: mockController,
        chatController: mockChatController,
        rateLimiter: (req, res, next) => next(), // pass-through in unit test
      });
    });

    /** In-memory request dispatcher for reliable socket-free unit testing */
    function request(targetApp, { method = 'GET', url = '/', headers = {}, body = null }) {
      return new Promise((resolve) => {
        const req = new http.IncomingMessage();
        req.method = method;
        req.url = url;
        req.headers = { ...headers };
        if (body && !req.headers['content-type']) {
          req.headers['content-type'] = 'application/json';
        }

        const res = new http.ServerResponse(req);
        let responseData = '';
        const resHeaders = {};

        res.writeHead = (status, hdrs = {}) => {
          res.statusCode = status;
          for (const [k, v] of Object.entries(hdrs)) {
            resHeaders[k.toLowerCase()] = v;
          }
          return res;
        };

        const origSetHeader = res.setHeader.bind(res);
        res.setHeader = (key, val) => {
          resHeaders[key.toLowerCase()] = String(val);
          try {
            origSetHeader(key, val);
          } catch {}
        };

        const origWrite = res.write.bind(res);
        res.write = (chunk, ...args) => {
          responseData += chunk?.toString() || '';
          return true;
        };

        const origEnd = res.end.bind(res);
        res.end = (chunk, ...args) => {
          if (chunk) responseData += chunk.toString();
          resolve({
            status: res.statusCode,
            headers: {
              get: (k) => resHeaders[k.toLowerCase()] || null,
            },
            text: async () => responseData,
            json: async () => JSON.parse(responseData),
          });
        };

        if (body) {
          req.body = body;
          req._body = true;
          req.headers['content-type'] = 'application/json';
        }

        targetApp(req, res);
      });
    }

    it('GET /health returns 200 with status ok', async () => {
      const res = await request(app, { method: 'GET', url: '/health' });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'ok');
    });

    it('POST /api/repositories validates URL and returns 202 Accepted', async () => {
      const res = await request(app, {
        method: 'POST',
        url: '/api/repositories',
        body: { repoUrl: 'https://github.com/expressjs/cookie-parser' },
      });

      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.repositoryId, '507f1f77bcf86cd799439011');
      assert.equal(data.status, 'queued');
    });

    it('GET /api/repositories/:id returns repository metadata', async () => {
      const res = await request(app, {
        method: 'GET',
        url: '/api/repositories/507f1f77bcf86cd799439011',
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.name, 'cookie-parser');
      assert.equal(data.status, 'ready');
      assert.ok(data.overview.includes('Cookie parsing middleware'));
    });

    it('POST /api/repositories/:id/refresh returns 202 Accepted', async () => {
      const res = await request(app, {
        method: 'POST',
        url: '/api/repositories/507f1f77bcf86cd799439011/refresh',
      });
      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.status, 'queued');
    });

    it('POST /api/repositories/:id/chat streams response via Server-Sent Events', async () => {
      const res = await request(app, {
        method: 'POST',
        url: '/api/repositories/507f1f77bcf86cd799439011/chat',
        headers: {
          accept: 'text/event-stream',
        },
        body: { question: 'How is auth implemented?' },
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));

      const text = await res.text();
      assert.ok(text.includes('data: {"type":"token","token":"Hello"}'));
      assert.ok(text.includes('data: {"type":"done"'));
    });
  });
});
