/**
 * LanceDB vector store adapter.
 *
 * Interface:
 *   upsertChunks(repoId, commitSha, chunks, vectors)
 *   deleteByRepo(repoId)
 *   deleteByFile(repoId, filePath)
 *   vectorSearch(repoId, queryVector, topK)
 *   keywordSearch(repoId, queryText, topK)
 *   existingHashes(repoId)    → Set of "filePath::contentHash" already stored
 *
 * Schema (matches ARCHITECTURE.md §5):
 *   chunkId, repositoryId, commitSha, filePath, language, symbol, symbolKind,
 *   parent, startLine, endLine, content, contentHash, vector
 *
 * Full-text index is built/refreshed over (content, symbol, filePath).
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect as connectLance, Index } from '@lancedb/lancedb';
import { config } from '../config/env.js';

const TABLE_NAME = 'chunks';

// Module-level LanceDB connection cache
const _dbCache = new Map(); // dataDir → db instance
const _tableCache = new Map(); // dataDir → table instance

// ─── Connection helpers ───────────────────────────────────────────────────────

async function getDb(dataDir) {
  if (_dbCache.has(dataDir)) return _dbCache.get(dataDir);
  const db = await connectLance(dataDir);
  _dbCache.set(dataDir, db);
  return db;
}

async function getTable(dataDir, embeddingDimension) {
  const cacheKey = dataDir;
  if (_tableCache.has(cacheKey)) return _tableCache.get(cacheKey);

  const db = await getDb(dataDir);
  const tableNames = await db.tableNames();

  let table = null;
  if (tableNames.includes(TABLE_NAME)) {
    try {
      table = await db.openTable(TABLE_NAME);
    } catch (err) {
      // Self-heal: table directory exists on disk but is unreadable/corrupted (missing manifest)
      console.warn(`[vectorStore] Failed to open table '${TABLE_NAME}', cleaning and recreating:`, err.message);
      try {
        await db.dropTable(TABLE_NAME);
      } catch {
        const tablePath = path.join(dataDir, `${TABLE_NAME}.lance`);
        if (fs.existsSync(tablePath)) {
          fs.rmSync(tablePath, { recursive: true, force: true });
        }
      }
      table = null;
    }
  }

  if (!table) {
    // Create with a seed row so the schema (including vector dimension) is fixed.
    const dim = embeddingDimension || config.embedding.dimension || 768;
    const seedRow = makeSeedRow(dim);
    table = await db.createTable(TABLE_NAME, [seedRow]);
    // Delete the seed row immediately
    await table.delete(`chunkId = '__seed__'`);
    // Full-text index over content
    try {
      if (Index?.fts) {
        await table.createIndex('content', { config: Index.fts() });
      }
    } catch {
      // FTS index optional or built on rows
    }
  }

  _tableCache.set(cacheKey, table);
  return table;
}

function makeSeedRow(dim) {
  return {
    chunkId: '__seed__',
    repositoryId: '__seed__',
    commitSha: '',
    filePath: '',
    language: '',
    symbol: '',
    symbolKind: '',
    parent: '',
    startLine: 0,
    endLine: 0,
    content: '',
    contentHash: '',
    vector: new Array(dim).fill(0),
  };
}

/** For tests: clear module-level caches so each test gets a fresh connection. */
export function _clearCaches() {
  _dbCache.clear();
  _tableCache.clear();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns a Set of "filePath::contentHash" strings for chunks already stored
 * under the given repositoryId. Used for deduplication before embedding.
 *
 * @param {string} repoId
 * @param {string} [dataDir]
 * @returns {Promise<Set<string>>}
 */
export async function existingHashes(repoId, dataDir) {
  const dir = dataDir || config.paths.lancedbDataDir;
  let table;
  try {
    table = await getTable(dir);
  } catch {
    return new Set();
  }

  try {
    const rows = await table
      .query()
      .where(`repositoryId = '${escapeStr(repoId)}'`)
      .select(['filePath', 'contentHash'])
      .toArray();

    const out = new Set();
    for (const row of rows) {
      out.add(`${row.filePath}::${row.contentHash}`);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Upserts chunks into LanceDB.  Existing rows with the same chunkId are
 * replaced (LanceDB merge-insert pattern: delete-then-insert by chunkId).
 *
 * @param {string}   repoId
 * @param {string}   commitSha
 * @param {object[]} chunks        Output from chunker.js
 * @param {number[][]} vectors     Parallel array of embedding vectors
 * @param {string}   [dataDir]
 */
export async function upsertChunks(repoId, commitSha, chunks, vectors, dataDir) {
  if (!chunks || chunks.length === 0) return;
  const dir = dataDir || config.paths.lancedbDataDir;
  const dim = vectors[0]?.length || config.embedding.dimension || 768;
  const table = await getTable(dir, dim);

  const rows = chunks.map((chunk, i) => ({
    chunkId: `${repoId}:${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`,
    repositoryId: repoId,
    commitSha,
    filePath: chunk.filePath,
    language: chunk.language || '',
    symbol: chunk.symbol || '',
    symbolKind: chunk.symbolKind || '',
    parent: chunk.parent || '',
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    contentHash: chunk.contentHash,
    vector: Array.from(vectors[i]),
  }));

  // Delete existing rows for these chunkIds first (upsert via delete+insert)
  const ids = rows.map((r) => `'${escapeStr(r.chunkId)}'`).join(',');
  try {
    await table.delete(`chunkId IN (${ids})`);
  } catch { /* table may be empty */ }

  await table.add(rows);

  // Build/refresh FTS index after inserting chunks
  try {
    if (Index?.fts) {
      await table.createIndex('content', { config: Index.fts(), replace: true });
    }
  } catch {
    // Non-fatal if index creation fails or exists
  }
}

/**
 * Deletes all chunks for a repository (full re-index).
 *
 * @param {string} repoId
 * @param {string} [dataDir]
 */
export async function deleteByRepo(repoId, dataDir) {
  const dir = dataDir || config.paths.lancedbDataDir;
  try {
    const table = await getTable(dir);
    await table.delete(`repositoryId = '${escapeStr(repoId)}'`);
  } catch { /* table doesn't exist yet */ }
}

/**
 * Deletes all chunks for a specific file within a repository
 * (used in incremental updates).
 *
 * @param {string} repoId
 * @param {string} filePath
 * @param {string} [dataDir]
 */
export async function deleteByFile(repoId, filePath, dataDir) {
  const dir = dataDir || config.paths.lancedbDataDir;
  try {
    const table = await getTable(dir);
    await table.delete(
      `repositoryId = '${escapeStr(repoId)}' AND filePath = '${escapeStr(filePath)}'`
    );
  } catch { /* table doesn't exist yet */ }
}

/**
 * Vector similarity search, filtered to a single repository.
 *
 * @param {string}   repoId
 * @param {number[]} queryVector
 * @param {number}   [topK=20]
 * @param {string}   [dataDir]
 * @returns {Promise<object[]>}
 */
export async function vectorSearch(repoId, queryVector, topK = 20, dataDir) {
  const dir = dataDir || config.paths.lancedbDataDir;
  try {
    const table = await getTable(dir);

    const results = await table
      .vectorSearch(queryVector)
      .where(`repositoryId = '${escapeStr(repoId)}'`)
      .limit(topK)
      .toArray();

    return results;
  } catch (err) {
    if (err.message?.includes('not found') || err.message?.includes('Not found')) {
      return [];
    }
    throw err;
  }
}

/**
 * Full-text (BM25) search over content, filtered to a single repository.
 *
 * @param {string} repoId
 * @param {string} queryText
 * @param {number} [topK=20]
 * @param {string} [dataDir]
 * @returns {Promise<object[]>}
 */
export async function keywordSearch(repoId, queryText, topK = 20, dataDir) {
  const dir = dataDir || config.paths.lancedbDataDir;
  try {
    const table = await getTable(dir);

    const results = await table
      .search(queryText)
      .where(`repositoryId = '${escapeStr(repoId)}'`)
      .limit(topK)
      .toArray();

    return results;
  } catch (err) {
    if (err.message?.includes('not found') || err.message?.includes('Not found')) {
      return [];
    }
    // Graceful fallback if FTS index is missing or corrupted
    try {
      const table = await getTable(dir);
      const cleanTerm = escapeStr(queryText.slice(0, 50));
      return await table
        .query()
        .where(`repositoryId = '${escapeStr(repoId)}' AND content LIKE '%${cleanTerm}%'`)
        .limit(topK)
        .toArray();
    } catch {
      return [];
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Escape single quotes in filter strings to prevent injection. */
function escapeStr(s) {
  return String(s).replace(/'/g, "''");
}
