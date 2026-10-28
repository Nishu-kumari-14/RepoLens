import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateChunks, buildContext } from '../../src/retrieval/contextBuilder.js';

describe('Milestone 4: Context Builder', () => {
  it('deduplicates redundant nested chunks within the same file', () => {
    const parentChunk = {
      filePath: 'src/auth.js',
      startLine: 10,
      endLine: 50,
      content: 'entire auth function',
    };
    const nestedChunk = {
      filePath: 'src/auth.js',
      startLine: 20,
      endLine: 35,
      content: 'inner helper',
    };
    const distinctChunk = {
      filePath: 'src/auth.js',
      startLine: 60,
      endLine: 80,
      content: 'token validator',
    };

    const deduped = deduplicateChunks([parentChunk, nestedChunk, distinctChunk]);

    assert.equal(deduped.length, 2);
    assert.ok(deduped.some((c) => c.startLine === 10 && c.endLine === 50));
    assert.ok(deduped.some((c) => c.startLine === 60 && c.endLine === 80));
    assert.ok(!deduped.some((c) => c.startLine === 20 && c.endLine === 35));
  });

  it('groups chunks by file and sorts them by startLine', () => {
    const chunks = [
      { filePath: 'src/b.js', startLine: 30, endLine: 40, content: 'b_part2' },
      { filePath: 'src/a.js', startLine: 50, endLine: 60, content: 'a_part2' },
      { filePath: 'src/b.js', startLine: 1, endLine: 10, content: 'b_part1' },
      { filePath: 'src/a.js', startLine: 5, endLine: 15, content: 'a_part1' },
    ];

    const { includedChunks } = buildContext(chunks);

    assert.equal(includedChunks[0].filePath, 'src/a.js');
    assert.equal(includedChunks[0].startLine, 5);

    assert.equal(includedChunks[1].filePath, 'src/a.js');
    assert.equal(includedChunks[1].startLine, 50);

    assert.equal(includedChunks[2].filePath, 'src/b.js');
    assert.equal(includedChunks[2].startLine, 1);

    assert.equal(includedChunks[3].filePath, 'src/b.js');
    assert.equal(includedChunks[3].startLine, 30);
  });

  it('includes compact file tree in context when provided', () => {
    const chunks = [
      { filePath: 'src/index.js', startLine: 1, endLine: 5, content: 'console.log(1);' },
    ];
    const fileTree = ['package.json', 'README.md', 'src/index.js'];

    const { contextText } = buildContext(chunks, { fileTree });

    assert.ok(contextText.includes('[REPOSITORY FILE TREE]'));
    assert.ok(contextText.includes('package.json'));
    assert.ok(contextText.includes('--- File: src/index.js'));
  });

  it('enforces token budget by truncating lower-priority chunks', () => {
    const chunks = [
      {
        filePath: 'src/first.js',
        startLine: 1,
        endLine: 10,
        content: 'const first = "first chunk content";',
      },
      {
        filePath: 'src/second.js',
        startLine: 1,
        endLine: 100,
        content: 'x'.repeat(2000), // Large chunk
      },
      {
        filePath: 'src/third.js',
        startLine: 1,
        endLine: 50,
        content: 'const third = "should be dropped";',
      },
    ];

    // Constrain budget to ~100 tokens (~400 characters)
    const { includedChunks, contextText } = buildContext(chunks, { maxTokens: 100 });

    assert.equal(includedChunks.length, 1);
    assert.equal(includedChunks[0].filePath, 'src/first.js');
    assert.ok(!contextText.includes('src/third.js'));
  });
});
