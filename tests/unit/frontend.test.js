import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isValidGitHubUrl, streamChat } from '../../frontend/src/services/api.js';

describe('Milestone 9: React Frontend Client & Validation', () => {
  describe('isValidGitHubUrl', () => {
    it('accepts valid GitHub repository URLs', () => {
      const validUrls = [
        'https://github.com/expressjs/cookie-parser',
        'https://github.com/expressjs/cookie-parser.git',
        'https://github.com/expressjs/cookie-parser/',
        'https://github.com/sindresorhus/is',
        'https://github.com/pallets/flask',
      ];

      for (const url of validUrls) {
        assert.equal(isValidGitHubUrl(url), true, `Expected "${url}" to be valid`);
      }
    });

    it('rejects invalid, malformed, or non-GitHub URLs', () => {
      const invalidUrls = [
        '',
        null,
        undefined,
        'http://github.com/user/repo', // require HTTPS
        'https://gitlab.com/user/repo',
        'https://github.com/',
        'https://github.com/only-owner',
        'https://github.com/owner/repo/subpath',
        'javascript:alert(1)',
      ];

      for (const url of invalidUrls) {
        assert.equal(isValidGitHubUrl(url), false, `Expected "${url}" to be invalid`);
      }
    });
  });

  describe('streamChat SSE Parser', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('parses Server-Sent Events stream and fires onToken and onComplete callbacks', async () => {
      const streamChunks = [
        'data: {"type":"token","token":"Hello"}\n\n',
        'data: {"type":"token","token":" world"}\n\n',
        'data: {"type":"done","answer":"Hello world","citations":[{"filePath":"index.js","startLine":1,"endLine":10}],"queryType":"specific"}\n\n',
      ];

      let chunkIdx = 0;
      const mockStream = new ReadableStream({
        pull(controller) {
          if (chunkIdx < streamChunks.length) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(streamChunks[chunkIdx++]));
          } else {
            controller.close();
          }
        },
      });

      globalThis.fetch = async () => ({
        ok: true,
        body: mockStream,
      });

      const tokens = [];
      let completionResult = null;

      await streamChat({
        repoId: 'test_repo',
        question: 'What is this?',
        onToken: (tok) => tokens.push(tok),
        onComplete: (res) => {
          completionResult = res;
        },
      });

      assert.deepEqual(tokens, ['Hello', ' world']);
      assert.ok(completionResult);
      assert.equal(completionResult.answer, 'Hello world');
      assert.equal(completionResult.citations.length, 1);
      assert.equal(completionResult.citations[0].filePath, 'index.js');
    });

    it('handles stream errors and propagates them to onError callback', async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Repository not ready' }),
      });

      let capturedError = null;

      await streamChat({
        repoId: 'test_repo',
        question: 'test question',
        onError: (err) => {
          capturedError = err;
        },
      });

      assert.ok(capturedError);
      assert.ok(capturedError.message.includes('Repository not ready'));
    });
  });
});
