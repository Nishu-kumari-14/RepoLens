#!/usr/bin/env node
/**
 * CLI tool: Query an indexed repository with grounded, cited Q&A.
 *
 * Usage:
 *   node scripts/ask.js <repoId> "your question here"
 *
 * Example:
 *   node scripts/ask.js expressjs/cookie-parser "How is authentication handled?"
 */
import { ask } from '../src/generation/answer.js';
import { config } from '../src/config/env.js';

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));

  if (positional.length < 2 || flags.includes('--help') || flags.includes('-h')) {
    console.error('Usage: node scripts/ask.js <repoId> "<question>"');
    console.error('Example: node scripts/ask.js expressjs/cookie-parser "How are signed cookies verified?"');
    process.exit(1);
  }

  const [repoId, question] = positional;

  console.log(`\n======================================================`);
  console.log(` RepoLens Q&A: ${repoId}`);
  console.log(` Question:     ${question}`);
  console.log(`======================================================\n`);

  try {
    process.stdout.write('Answer: ');
    const result = await ask({
      repoId,
      question,
      lancedbDataDir: config.paths.lancedbDataDir,
      onToken: (token) => {
        process.stdout.write(token);
      },
    });

    console.log('\n\n---------------- Verified Citations ----------------');
    if (result.citations.length === 0) {
      console.log('No specific code lines were cited in the answer.');
    } else {
      result.citations.forEach((c, idx) => {
        const symbolStr = c.symbol ? ` [Symbol: ${c.symbol}]` : '';
        console.log(`  [${idx + 1}] ${c.filePath}:${c.startLine}-${c.endLine}${symbolStr}`);
      });
    }

    console.log(`\nRetrieved Chunks: ${result.retrievedChunks.length}`);
    console.log(`======================================================\n`);
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}\n`);
    process.exit(1);
  }
}

main();
