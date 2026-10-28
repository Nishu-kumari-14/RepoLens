/**
 * Context builder for LLM generation.
 *
 * Responsibilities:
 * - Deduplicates overlapping chunks within the same file.
 * - Groups chunks by file path and sorts by line number.
 * - Enforces token budget (~4 characters per token heuristic).
 * - Formats code context with clear file and line demarcation.
 */

const DEFAULT_MAX_TOKENS = 3500;
const CHARS_PER_TOKEN = 4;

/**
 * Deduplicates overlapping or redundant chunks from the same file.
 * If chunk B is fully contained within chunk A, chunk B is dropped.
 *
 * @param {Array<object>} chunks
 * @returns {Array<object>}
 */
export function deduplicateChunks(chunks = []) {
  if (chunks.length <= 1) return [...chunks];

  // Group by filePath
  const byFile = new Map();
  for (const chunk of chunks) {
    const list = byFile.get(chunk.filePath) || [];
    list.push(chunk);
    byFile.set(chunk.filePath, list);
  }

  const result = [];

  for (const [filePath, fileChunks] of byFile.entries()) {
    // Sort by startLine ascending, then endLine descending
    fileChunks.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return b.endLine - a.endLine;
    });

    const kept = [];
    for (const chunk of fileChunks) {
      // Check if current chunk is covered by any already-kept chunk
      const isRedundant = kept.some(
        (existing) =>
          existing.startLine <= chunk.startLine && existing.endLine >= chunk.endLine
      );
      if (!isRedundant) {
        kept.push(chunk);
      }
    }
    result.push(...kept);
  }

  return result;
}

/**
 * Builds the LLM prompt context string from retrieved chunks and optional file tree.
 *
 * @param {Array<object>} chunks
 * @param {object} [options]
 * @param {Array<string>} [options.fileTree] Optional list of repository relative paths
 * @param {number} [options.maxTokens=3500]
 * @returns {{ contextText: string, includedChunks: Array<object>, tokenEstimate: number }}
 */
export function buildContext(chunks = [], options = {}) {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const fileTree = options.fileTree || [];

  // 1. Deduplicate
  const deduped = deduplicateChunks(chunks);

  // 2. Sort by filePath then startLine
  deduped.sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return a.startLine - b.startLine;
  });

  const sections = [];
  let currentChars = 0;

  // 3. Compact file tree header if available
  if (fileTree.length > 0) {
    const treeHeader = `[REPOSITORY FILE TREE]\n${fileTree.slice(0, 100).join('\n')}\n\n`;
    sections.push(treeHeader);
    currentChars += treeHeader.length;
  }

  // 4. Append chunks respecting character budget
  const includedChunks = [];

  for (const chunk of deduped) {
    const symbolInfo = chunk.symbol ? ` | Symbol: ${chunk.symbol}` : '';
    const parentInfo = chunk.parent ? ` (Parent: ${chunk.parent})` : '';
    const header = `--- File: ${chunk.filePath} (Lines ${chunk.startLine}-${chunk.endLine})${symbolInfo}${parentInfo} ---\n`;
    const body = `${chunk.content}\n\n`;
    const chunkBlock = header + body;

    if (currentChars + chunkBlock.length > maxChars && includedChunks.length > 0) {
      // Budget reached; stop packing further chunks
      break;
    }

    sections.push(chunkBlock);
    currentChars += chunkBlock.length;
    includedChunks.push(chunk);
  }

  const contextText = sections.join('');
  const tokenEstimate = Math.ceil(currentChars / CHARS_PER_TOKEN);

  return {
    contextText,
    includedChunks,
    tokenEstimate,
  };
}
