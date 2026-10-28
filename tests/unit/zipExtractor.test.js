import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { extractZipBuffer } from '../../src/utils/zipExtractor.js';

/**
 * Helper to build in-memory ZIP buffers for testing limits, false headers, and symlinks.
 */
function buildZipBuffer(entries) {
  const localHeaders = [];
  const cdHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.name.endsWith('/');
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const contentBuf = isDir ? Buffer.alloc(0) : Buffer.from(entry.content ?? '', 'utf8');
    const deflated = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(contentBuf);

    // Allow spoofing header size to simulate zip bombs
    const reportedUncompressedSize = entry.spoofedUncompressedSize ?? contentBuf.length;

    // External file attributes: top 16 bits hold UNIX mode (e.g. symlink 0o120777)
    const externalAttrs =
      entry.externalAttrs ??
      (isDir ? (0o040755 << 16) >>> 0 : (0o100644 << 16) >>> 0);

    // Local Header (0x04034b50)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(isDir ? 0 : 8, 8); // method (0=stored, 8=deflated)
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(0, 14); // crc
    lh.writeUInt32LE(deflated.length, 18); // compressed size
    lh.writeUInt32LE(reportedUncompressedSize, 22); // uncompressed size (possibly spoofed)
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([lh, nameBuf, deflated]);
    localHeaders.push(localEntry);

    // Central Directory Header (0x02014b50)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(isDir ? 0 : 8, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(reportedUncompressedSize, 24); // uncompressed size (possibly spoofed)
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(externalAttrs, 38); // external attributes (includes symlink bit)
    cd.writeUInt32LE(offset, 42);

    cdHeaders.push(Buffer.concat([cd, nameBuf]));
    offset += localEntry.length;
  }

  const cdBuf = Buffer.concat(cdHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

describe('Milestone 1: zipExtractor (Safety, Limits & Zip-Slip Protection)', () => {
  it('safely extracts valid zip files and strips common root directory prefix', async () => {
    const testDir = path.resolve(os.tmpdir(), `repolens-test-extract-${Date.now()}`);
    const zip = buildZipBuffer([
      { name: 'myrepo-sha123/', content: '' },
      { name: 'myrepo-sha123/src/', content: '' },
      { name: 'myrepo-sha123/src/index.js', content: 'console.log("hello");' },
      { name: 'myrepo-sha123/README.md', content: '# Hello' },
    ]);

    try {
      const files = await extractZipBuffer(zip, testDir, { stripRootPrefix: true });
      assert.equal(files.length, 2);
      assert.ok(files.some((f) => f.relativePath === 'src/index.js'));
      assert.ok(files.some((f) => f.relativePath === 'README.md'));
      assert.equal(
        fs.readFileSync(path.join(testDir, 'src/index.js'), 'utf8'),
        'console.log("hello");'
      );
    } finally {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  it('detects and aborts malicious zip-slip path traversal payloads and cleans up destination', async () => {
    const testDir = path.resolve(os.tmpdir(), `repolens-test-zipslip-${Date.now()}`);
    const maliciousZip = buildZipBuffer([
      { name: 'evil/../../outside.txt', content: 'hacked content' },
    ]);

    await assert.rejects(
      () => extractZipBuffer(maliciousZip, testDir, { stripRootPrefix: false }),
      /Zip-slip path traversal detected/
    );

    // Dest directory must be cleaned up on failure
    assert.equal(fs.existsSync(testDir), false, 'Temp directory must be cleaned up on failure');
  });

  it('skips symlink entries completely', async () => {
    const testDir = path.resolve(os.tmpdir(), `repolens-test-symlink-${Date.now()}`);
    const symlinkMode = (0o120777 << 16) >>> 0; // S_IFLNK in top 16 bits
    const zip = buildZipBuffer([
      { name: 'normal.txt', content: 'hello' },
      { name: 'link_to_passwd', content: '/etc/passwd', externalAttrs: symlinkMode },
    ]);

    try {
      const files = await extractZipBuffer(zip, testDir, { stripRootPrefix: false });
      assert.equal(files.length, 1);
      assert.equal(files[0].relativePath, 'normal.txt');
      assert.equal(fs.existsSync(path.join(testDir, 'link_to_passwd')), false);
    } finally {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  it('aborts on a zip bomb whose header lies about uncompressed size', async () => {
    const testDir = path.resolve(os.tmpdir(), `repolens-test-fakeheader-${Date.now()}`);
    // Header claims size is 10 bytes, but content actually expands to 6000 bytes
    const actualLargeContent = 'A'.repeat(6000);
    const zip = buildZipBuffer([
      {
        name: 'bomb.txt',
        content: actualLargeContent,
        spoofedUncompressedSize: 10, // False header claim!
      },
    ]);

    await assert.rejects(
      () =>
        extractZipBuffer(zip, testDir, {
          maxSingleFileSizeBytes: 1000, // Limit is 1000 bytes
          stripRootPrefix: false,
        }),
      /Extraction limit exceeded: Entry "bomb.txt" decompressed size exceeds single-file limit/
    );

    // Cleaned up on error
    assert.equal(fs.existsSync(testDir), false);
  });

  it('aborts when actual decompressed bytes exceed maxArchiveSizeBytes', async () => {
    const testDir = path.resolve(os.tmpdir(), `repolens-test-totalsize-${Date.now()}`);
    const zip = buildZipBuffer([
      { name: 'chunk1.txt', content: 'A'.repeat(3000), spoofedUncompressedSize: 5 },
      { name: 'chunk2.txt', content: 'B'.repeat(3000), spoofedUncompressedSize: 5 },
    ]);

    await assert.rejects(
      () =>
        extractZipBuffer(zip, testDir, {
          maxSingleFileSizeBytes: 5000,
          maxArchiveSizeBytes: 4000,
          stripRootPrefix: false,
        }),
      /Extraction limit exceeded: Total archive decompressed size exceeds limit/
    );
    assert.equal(fs.existsSync(testDir), false);
  });

  it('aborts when archive entry count exceeds maxFileCount limit', async () => {
    const testDir = path.resolve(os.tmpdir(), `repolens-test-filecount-${Date.now()}`);
    const entries = [];
    for (let i = 0; i < 15; i++) {
      entries.push({ name: `file_${i}.txt`, content: `data ${i}` });
    }
    const zip = buildZipBuffer(entries);

    await assert.rejects(
      () => extractZipBuffer(zip, testDir, { maxFileCount: 10, stripRootPrefix: false }),
      /Archive contains more than 10 extracted files/
    );
    assert.equal(fs.existsSync(testDir), false);
  });
});
