import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoUrl } from '../../src/ingestion/parseRepoUrl.js';

describe('Milestone 1: parseRepoUrl (Security & URL Validation)', () => {
  it('accepts valid GitHub repository URLs and canonicalizes them', () => {
    const cases = [
      {
        input: 'https://github.com/expressjs/express',
        expected: { owner: 'expressjs', repo: 'express' },
      },
      {
        input: 'https://github.com/facebook/react.git',
        expected: { owner: 'facebook', repo: 'react' },
      },
      {
        input: 'https://github.com/octocat/Hello-World/',
        expected: { owner: 'octocat', repo: 'Hello-World' },
      },
      {
        input: '  https://github.com/my-org/my_repo.tool  ',
        expected: { owner: 'my-org', repo: 'my_repo.tool' },
      },
    ];

    for (const { input, expected } of cases) {
      const result = parseRepoUrl(input);
      assert.equal(result.owner, expected.owner);
      assert.equal(result.repo, expected.repo);
      assert.equal(result.canonicalUrl, `https://github.com/${expected.owner}/${expected.repo}`);
    }
  });

  it('rejects non-https protocols', () => {
    assert.throws(
      () => parseRepoUrl('http://github.com/owner/repo'),
      /Protocol must be "https:"/
    );
    assert.throws(
      () => parseRepoUrl('ftp://github.com/owner/repo'),
      /Protocol must be "https:"/
    );
  });

  it('rejects hosts other than github.com', () => {
    assert.throws(
      () => parseRepoUrl('https://gitlab.com/owner/repo'),
      /Host must be "github.com"/
    );
    assert.throws(
      () => parseRepoUrl('https://bitbucket.org/owner/repo'),
      /Host must be "github.com"/
    );
    assert.throws(
      () => parseRepoUrl('https://github.com.attacker.com/owner/repo'),
      /Host must be "github.com"/
    );
  });

  it('rejects URLs containing embedded credentials', () => {
    assert.throws(
      () => parseRepoUrl('https://user:pass@github.com/owner/repo'),
      /Credentials in URL are strictly forbidden/
    );
    assert.throws(
      () => parseRepoUrl('https://token@github.com/owner/repo'),
      /Credentials in URL are strictly forbidden/
    );
  });

  it('rejects IP addresses and localhost', () => {
    assert.throws(
      () => parseRepoUrl('https://127.0.0.1/owner/repo'),
      /Host must be "github.com"/
    );
    assert.throws(
      () => parseRepoUrl('https://192.168.1.10/owner/repo'),
      /Host must be "github.com"/
    );
    assert.throws(
      () => parseRepoUrl('https://localhost/owner/repo'),
      /Host must be "github.com"/
    );
  });

  it('rejects unusual or non-standard ports', () => {
    assert.throws(
      () => parseRepoUrl('https://github.com:8080/owner/repo'),
      /Non-standard port/
    );
    assert.throws(
      () => parseRepoUrl('https://github.com:22/owner/repo'),
      /Non-standard port/
    );
  });

  it('rejects URLs missing owner or repository segments', () => {
    assert.throws(
      () => parseRepoUrl('https://github.com/'),
      /Expected format https:\/\/github\.com\/\{owner\}\/\{repo\}/
    );
    assert.throws(
      () => parseRepoUrl('https://github.com/single-segment'),
      /Expected format https:\/\/github\.com\/\{owner\}\/\{repo\}/
    );
    assert.throws(
      () => parseRepoUrl('https://github.com/owner/repo/pull/123'),
      /Expected format https:\/\/github\.com\/\{owner\}\/\{repo\}/
    );
  });

  it('rejects path traversal and malicious characters', () => {
    assert.throws(
      () => parseRepoUrl('https://github.com/owner/..'),
      /Path traversal/
    );
    assert.throws(
      () => parseRepoUrl('https://github.com/../repo'),
      /Path traversal/
    );
    assert.throws(
      () => parseRepoUrl('https://github.com/invalid$user/repo'),
      /Invalid GitHub username/
    );
  });
});
