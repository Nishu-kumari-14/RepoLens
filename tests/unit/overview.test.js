import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuery,
  ask,
} from '../../src/generation/answer.js';
import {
  generateOverview,
  parseOverviewSections,
  isReadme,
  isManifest,
  isEntryPoint,
  storeOverview,
} from '../../src/generation/overview.js';

describe('Milestone 6: Repository Overview Generation & Query Routing', () => {
  describe('classifyQuery', () => {
    it('accurately identifies broad architectural and project queries', () => {
      const broadQueries = [
        'What does this project do?',
        'what does this repo do',
        'Can you give me a high-level overview of this codebase?',
        'Explain the architecture of this system',
        'What is the tech stack used here?',
        'Explain the folder structure of this repo',
        'How is this codebase organized?',
        'What is the main purpose of this repository?',
      ];

      for (const q of broadQueries) {
        assert.equal(classifyQuery(q), 'broad', `Expected "${q}" to be classified as broad`);
      }
    });

    it('accurately identifies specific code-level queries', () => {
      const specificQueries = [
        'How does cookieParser parse signed cookies?',
        'Where is the verifyToken middleware defined?',
        'Which file handles MongoDB connection logic?',
        'What parameters does the ask() function accept?',
        'Show me the error handling on line 45 of index.js',
      ];

      for (const q of specificQueries) {
        assert.equal(classifyQuery(q), 'specific', `Expected "${q}" to be classified as specific`);
      }
    });

    it('handles edge cases gracefully', () => {
      assert.equal(classifyQuery(''), 'specific');
      assert.equal(classifyQuery(null), 'specific');
      assert.equal(classifyQuery(undefined), 'specific');
    });
  });

  describe('File Categorization & Section Parsing', () => {
    it('correctly identifies READMEs, manifests, and entry points', () => {
      assert.ok(isReadme('README.md'));
      assert.ok(isReadme('docs/README.txt'));
      assert.ok(!isReadme('src/index.js'));

      assert.ok(isManifest('package.json'));
      assert.ok(isManifest('requirements.txt'));
      assert.ok(isManifest('Cargo.toml'));
      assert.ok(!isManifest('index.js'));

      assert.ok(isEntryPoint('src/index.js'));
      assert.ok(isEntryPoint('server.js'));
      assert.ok(isEntryPoint('app.py'));
      assert.ok(isEntryPoint('scripts/cli.js'));
      assert.ok(!isEntryPoint('src/utils/math.js'));
    });

    it('parses structured overview sections from markdown', () => {
      const sampleMarkdown = `
# RepoLens Overview

## Purpose
RepoLens provides hybrid RAG search over GitHub repositories.

## Tech Stack
Node.js, Express, LanceDB, MongoDB, tree-sitter.

## Architecture
Three-tier architecture with ingestion, retrieval, and API layers.
(Inference: The system is designed for local development).

## Important Modules
- src/ingestion: Handles file filtering and AST chunking.
- src/retrieval: Implements vector search and BM25 search.

## Setup
Run npm install and npm start.
`;

      const sections = parseOverviewSections(sampleMarkdown);
      assert.ok(sections.purpose.includes('hybrid RAG search'));
      assert.ok(sections.techStack.includes('LanceDB'));
      assert.ok(sections.architecture.includes('Three-tier architecture'));
      assert.ok(sections.architecture.includes('(Inference:'));
      assert.ok(sections.importantModules.includes('src/ingestion'));
      assert.ok(sections.setup.includes('npm install'));
    });
  });

  describe('generateOverview', () => {
    it('extracts assets and synthesizes a structured overview with labeled inferences', async () => {
      const mockFiles = [
        {
          filePath: 'README.md',
          content: '# Test Project\nA high-performance cookie parsing middleware.',
        },
        {
          filePath: 'package.json',
          content: JSON.stringify({ name: 'cookie-parser', dependencies: { cookie: '0.4.0' } }),
        },
        {
          filePath: 'index.js',
          content: 'module.exports = function cookieParser() { return (req, res, next) => next(); };',
        },
      ];

      let capturedPrompt = '';
      const mockLlm = async (prompt, options) => {
        capturedPrompt = prompt;
        return `## Purpose
A cookie parsing library for Node.js.

## Tech Stack
JavaScript, Node.js.

## Architecture
Exports a connect-style middleware function.
(Inference: Suitable for Express applications).

## Important Modules
index.js: Primary middleware entry point.

## Setup
npm install cookie-parser`;
      };

      const result = await generateOverview({
        files: mockFiles,
        llmGenerateFn: mockLlm,
      });

      // Verify prompt included the assets
      assert.ok(capturedPrompt.includes('README'));
      assert.ok(capturedPrompt.includes('cookie parsing middleware'));
      assert.ok(capturedPrompt.includes('package.json'));
      assert.ok(capturedPrompt.includes('index.js'));

      // Verify parsed output
      assert.ok(result.sections.purpose.includes('cookie parsing library'));
      assert.ok(result.sections.architecture.includes('(Inference: Suitable for Express'));
      assert.ok(result.sections.importantModules.includes('index.js'));
    });
  });

  describe('storeOverview', () => {
    it('persists overview string to repository document when model provided', async () => {
      let updatedId = null;
      let updatedData = null;

      const MockRepoModel = {
        updateOne: async (query, update) => {
          updatedId = query._id;
          updatedData = update.$set;
          return { modifiedCount: 1 };
        },
      };

      const ok = await storeOverview('repo_123', '# Overview text', {
        RepositoryModel: MockRepoModel,
      });

      assert.equal(ok, true);
      assert.equal(updatedId, 'repo_123');
      assert.equal(updatedData.overview, '# Overview text');
    });

    it('returns false when model or repoId is missing', async () => {
      assert.equal(await storeOverview(null, 'text'), false);
      assert.equal(await storeOverview('repo_123', null), false);
    });
  });

  describe('ask() Broad Query Routing', () => {
    it('routes broad query through overview and tags result as queryType: broad', async () => {
      const mockOverview = `## Purpose\nRepoLens is an AI tool for chatting with GitHub repos.`;
      let capturedSystem = '';
      let capturedPrompt = '';

      const mockStreamFn = async ({ system, prompt, onChunk }) => {
        capturedSystem = system;
        capturedPrompt = prompt;
        onChunk('RepoLens is a code comprehension assistant.');
        return 'RepoLens is a code comprehension assistant.';
      };

      const mockRetrievalFn = async () => [];

      const result = await ask({
        repoId: 'test-repo',
        question: 'What does this project do?',
        overview: mockOverview,
        llmStreamFn: mockStreamFn,
        retrievalFn: mockRetrievalFn,
      });

      assert.equal(result.queryType, 'broad');
      assert.ok(capturedPrompt.includes('REPOSITORY OVERVIEW:'));
      assert.ok(capturedPrompt.includes('RepoLens is an AI tool'));
      assert.ok(result.answer.includes('code comprehension assistant'));
    });

    it('routes specific question through hybrid search and tags result as queryType: specific', async () => {
      const mockRetrievalChunk = {
        chunkId: 'c1',
        filePath: 'auth.js',
        startLine: 1,
        endLine: 10,
        content: 'function verifyAuth() {}',
      };

      let capturedPrompt = '';
      const mockStreamFn = async ({ prompt }) => {
        capturedPrompt = prompt;
        return 'Auth is verified in [auth.js:1-10].';
      };

      const mockRetrievalFn = async () => [mockRetrievalChunk];

      const result = await ask({
        repoId: 'test-repo',
        question: 'How is authentication handled in verifyAuth?',
        overview: 'Some overview',
        llmStreamFn: mockStreamFn,
        retrievalFn: mockRetrievalFn,
      });

      assert.equal(result.queryType, 'specific');
      assert.ok(capturedPrompt.includes('RECOVERED CODE CONTEXT:'));
      assert.ok(result.citations.length === 1);
      assert.equal(result.citations[0].filePath, 'auth.js');
    });
  });
});
