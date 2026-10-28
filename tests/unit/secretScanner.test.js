import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanFile, scanFiles } from '../../src/ingestion/secretScanner.js';

describe('Milestone 1: secretScanner (Credential Detection & Exclusion)', () => {
  it('detects secret files based on filename patterns', () => {
    const filenames = [
      '.env',
      '.env.local',
      '.env.production',
      '.env.staging',
      'cert.pem',
      'server.key',
      'id_rsa',
      'id_ed25519',
    ];

    for (const relativePath of filenames) {
      const result = scanFile({ relativePath });
      assert.equal(result.hasSecret, true, `Expected ${relativePath} to be flagged`);
      assert.ok(result.reason.startsWith('secret_filename:'));
    }
  });

  it('detects secret content patterns in source code', () => {
    const rawAwsKey = 'AKIAIOSFODNN7EXAMPLE';
    const rawPrivateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...';
    const rawGithubPat = 'ghp_1234567890abcdef1234567890abcdef1234';
    const rawJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozG4c3iX_w9cZ_';

    const secretCases = [
      {
        file: {
          relativePath: 'src/awsConfig.js',
          content: `export const AWS_ACCESS_KEY = "${rawAwsKey}";`,
        },
        expectedRule: 'AWS Access Key ID',
        secretValue: rawAwsKey,
      },
      {
        file: {
          relativePath: 'src/ssl.js',
          content: `const key = "${rawPrivateKey}";`,
        },
        expectedRule: 'Private Key Header',
        secretValue: 'MIIEowIBAAKCAQEA0',
      },
      {
        file: {
          relativePath: 'scripts/deploy.js',
          content: `const token = "${rawGithubPat}";`,
        },
        expectedRule: 'GitHub Token',
        secretValue: rawGithubPat,
      },
      {
        file: {
          relativePath: 'src/auth.js',
          content: `const sampleToken = "${rawJwt}";`,
        },
        expectedRule: 'JWT',
        secretValue: rawJwt,
      },
    ];

    for (const { file, expectedRule, secretValue } of secretCases) {
      const result = scanFile(file);
      assert.equal(result.hasSecret, true, `File ${file.relativePath} should be flagged`);
      assert.ok(
        result.reason.includes(expectedRule),
        `Reason should describe the pattern (${expectedRule}): ${result.reason}`
      );

      // SECURITY CRITICAL: Ensure the matched secret itself is never leaked in the reason or output
      assert.equal(
        result.reason.includes(secretValue),
        false,
        `SECURITY VIOLATION: Secret value "${secretValue}" leaked in scan reason!`
      );
    }
  });

  it('passes normal, non-secret source files cleanly', () => {
    const cleanFiles = [
      {
        relativePath: 'src/utils/math.js',
        content: 'export function add(a, b) { return a + b; }',
      },
      {
        relativePath: 'src/routes/user.js',
        content: `
          import express from 'express';
          export const router = express.Router();
          router.get('/users', (req, res) => res.json({ status: 'ok' }));
        `,
      },
      {
        relativePath: 'README.md',
        content: '# Project Documentation\nWelcome to RepoLens.',
      },
    ];

    for (const file of cleanFiles) {
      const result = scanFile(file);
      assert.equal(result.hasSecret, false, `File ${file.relativePath} should not be flagged`);
      assert.equal(result.reason, undefined);
    }
  });

  it('scanFiles partitions clean and flagged files correctly', () => {
    const files = [
      { relativePath: 'src/index.js', content: 'console.log("hello");' },
      { relativePath: '.env', content: 'SECRET=123' },
      { relativePath: 'src/api.js', content: 'const apiKey = "1234567890abcdef123456";' },
    ];

    const { clean, flagged } = scanFiles(files);
    assert.equal(clean.length, 1);
    assert.equal(flagged.length, 2);
    assert.equal(clean[0].relativePath, 'src/index.js');
  });

  it('strictly excludes secret files so zero secret content is passed downstream or printed', () => {
    const rawSecret = 'AKIAIOSFODNN7EXAMPLE';
    const fakePassword = 'password = "SuperSecretPassword123!"';

    const inputFiles = [
      { relativePath: 'src/valid.js', content: 'export const valid = true;' },
      { relativePath: 'config/keys.js', content: `const aws = "${rawSecret}";` },
      { relativePath: 'credentials.env', content: 'DB_PASS=xyz' },
      { relativePath: 'src/auth.js', content: fakePassword },
    ];

    const { clean, flagged } = scanFiles(inputFiles);

    // 1. Only clean files are in the clean set (to be chunked/embedded)
    assert.equal(clean.length, 1);
    assert.equal(clean[0].relativePath, 'src/valid.js');

    // 2. All 3 secret files are in flagged
    assert.equal(flagged.length, 3);

    // 3. Flagged output contains NO secret values (neither raw nor redacted)
    for (const item of flagged) {
      assert.equal(
        item.reason.includes(rawSecret),
        false,
        'Secret must not be present in reason'
      );
      assert.equal(
        item.reason.includes('SuperSecretPassword123!'),
        false,
        'Password must not be present in reason'
      );
      // Ensure no redaction artifacts like 'AKIA***' in reasons
      assert.equal(item.reason.includes('***'), false);
    }
  });
});
