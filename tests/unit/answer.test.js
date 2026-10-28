import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, validateCitations, ask } from '../../src/generation/answer.js';

describe('Milestone 4: Grounded Q&A and Citation Validation', () => {
  it('extracts citations in [filePath:startLine-endLine] format correctly', () => {
    const text = `
Authentication is implemented via verifyToken [src/auth.js:12-45].
Password hashing is handled in [src/utils/hash.js:8-20] using bcrypt.
Multiple citations: [routes/login.js:1-10] and [routes/login.js:15-30].
`;

    const extracted = extractCitations(text);
    assert.equal(extracted.length, 4);

    assert.equal(extracted[0].filePath, 'src/auth.js');
    assert.equal(extracted[0].startLine, 12);
    assert.equal(extracted[0].endLine, 45);

    assert.equal(extracted[1].filePath, 'src/utils/hash.js');
    assert.equal(extracted[1].startLine, 8);
    assert.equal(extracted[1].endLine, 20);

    assert.equal(extracted[2].filePath, 'routes/login.js');
    assert.equal(extracted[2].startLine, 1);
    assert.equal(extracted[2].endLine, 10);
  });

  it('drops hallucinated citations for files not present in retrieved chunks', () => {
    const retrievedChunks = [
      { filePath: 'src/real.js', startLine: 1, endLine: 50, symbol: 'realFunc' },
    ];

    const extracted = [
      { raw: '[src/real.js:10-20]', filePath: 'src/real.js', startLine: 10, endLine: 20 },
      { raw: '[src/fake.js:1-15]', filePath: 'src/fake.js', startLine: 1, endLine: 15 }, // Hallucination!
    ];

    const validated = validateCitations(extracted, retrievedChunks);

    assert.equal(validated.length, 1);
    assert.equal(validated[0].filePath, 'src/real.js');
    assert.equal(validated[0].startLine, 10);
    assert.equal(validated[0].endLine, 20);
    assert.equal(validated[0].symbol, 'realFunc');
  });

  it('drops citations whose line numbers do not overlap with retrieved chunks', () => {
    const retrievedChunks = [
      { filePath: 'src/service.js', startLine: 10, endLine: 30, symbol: 'serve' },
    ];

    const extracted = [
      { raw: '[src/service.js:15-25]', filePath: 'src/service.js', startLine: 15, endLine: 25 }, // Valid overlap
      { raw: '[src/service.js:90-110]', filePath: 'src/service.js', startLine: 90, endLine: 110 }, // Out of bounds!
    ];

    const validated = validateCitations(extracted, retrievedChunks);

    assert.equal(validated.length, 1);
    assert.equal(validated[0].startLine, 15);
    assert.equal(validated[0].endLine, 25);
  });

  it('ask() integrates hybrid retrieval, streaming, and citation validation', async () => {
    const mockRetrievedChunks = [
      {
        filePath: 'src/auth.js',
        startLine: 10,
        endLine: 40,
        symbol: 'authenticateUser',
        content: 'export function authenticateUser(token) { return jwt.verify(token); }',
      },
    ];

    const mockTokens = [];
    const fakeLlmStream = async ({ prompt, onChunk }) => {
      const response =
        'Authentication is handled by authenticateUser in [src/auth.js:10-40]. It verifies the JWT token.';
      for (const word of response.split(' ')) {
        onChunk(word + ' ');
        mockTokens.push(word);
      }
      return response;
    };

    const fakeRetrieval = async () => mockRetrievedChunks;

    const result = await ask({
      repoId: 'test-repo',
      question: 'How is authentication handled?',
      llmStreamFn: fakeLlmStream,
      retrievalFn: fakeRetrieval,
      onToken: (tok) => {},
    });

    assert.ok(result.answer.includes('authenticateUser'));
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].filePath, 'src/auth.js');
    assert.equal(result.citations[0].startLine, 10);
    assert.equal(result.citations[0].endLine, 40);
    assert.ok(mockTokens.length > 0, 'Tokens should have been streamed');
  });

  it('ask() handles unanswerable questions with insufficient context response', async () => {
    // When no relevant chunks are found for an unanswerable question
    const fakeRetrieval = async () => [];

    const fakeLlmStream = async () => {
      return 'The provided code context is insufficient to answer this question. No database or migration files were found in the context.';
    };

    const result = await ask({
      repoId: 'test-repo',
      question: 'How are database migrations configured?',
      llmStreamFn: fakeLlmStream,
      retrievalFn: fakeRetrieval,
    });

    assert.ok(
      result.answer.includes('insufficient to answer this question') ||
        result.answer.includes('insufficient')
    );
    assert.equal(result.citations.length, 0);
  });
});
