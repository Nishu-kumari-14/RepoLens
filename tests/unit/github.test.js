import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getLatestCommit, downloadRepoArchive, compareCommits } from '../../src/adapters/github.js';

describe('Milestone 1: github adapter (Rate Limits, Safety & Header Security)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches latest commit SHA with correct headers and bearer token', async () => {
    let capturedHeaders = null;
    let capturedUrl = null;

    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return new Response(JSON.stringify([{ sha: 'a1b2c3d4e5f67890' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const sha = await getLatestCommit({
      owner: 'octocat',
      repo: 'Hello-World',
      token: 'ghp_secret_test_token_12345',
    });

    assert.equal(sha, 'a1b2c3d4e5f67890');
    assert.ok(capturedUrl.includes('api.github.com/repos/octocat/Hello-World/commits'));
    assert.equal(capturedHeaders['Authorization'], 'Bearer ghp_secret_test_token_12345');
    assert.equal(capturedHeaders['User-Agent'], 'RepoLens-Agent');
  });

  it('handles GitHub API 403/429 rate limit errors with clear diagnostic guidance', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1800000000',
        },
      });
    };

    await assert.rejects(
      () => getLatestCommit({ owner: 'octocat', repo: 'Hello-World' }),
      /GitHub API rate limit exceeded for "octocat\/Hello-World".*Set or verify GITHUB_TOKEN in \.env/
    );
  });

  it('handles 404 repository not found errors cleanly', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
      });
    };

    await assert.rejects(
      () => getLatestCommit({ owner: 'octocat', repo: 'nonexistent-repo' }),
      /Repository "octocat\/nonexistent-repo" was not found or is private/
    );
  });

  it('aborts archive download if Content-Length exceeds maxArchiveSizeBytes', async () => {
    globalThis.fetch = async () => {
      return new Response(new Uint8Array(100), {
        status: 200,
        headers: { 'Content-Length': '200000000' }, // 200MB
      });
    };

    await assert.rejects(
      () =>
        downloadRepoArchive({
          owner: 'octocat',
          repo: 'big-repo',
          maxArchiveSizeBytes: 50 * 1024 * 1024,
        }),
      /Archive download aborted: Content-Length.*exceeds limit/
    );
  });

  it('aborts archive download while streaming when Content-Length is missing', async () => {
    // Custom ReadableStream that yields chunks exceeding maxArchiveSizeBytes without Content-Length
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(600));
        controller.enqueue(Buffer.alloc(600));
        controller.close();
      },
    });

    globalThis.fetch = async () => {
      return new Response(stream, {
        status: 200,
        headers: {}, // No Content-Length header!
      });
    };

    await assert.rejects(
      () =>
        downloadRepoArchive({
          owner: 'octocat',
          repo: 'streaming-repo',
          maxArchiveSizeBytes: 1000,
        }),
      /Archive download exceeded maximum allowed archive size of 1000 bytes/
    );
  });

  describe('compareCommits', () => {
    it('returns empty file list when base and head are identical', async () => {
      const result = await compareCommits({
        owner: 'octocat',
        repo: 'Hello-World',
        base: 'sha_same',
        head: 'sha_same',
      });

      assert.deepEqual(result, { aheadBy: 0, behindBy: 0, files: [] });
    });

    it('queries GitHub compare endpoint and maps file statuses correctly', async () => {
      let capturedUrl = '';
      globalThis.fetch = async (url) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({
            ahead_by: 2,
            behind_by: 0,
            files: [
              { filename: 'src/index.js', status: 'modified' },
              { filename: 'src/new.js', status: 'added' },
              { filename: 'old.js', status: 'removed' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const result = await compareCommits({
        owner: 'octocat',
        repo: 'Hello-World',
        base: 'sha_base_1',
        head: 'sha_head_2',
        token: 'test_token',
      });

      assert.ok(capturedUrl.includes('/compare/sha_base_1...sha_head_2'));
      assert.equal(result.aheadBy, 2);
      assert.equal(result.files.length, 3);
      assert.equal(result.files[0].filename, 'src/index.js');
      assert.equal(result.files[0].status, 'modified');
      assert.equal(result.files[1].status, 'added');
      assert.equal(result.files[2].status, 'removed');
    });
  });
});
