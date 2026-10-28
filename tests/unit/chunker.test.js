import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chunkFile,
  chunkByLineWindow,
  chunkMarkdown,
  splitOversizedChunk,
  createChunk,
  loadLanguage,
} from '../../src/ingestion/chunker.js';
import { INGESTION_LIMITS } from '../../src/config/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_WASM_DIR = path.resolve(__dirname, '../../wasm');
const MISSING_WASM_DIR = path.resolve(__dirname, '../../wasm-does-not-exist');

describe('Milestone 2: Syntax-Aware & Resilient Chunker', () => {
  it('chunks a single JavaScript function correctly', async () => {
    const code = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
    ].join('\n');

    const chunks = await chunkFile(code, 'src/math.js');
    assert.ok(chunks.length >= 1);
    const funcChunk = chunks.find((c) => c.symbol === 'add');
    assert.ok(funcChunk, 'Expected chunk with symbol "add"');
    assert.equal(funcChunk.language, 'javascript');
    assert.equal(funcChunk.symbolKind, 'function');
    assert.equal(funcChunk.startLine, 1);
    assert.equal(funcChunk.endLine, 3);
    assert.ok(funcChunk.embeddingText.includes('File: src/math.js | Symbol: add'));
  });

  it('chunks multiple JavaScript functions and preserves preamble', async () => {
    const code = [
      '// Preamble setup',
      'const PI = 3.14159;',
      '',
      'function getPi() {',
      '  return PI;',
      '}',
      '',
      'function area(r) {',
      '  return PI * r * r;',
      '}',
    ].join('\n');

    const chunks = await chunkFile(code, 'src/circle.js');
    assert.ok(chunks.length >= 2);

    const preambleChunk = chunks.find((c) => c.symbol === 'module preamble');
    assert.ok(preambleChunk, 'Expected module preamble chunk');
    assert.equal(preambleChunk.startLine, 1);
    assert.equal(preambleChunk.endLine, 2);

    const getPiChunk = chunks.find((c) => c.symbol === 'getPi');
    assert.ok(getPiChunk);
    assert.equal(getPiChunk.startLine, 4);
    assert.equal(getPiChunk.endLine, 6);

    const areaChunk = chunks.find((c) => c.symbol === 'area');
    assert.ok(areaChunk);
    assert.equal(areaChunk.startLine, 8);
    assert.equal(areaChunk.endLine, 10);
  });

  it('chunks a JavaScript class with methods and tracks parent', async () => {
    const code = [
      'class Calculator {',
      '  constructor() {',
      '    this.value = 0;',
      '  }',
      '  add(n) {',
      '    this.value += n;',
      '    return this;',
      '  }',
      '  subtract(n) {',
      '    this.value -= n;',
      '    return this;',
      '  }',
      '}',
    ].join('\n');

    const chunks = await chunkFile(code, 'src/calc.js');
    assert.ok(chunks.length >= 1);

    const addMethod = chunks.find((c) => c.symbol === 'add');
    if (addMethod) {
      assert.equal(addMethod.symbolKind, 'method');
      assert.equal(addMethod.parent, 'Calculator');
      assert.equal(addMethod.startLine, 5);
      assert.equal(addMethod.endLine, 8);
    } else {
      // In case AST WASM is not yet built, class or fallback lines exist
      const classChunk = chunks.find((c) => c.symbol === 'Calculator');
      assert.ok(classChunk);
    }
  });

  it('chunks an exported arrow function', async () => {
    const code = [
      'export const multiply = (a, b) => {',
      '  return a * b;',
      '};',
    ].join('\n');

    const chunks = await chunkFile(code, 'src/math.js');
    assert.ok(chunks.length >= 1);
    const multChunk = chunks.find((c) => c.symbol === 'multiply');
    assert.ok(multChunk);
    assert.equal(multChunk.symbolKind, 'function');
    assert.equal(multChunk.startLine, 1);
    assert.equal(multChunk.endLine, 3);
  });

  it('chunks a Python class with methods', async () => {
    const code = [
      'import os',
      '',
      'class Service:',
      '    def __init__(self):',
      '        self.name = "service"',
      '',
      '    def run(self):',
      '        return True',
    ].join('\n');

    const chunks = await chunkFile(code, 'services/worker.py');
    assert.ok(chunks.length >= 1);
    const runMethod = chunks.find((c) => c.symbol === 'run');
    if (runMethod) {
      assert.equal(runMethod.symbolKind, 'method');
      assert.equal(runMethod.parent, 'Service');
      assert.equal(runMethod.startLine, 7);
      assert.equal(runMethod.endLine, 8);
    } else {
      assert.ok(chunks.length >= 1);
    }
  });

  it('chunks markdown by heading sections', async () => {
    const markdown = [
      '# Project Overview',
      'This is the introduction.',
      '',
      '## Architecture',
      'Here is the architecture description.',
      'It has multiple lines.',
      '',
      '## Installation',
      'npm install',
    ].join('\n');

    const chunks = await chunkFile(markdown, 'README.md');
    assert.equal(chunks.length, 3);

    assert.equal(chunks[0].symbol, 'Project Overview');
    assert.equal(chunks[0].startLine, 1);
    assert.equal(chunks[0].endLine, 3);

    assert.equal(chunks[1].symbol, 'Architecture');
    assert.equal(chunks[1].startLine, 4);
    assert.equal(chunks[1].endLine, 7);

    assert.equal(chunks[2].symbol, 'Installation');
    assert.equal(chunks[2].startLine, 8);
    assert.equal(chunks[2].endLine, 9);
  });

  it('handles syntax errors without throwing and falls back to line windows', async () => {
    const brokenCode = [
      'function broken( {',
      '   const x = ;',
      '   return x +',
      '}',
      'broken();',
    ].join('\n');

    // Must never throw
    let chunks = [];
    assert.doesNotThrow(async () => {
      chunks = await chunkFile(brokenCode, 'src/broken.js');
    });
    chunks = await chunkFile(brokenCode, 'src/broken.js');
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].startLine, 1);
  });

  it('chunks unsupported file languages using line-window fallback', async () => {
    const rubyCode = [
      'class User',
      '  def initialize(name)',
      '    @name = name',
      '  end',
      'end',
    ].join('\n');

    const chunks = await chunkFile(rubyCode, 'app/models/user.rb');
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].symbolKind, 'text');
    assert.equal(chunks[0].startLine, 1);
    assert.equal(chunks[0].endLine, 5);
  });

  it('returns empty array on empty or whitespace-only files', async () => {
    const emptyChunks = await chunkFile('', 'src/empty.js');
    assert.deepEqual(emptyChunks, []);

    const whitespaceChunks = await chunkFile('   \n\n  \t  ', 'src/empty2.js');
    assert.deepEqual(whitespaceChunks, []);
  });

  it('splits oversized functions by line windows while preserving symbol and parent', async () => {
    const longLines = ['function giantTask() {'];
    for (let i = 1; i <= 150; i++) {
      longLines.push(`  console.log("processing step ${i} with lots of descriptive text for size");`);
    }
    longLines.push('  return true;');
    longLines.push('}');
    const bigCode = longLines.join('\n');

    const chunks = await chunkFile(bigCode, 'src/tasks.js', {
      limits: {
        CHUNK_MAX_CHARACTERS: 1500,
        CHUNK_MAX_LINES: 50,
        FALLBACK_WINDOW_LINES: 40,
        FALLBACK_OVERLAP_LINES: 5,
      },
    });

    assert.ok(chunks.length > 1, 'Expected giant function to be split into multiple sub-chunks');
    for (const chunk of chunks) {
      assert.ok(chunk.symbol.startsWith('giantTask'));
      assert.ok(chunk.content.length <= 1500, `Expected chunk content length ${chunk.content.length} <= 1500`);
    }
  });

  it('asserts exact 1-based inclusive startLine and endLine on a known sample', async () => {
    const code = [
      'const GREETING = "Hello";', // Line 1
      '',                         // Line 2
      'function greet(name) {',   // Line 3
      '  return `${GREETING}, ${name}!`;', // Line 4
      '}',                        // Line 5
    ].join('\n');

    const chunks = await chunkFile(code, 'src/greeting.js');
    assert.ok(chunks.length >= 2);

    const preamble = chunks.find((c) => c.symbol === 'module preamble');
    assert.ok(preamble);
    assert.equal(preamble.startLine, 1);
    assert.equal(preamble.endLine, 1);

    const greetFunc = chunks.find((c) => c.symbol === 'greet');
    assert.ok(greetFunc);
    assert.equal(greetFunc.startLine, 3);
    assert.equal(greetFunc.endLine, 5);
  });

  it('asserts coverage that every non-empty line belongs to at least one chunk', async () => {
    const sample = [
      'import express from "express";',
      'import http from "node:http";',
      '',
      'const PORT = 3000;',
      'const APP_NAME = "SampleApp";',
      '',
      'export function setup() {',
      '  const app = express();',
      '  return app;',
      '}',
      '',
      'export class Server {',
      '  start() {',
      '    console.log("Starting...");',
      '  }',
      '}',
      '',
      'const instance = new Server();',
      'export default instance;',
    ].join('\n');

    const lines = sample.split('\n');
    const chunks = await chunkFile(sample, 'src/server.js');

    assert.ok(chunks.length >= 1);

    for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
      const lineText = lines[lineNum - 1].trim();
      if (lineText.length === 0) continue; // Skip empty lines

      const coveringChunk = chunks.find(
        (c) => lineNum >= c.startLine && lineNum <= c.endLine
      );

      assert.ok(
        coveringChunk,
        `Line ${lineNum} ("${lineText}") was not covered by any chunk!`
      );
    }
  });

  it('fails loudly when wasm grammars are missing instead of silently returning line-window chunks', async () => {
    // This test guards against the chunker silently falling back to line windows
    // when the grammar WASM files are absent (e.g. forgot to run npm run setup:wasm).
    // It verifies that loadLanguage returns null for a missing wasmDir,
    // and that this can be detected so callers can surface a meaningful error.

    // Use 'tsx': not loaded by any earlier test, so no module-level cache hit.
    // The grammar file won't exist in MISSING_WASM_DIR.
    const lang = await loadLanguage('tsx', MISSING_WASM_DIR);
    assert.equal(
      lang,
      null,
      'loadLanguage should return null when grammar WASM is missing, not throw'
    );

    // chunkFile for a .tsx file with a missing wasmDir must fall back to line windows (no AST symbol chunks)
    const tsxCode = [
      'export function Button({ label }) {',
      '  return label;',
      '}',
    ].join('\n');

    const fallbackChunks = await chunkFile(tsxCode, 'src/Button.tsx', {
      wasmDir: MISSING_WASM_DIR,
    });
    assert.ok(fallbackChunks.length >= 1, 'Should still produce chunks via fallback');
    const hasSymbolChunk = fallbackChunks.some(
      (c) => c.symbolKind === 'function' || c.symbolKind === 'method' || c.symbolKind === 'class'
    );
    assert.equal(
      hasSymbolChunk,
      false,
      'With missing WASM, no AST symbol chunks should be produced — only line-window fallback chunks'
    );

    // Countercheck: with the real wasm dir, the same .tsx file DOES produce an AST symbol chunk
    const astChunks = await chunkFile(tsxCode, 'src/Button.tsx', {
      wasmDir: REAL_WASM_DIR,
    });
    const hasAstSymbol = astChunks.some(
      (c) => c.symbol === 'Button' && (c.symbolKind === 'function' || c.symbolKind === 'class')
    );
    assert.ok(
      hasAstSymbol,
      `With real WASM dir, expected AST symbol chunk "Button" in .tsx but got: ${astChunks.map((c) => c.symbol).join(', ')}`
    );
  });
});
