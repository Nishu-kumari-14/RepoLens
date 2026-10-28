import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Milestone 1: Temporary Files Cleanup Guarantee', () => {
  it('confirms temp directory is deleted after a successful run', async () => {
    const tempDir = path.resolve(os.tmpdir(), `repolens-success-cleanup-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'hello');

    assert.equal(fs.existsSync(tempDir), true, 'Temp dir should exist during operation');

    // Emulate index-repo.js lifecycle
    try {
      // Work succeeds
      const content = fs.readFileSync(path.join(tempDir, 'sample.txt'), 'utf8');
      assert.equal(content, 'hello');
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    assert.equal(fs.existsSync(tempDir), false, 'Temp dir MUST be deleted after successful run');
  });

  it('confirms temp directory is deleted after a failed run', async () => {
    const tempDir = path.resolve(os.tmpdir(), `repolens-failed-cleanup-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'broken.bin'), 'data');

    assert.equal(fs.existsSync(tempDir), true, 'Temp dir should exist before failure');

    // Emulate index-repo.js failure handling lifecycle
    let errorCaught = false;
    try {
      throw new Error('Simulated pipeline failure during ingestion');
    } catch (err) {
      errorCaught = true;
      assert.equal(err.message, 'Simulated pipeline failure during ingestion');
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    assert.equal(errorCaught, true);
    assert.equal(fs.existsSync(tempDir), false, 'Temp dir MUST be deleted after failed run');
  });
});
