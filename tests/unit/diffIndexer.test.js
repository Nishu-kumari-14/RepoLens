import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  affectsOverview,
  refreshRepo,
} from '../../src/ingestion/diffIndexer.js';

describe('Milestone 7: Incremental Indexing (diffIndexer)', () => {
  describe('affectsOverview', () => {
    it('returns true when manifests, READMEs, or entry points are changed', () => {
      assert.equal(affectsOverview(['README.md']), true);
      assert.equal(affectsOverview(['package.json']), true);
      assert.equal(affectsOverview(['src/index.js']), true);
      assert.equal(affectsOverview(['docs/README.txt']), true);
      assert.equal(affectsOverview(['src/utils/math.js', 'package.json']), true);
    });

    it('returns false when only internal or non-manifest files are changed', () => {
      assert.equal(affectsOverview(['src/utils/math.js']), false);
      assert.equal(affectsOverview(['tests/unit/auth.test.js']), false);
      assert.equal(affectsOverview([]), false);
    });
  });

  describe('refreshRepo', () => {
    it('returns upToDate: true and exits early when HEAD SHA matches indexedCommitSha', async () => {
      const mockGetLatestCommit = async () => 'sha_12345';
      let compareCalled = false;
      const mockCompare = async () => {
        compareCalled = true;
        return { files: [] };
      };

      const result = await refreshRepo({
        owner: 'test',
        repo: 'repo',
        indexedCommitSha: 'sha_12345',
        adapters: {
          getLatestCommit: mockGetLatestCommit,
          compareCommits: mockCompare,
        },
      });

      assert.equal(result.upToDate, true);
      assert.equal(result.commitSha, 'sha_12345');
      assert.equal(compareCalled, false, 'Compare should not be called when commit matches');
    });

    it('throws when repository has no previous indexedCommitSha', async () => {
      const mockGetLatestCommit = async () => 'sha_new';

      await assert.rejects(
        () =>
          refreshRepo({
            owner: 'test',
            repo: 'repo',
            indexedCommitSha: null,
            adapters: { getLatestCommit: mockGetLatestCommit },
          }),
        /no indexedCommitSha/
      );
    });

    it('performs safe replacement: inserts new chunks before deleting outdated ones', async () => {
      const executionOrder = [];

      const mockGetLatestCommit = async () => 'sha_new_head';
      const mockCompareCommits = async () => ({
        aheadBy: 2,
        files: [
          { filename: 'src/modified.js', status: 'modified' },
          { filename: 'src/new.js', status: 'added' },
          { filename: 'src/removed.js', status: 'removed' },
        ],
      });

      const mockDownloadArchive = async () => Buffer.from('mock-zip');
      const mockExtractZip = async () => ({
        files: [
          { path: 'src/modified.js', content: 'function updated() { return 1; }' },
          { path: 'src/new.js', content: 'function brandNew() { return 2; }' },
        ],
      });

      const mockEmbed = async (texts) => texts.map(() => [0.1, 0.2]);

      const mockUpsertChunks = async (repoId, commitSha, chunks, vectors) => {
        executionOrder.push({ action: 'upsert', count: chunks.length });
      };

      const mockDeleteByFile = async (repoId, filePath) => {
        executionOrder.push({ action: 'delete', file: filePath });
      };

      let overviewRegenerated = false;
      const mockGenerateOverview = async () => {
        overviewRegenerated = true;
        return { rawMarkdown: '## Updated Overview' };
      };

      let repoDocSaved = false;
      const mockRepoDoc = {
        indexedCommitSha: 'sha_old_base',
        save: async () => {
          repoDocSaved = true;
        },
      };

      const result = await refreshRepo({
        owner: 'test',
        repo: 'repo',
        repoDoc: mockRepoDoc,
        adapters: {
          getLatestCommit: mockGetLatestCommit,
          compareCommits: mockCompareCommits,
          downloadRepoArchive: mockDownloadArchive,
          extractZipBuffer: mockExtractZip,
          chunkFile: async ({ filePath, content }) => [
            { filePath, content, startLine: 1, endLine: 10, contentHash: 'h1' },
          ],
          embed: mockEmbed,
          upsertChunks: mockUpsertChunks,
          deleteByFile: mockDeleteByFile,
          generateOverview: mockGenerateOverview,
        },
      });

      assert.equal(result.upToDate, false);
      assert.equal(result.commitSha, 'sha_new_head');
      assert.equal(result.addedFiles, 1);
      assert.equal(result.modifiedFiles, 1);
      assert.equal(result.deletedFiles, 1);
      assert.ok(result.newChunks > 0);

      // Verify SAFE SWAP: upsert was performed before deletes
      const firstUpsertIndex = executionOrder.findIndex((e) => e.action === 'upsert');
      const firstDeleteIndex = executionOrder.findIndex((e) => e.action === 'delete');

      assert.ok(firstUpsertIndex !== -1, 'Upsert must be called');
      assert.ok(firstDeleteIndex !== -1, 'Delete must be called');
      assert.ok(
        firstUpsertIndex < firstDeleteIndex,
        'SAFE SWAP REQUIREMENT: New chunks must be upserted BEFORE old chunks are deleted'
      );

      // Verify deleted files include removed and modified files
      const deletedFiles = executionOrder.filter((e) => e.action === 'delete').map((e) => e.file);
      assert.ok(deletedFiles.includes('src/modified.js'));
      assert.ok(deletedFiles.includes('src/removed.js'));

      // Verify repoDoc updated
      assert.equal(mockRepoDoc.indexedCommitSha, 'sha_new_head');
      assert.equal(repoDocSaved, true);
    });

    it('triggers overview regeneration when README or package.json is modified', async () => {
      const mockGetLatestCommit = async () => 'sha_v2';
      const mockCompareCommits = async () => ({
        aheadBy: 1,
        files: [{ filename: 'package.json', status: 'modified' }],
      });

      const mockDownloadArchive = async () => Buffer.from('mock-zip');
      const mockExtractZip = async () => ({
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({ name: 'updated-pkg', version: '2.0.0' }),
          },
        ],
      });

      let overviewCalled = false;
      const mockGenerateOverview = async () => {
        overviewCalled = true;
        return { rawMarkdown: '## Regenerated Overview' };
      };

      const mockRepoDoc = {
        indexedCommitSha: 'sha_v1',
        overview: 'old overview',
        save: async () => {},
      };

      const result = await refreshRepo({
        owner: 'test',
        repo: 'repo',
        repoDoc: mockRepoDoc,
        adapters: {
          getLatestCommit: mockGetLatestCommit,
          compareCommits: mockCompareCommits,
          downloadRepoArchive: mockDownloadArchive,
          extractZipBuffer: mockExtractZip,
          embed: async (texts) => texts.map(() => [0.1]),
          upsertChunks: async () => {},
          deleteByFile: async () => {},
          generateOverview: mockGenerateOverview,
        },
      });

      assert.equal(overviewCalled, true);
      assert.equal(result.overviewRegenerated, true);
      assert.equal(mockRepoDoc.overview, '## Regenerated Overview');
    });
  });
});
