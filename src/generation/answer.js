/**
 * Question answering engine for RepoLens.
 *
 * Coordinates:
 *   hybrid retrieval -> context building -> LLM generation -> citation validation -> db persistence
 */
import { hybridSearch } from '../retrieval/hybridSearch.js';
import { buildContext } from '../retrieval/contextBuilder.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildBroadUserPrompt } from './prompts.js';
import { generateStream, generate } from '../adapters/llm.js';

// Regex patterns indicating a broad or architectural query
const BROAD_QUERY_PATTERNS = [
  /\bwhat does this (repo|repository|project|codebase|application|package) do\b/i,
  /\b(overview|high[- ]level summary|architecture|tech stack)\b/i,
  /\bexplain (the )?(entire |whole )?(project|repo|codebase|system|architecture)\b/i,
  /\bexplain (the )?(folder|directory|project) structure\b/i,
  /\bhow is this (project|repo|codebase) (structured|organized)\b/i,
  /\b(main purpose|summary of the project)\b/i,
];

/**
 * Classifies a user question as either 'broad' or 'specific'.
 * Cheap, rule-based classifier avoiding LLM latency and cost.
 *
 * @param {string} question
 * @returns {'broad' | 'specific'}
 */
export function classifyQuery(question = '') {
  if (!question || typeof question !== 'string') return 'specific';
  const clean = question.trim();

  for (const pattern of BROAD_QUERY_PATTERNS) {
    if (pattern.test(clean)) {
      return 'broad';
    }
  }

  return 'specific';
}

// Regex matching citations in the form: [path/to/file.js:12-34]
export const CITATION_REGEX = /\[([^:\]\s]+):(\d+)-(\d+)\]/g;

/**
 * Extracts all citation references from an answer string.
 *
 * @param {string} text
 * @returns {Array<{ raw: string, filePath: string, startLine: number, endLine: number }>}
 */
export function extractCitations(text = '') {
  const citations = [];
  const matches = text.matchAll(CITATION_REGEX);

  for (const match of matches) {
    const [raw, filePath, startStr, endStr] = match;
    citations.push({
      raw,
      filePath: filePath.trim(),
      startLine: parseInt(startStr, 10),
      endLine: parseInt(endStr, 10),
    });
  }

  return citations;
}

/**
 * Validates extracted citations against the retrieved chunk set.
 * DROPS any citation that was not actually present in the retrieved chunks.
 *
 * @param {Array<object>} extractedCitations
 * @param {Array<object>} retrievedChunks
 * @returns {Array<object>} Filtered list of verified citations
 */
export function validateCitations(extractedCitations = [], retrievedChunks = []) {
  const verified = [];
  const seenKeys = new Set();

  for (const citation of extractedCitations) {
    // A citation is valid if at least one retrieved chunk covers the same file
    // and overlaps with the cited line range.
    const matchingChunk = retrievedChunks.find((chunk) => {
      const sameFile =
        chunk.filePath === citation.filePath ||
        chunk.filePath.endsWith('/' + citation.filePath) ||
        citation.filePath.endsWith('/' + chunk.filePath);

      if (!sameFile) return false;

      // Overlap condition: max(startA, startB) <= min(endA, endB)
      const maxStart = Math.max(chunk.startLine, citation.startLine);
      const minEnd = Math.min(chunk.endLine, citation.endLine);
      return maxStart <= minEnd;
    });

    if (matchingChunk) {
      const key = `${citation.filePath}:${citation.startLine}-${citation.endLine}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        verified.push({
          filePath: matchingChunk.filePath, // Normalized to real chunk path
          startLine: citation.startLine,
          endLine: citation.endLine,
          symbol: matchingChunk.symbol || null,
        });
      }
    }
  }

  return verified;
}

/**
 * Answers a question about a repository using hybrid retrieval and grounded generation.
 *
 * @param {object} params
 * @param {string} params.repoId
 * @param {string} params.question
 * @param {string} [params.sessionId]
 * @param {string} [params.overview] Optional stored repository overview
 * @param {string} [params.lancedbDataDir]
 * @param {Function} [params.onToken] Callback for streaming answer tokens
 * @param {Function} [params.llmStreamFn] Optional override for testing
 * @param {Function} [params.retrievalFn] Optional override for testing
 * @returns {Promise<{ answer: string, citations: Array<object>, retrievedChunks: Array<object>, queryType: string }>}
 */
export async function ask({
  repoId,
  question,
  sessionId = null,
  overview = null,
  lancedbDataDir,
  onToken = () => {},
  llmStreamFn = generateStream,
  retrievalFn = hybridSearch,
}) {
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('Question must be a non-empty string');
  }

  const cleanQuestion = question.trim();
  const queryType = classifyQuery(cleanQuestion);

  // 1. Hybrid Retrieval (Vector + BM25 + RRF)
  const retrievedChunks = await retrievalFn({
    repoId,
    query: cleanQuestion,
    lancedbDataDir,
  });

  // 2. Build context respecting token budget & deduplicating overlapping ranges
  const { contextText, includedChunks } = buildContext(retrievedChunks);

  // 3. Assemble prompt based on classification and available overview
  let userPrompt;
  if (queryType === 'broad' && overview) {
    userPrompt = buildBroadUserPrompt(cleanQuestion, overview, contextText);
  } else {
    userPrompt = buildUserPrompt(cleanQuestion, contextText);
  }

  // 4. Stream answer from LLM
  let answer = '';
  try {
    answer = await llmStreamFn({
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      onChunk: onToken,
    });
  } catch (err) {
    throw new Error(`Answer generation failed: ${err.message}`);
  }

  // 5. Extract and strictly validate citations against the retrieved chunks
  const extracted = extractCitations(answer);
  const validated = validateCitations(extracted, includedChunks);

  // 6. Persist exchange to MongoDB if session provided
  if (sessionId) {
    try {
      const { Message } = await import('../db/models.js');
      await Message.create([
        {
          sessionId,
          repositoryId: repoId,
          role: 'user',
          content: cleanQuestion,
          citations: [],
        },
        {
          sessionId,
          repositoryId: repoId,
          role: 'assistant',
          content: answer,
          citations: validated,
        },
      ]);
    } catch {
      // Non-fatal if db is offline or in test environment
    }
  }

  return {
    answer,
    citations: validated,
    retrievedChunks: includedChunks,
    queryType,
  };
}
