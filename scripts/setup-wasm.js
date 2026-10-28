import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const wasmDestDir = path.join(rootDir, 'wasm');

const REQUIRED_GRAMMARS = [
  'tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-python.wasm',
];

export async function setupWasm() {
  const nodeModulesDir = path.join(rootDir, 'node_modules');
  const webTreeSitterPkg = path.join(nodeModulesDir, 'web-tree-sitter');
  const treeSitterWasmsPkg = path.join(nodeModulesDir, 'tree-sitter-wasms');

  if (!fs.existsSync(webTreeSitterPkg) || !fs.existsSync(treeSitterWasmsPkg)) {
    console.error(
      '[setup:wasm] Error: Required packages "web-tree-sitter" or "tree-sitter-wasms" are not installed.\n' +
        'Please run: npm install'
    );
    process.exit(1);
  }

  // Ensure wasm/ destination directory exists
  if (!fs.existsSync(wasmDestDir)) {
    fs.mkdirSync(wasmDestDir, { recursive: true });
  }

  // 1. Copy core tree-sitter.wasm runtime
  const coreWasmSrc = path.join(webTreeSitterPkg, 'tree-sitter.wasm');
  const coreWasmDest = path.join(wasmDestDir, 'tree-sitter.wasm');

  if (!fs.existsSync(coreWasmSrc)) {
    console.error(`[setup:wasm] Error: Could not find ${coreWasmSrc}`);
    process.exit(1);
  }
  fs.copyFileSync(coreWasmSrc, coreWasmDest);
  console.log(`[setup:wasm] Copied core runtime: tree-sitter.wasm`);

  // 2. Copy grammar wasms from tree-sitter-wasms/out
  const wasmSrcDir = path.join(treeSitterWasmsPkg, 'out');
  let copiedCount = 1;

  for (const grammar of REQUIRED_GRAMMARS) {
    const srcFile = path.join(wasmSrcDir, grammar);
    const destFile = path.join(wasmDestDir, grammar);

    if (!fs.existsSync(srcFile)) {
      console.error(`[setup:wasm] Error: Could not find grammar at ${srcFile}`);
      process.exit(1);
    }

    fs.copyFileSync(srcFile, destFile);
    console.log(`[setup:wasm] Copied grammar: ${grammar}`);
    copiedCount++;
  }

  console.log(`[setup:wasm] Done! Successfully set up ${copiedCount} WASM files in wasm/`);
}

// Allow direct execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  setupWasm().catch((err) => {
    console.error('[setup:wasm] Failed:', err);
    process.exit(1);
  });
}
