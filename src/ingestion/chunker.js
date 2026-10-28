import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { INGESTION_LIMITS } from '../config/constants.js';

let ParserClass = null;
const loadedLanguages = new Map();
let isParserInitialized = false;
let parserInitError = null;

/**
 * Initializes web-tree-sitter runtime once.
 * Never throws; stores error and falls back gracefully.
 */
export async function initParser(wasmDir = path.resolve(process.cwd(), 'wasm')) {
  if (isParserInitialized) return true;
  if (parserInitError) return false;

  try {
    const webTreeSitterModule = await import('web-tree-sitter');
    ParserClass = webTreeSitterModule.default || webTreeSitterModule;

    const coreWasmPath = path.join(wasmDir, 'tree-sitter.wasm');
    if (!fs.existsSync(coreWasmPath)) {
      parserInitError = new Error(
        `[chunker] Core WASM runtime not found at ${coreWasmPath}. Run "npm run setup:wasm" first.`
      );
      console.warn(parserInitError.message);
      return false;
    }

    await ParserClass.init({
      locateFile(scriptName) {
        return path.join(wasmDir, scriptName);
      },
    });

    isParserInitialized = true;
    return true;
  } catch (err) {
    parserInitError = err;
    console.warn(`[chunker] Failed to initialize web-tree-sitter: ${err.message}. Using line-window fallback.`);
    return false;
  }
}

/**
 * Loads a tree-sitter language grammar WASM.
 * Returns null if not found or incompatible.
 */
export async function loadLanguage(languageName, wasmDir = path.resolve(process.cwd(), 'wasm')) {
  if (loadedLanguages.has(languageName)) {
    return loadedLanguages.get(languageName);
  }

  const initialized = await initParser(wasmDir);
  if (!initialized || !ParserClass) return null;

  const grammarFileName = `tree-sitter-${languageName}.wasm`;
  const grammarPath = path.join(wasmDir, grammarFileName);

  if (!fs.existsSync(grammarPath)) {
    console.warn(
      `[chunker] Grammar WASM not found at ${grammarPath}. Run "npm run setup:wasm" to install.`
    );
    return null;
  }

  try {
    const lang = await ParserClass.Language.load(grammarPath);
    loadedLanguages.set(languageName, lang);
    return lang;
  } catch (err) {
    console.warn(
      `[chunker] Failed to load grammar for ${languageName} (${err.message}). Using fallback.`
    );
    return null;
  }
}

/**
 * Maps a file path to its primary language and tree-sitter grammar name.
 */
export function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return { language: 'javascript', grammar: 'javascript' };
    case '.ts':
      return { language: 'typescript', grammar: 'typescript' };
    case '.tsx':
      return { language: 'tsx', grammar: 'tsx' };
    case '.py':
    case '.pyw':
      return { language: 'python', grammar: 'python' };
    case '.md':
    case '.markdown':
      return { language: 'markdown', grammar: null };
    default:
      return { language: 'plain', grammar: null };
  }
}

/**
 * Computes sha256 hash of content string.
 */
export function computeHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Formats a chunk object adhering strictly to the architecture specifications.
 */
export function createChunk({
  filePath,
  language,
  symbol,
  symbolKind,
  parent = null,
  startLine,
  endLine,
  content,
}) {
  const parentPart = parent ? ` | Parent: ${parent}` : '';
  const embeddingText = `File: ${filePath} | Symbol: ${symbol}${parentPart} | Language: ${language}\n\n${content}`;

  return {
    filePath,
    language,
    symbol,
    symbolKind,
    parent,
    startLine,
    endLine,
    content,
    embeddingText,
    contentHash: computeHash(content),
  };
}

/**
 * Splits oversized chunks (by characters or lines) into sub-chunks,
 * strictly keeping the chunk under limits while preserving the original symbol and parent.
 */
export function splitOversizedChunk(chunk, limits = INGESTION_LIMITS) {
  const maxChars = limits.CHUNK_MAX_CHARACTERS || 1500;
  const maxLines = limits.CHUNK_MAX_LINES || 80;

  const lines = chunk.content.split('\n');
  if (chunk.content.length <= maxChars && lines.length <= maxLines) {
    return [chunk];
  }

  const subChunks = [];
  let chunkIdx = 1;
  let currentStart = 0;

  while (currentStart < lines.length) {
    let currentEnd = currentStart;
    let charCount = 0;

    while (
      currentEnd < lines.length &&
      currentEnd - currentStart < maxLines &&
      charCount + lines[currentEnd].length + 1 <= maxChars
    ) {
      charCount += lines[currentEnd].length + 1;
      currentEnd++;
    }

    if (currentEnd === currentStart) {
      currentEnd = currentStart + 1;
    }

    const sliceLines = lines.slice(currentStart, currentEnd);
    const sliceContent = sliceLines.join('\n');
    const startLine = chunk.startLine + currentStart;
    const endLine = chunk.startLine + currentEnd - 1;

    subChunks.push(
      createChunk({
        filePath: chunk.filePath,
        language: chunk.language,
        symbol: `${chunk.symbol} (part ${chunkIdx})`,
        symbolKind: chunk.symbolKind,
        parent: chunk.parent,
        startLine,
        endLine,
        content: sliceContent,
      })
    );

    chunkIdx++;
    if (currentEnd >= lines.length) break;

    const overlap = limits.FALLBACK_OVERLAP_LINES || 5;
    const actualOverlap = Math.min(overlap, Math.floor((currentEnd - currentStart) / 2));
    currentStart = Math.max(currentStart + 1, currentEnd - actualOverlap);
  }

  return subChunks.length > 0 ? subChunks : [chunk];
}

/**
 * Fallback chunker using sliding line windows with overlap.
 * Safe for any file type, syntax errors, or missing grammars.
 */
export function chunkByLineWindow(content, filePath, language = 'plain', limits = INGESTION_LIMITS) {
  if (!content || content.trim().length === 0) {
    return [];
  }

  const lines = content.split('\n');
  const totalLines = lines.length;
  const windowLines = limits.FALLBACK_WINDOW_LINES || 60;
  const overlap = limits.FALLBACK_OVERLAP_LINES || 10;
  const step = Math.max(1, windowLines - overlap);

  const chunks = [];
  for (let i = 0; i < totalLines; i += step) {
    const slice = lines.slice(i, i + windowLines);
    if (slice.length === 0) break;

    const startLine = i + 1; // 1-based inclusive
    const endLine = Math.min(i + slice.length, totalLines);
    const chunkText = slice.join('\n');

    chunks.push(
      createChunk({
        filePath,
        language,
        symbol: `lines_${startLine}-${endLine}`,
        symbolKind: 'text',
        parent: null,
        startLine,
        endLine,
        content: chunkText,
      })
    );

    if (i + windowLines >= totalLines) break;
  }

  return chunks;
}

/**
 * Chunks markdown files by heading sections (#, ##, ###, etc.).
 */
export function chunkMarkdown(content, filePath, limits = INGESTION_LIMITS) {
  if (!content || content.trim().length === 0) return [];

  const lines = content.split('\n');
  const sections = [];
  let currentHeading = null;
  let currentStartLine = 1;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      if (currentLines.length > 0) {
        sections.push({
          symbol: currentHeading || 'preamble',
          symbolKind: currentHeading ? 'heading' : 'module',
          startLine: currentStartLine,
          endLine: i, // 1-based inclusive of previous line
          content: currentLines.join('\n'),
        });
      }
      currentHeading = headingMatch[2].trim();
      currentStartLine = i + 1;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      symbol: currentHeading || 'preamble',
      symbolKind: currentHeading ? 'heading' : 'module',
      startLine: currentStartLine,
      endLine: lines.length,
      content: currentLines.join('\n'),
    });
  }

  const rawChunks = sections.map((sec) =>
    createChunk({
      filePath,
      language: 'markdown',
      symbol: sec.symbol,
      symbolKind: sec.symbolKind,
      parent: null,
      startLine: sec.startLine,
      endLine: sec.endLine,
      content: sec.content,
    })
  );

  return rawChunks.flatMap((c) => splitOversizedChunk(c, limits));
}

/**
 * Extracts AST symbol nodes from JavaScript/TypeScript/TSX.
 */
function extractJsNodes(node, sourceLines) {
  const symbols = [];

  function getIdentifierName(n) {
    if (!n) return null;
    const nameNode = n.childForFieldName ? n.childForFieldName('name') : null;
    if (nameNode) return nameNode.text;
    return null;
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    const type = child.type;

    // 1. Function declaration
    if (type === 'function_declaration' || type === 'generator_function_declaration') {
      const name = getIdentifierName(child) || 'anonymous_function';
      symbols.push({
        node: child,
        symbol: name,
        symbolKind: 'function',
        parent: null,
      });
      continue;
    }

    // 2. Class declaration
    if (type === 'class_declaration') {
      const className = getIdentifierName(child) || 'AnonymousClass';
      const body = child.childForFieldName('body');
      const startLine = child.startPosition.row + 1;
      const endLine = child.endPosition.row + 1;
      const isLarge = (endLine - startLine > 20) || (body && body.namedChildCount > 1);

      if (isLarge && body) {
        // Collect class header (up to first method)
        let firstMethodStart = endLine;
        const methods = [];

        for (let j = 0; j < body.namedChildCount; j++) {
          const member = body.namedChild(j);
          if (member.type === 'method_definition') {
            const methodName = getIdentifierName(member) || `method_${j + 1}`;
            methods.push({
              node: member,
              symbol: methodName,
              symbolKind: 'method',
              parent: className,
            });
            if (member.startPosition.row + 1 < firstMethodStart) {
              firstMethodStart = member.startPosition.row + 1;
            }
          }
        }

        // Add class header chunk if there are lines before the first method
        if (firstMethodStart > startLine) {
          symbols.push({
            virtual: true,
            startLine,
            endLine: firstMethodStart - 1,
            symbol: className,
            symbolKind: 'class',
            parent: null,
          });
        }
        symbols.push(...methods);
      } else {
        symbols.push({
          node: child,
          symbol: className,
          symbolKind: 'class',
          parent: null,
        });
      }
      continue;
    }

    // 3. Export statements (e.g. export const foo = () => {}, export function foo() {})
    if (type === 'export_statement') {
      const decl = child.childForFieldName('declaration');
      if (decl) {
        if (decl.type === 'function_declaration') {
          const name = getIdentifierName(decl) || 'exported_function';
          symbols.push({
            node: child,
            symbol: name,
            symbolKind: 'function',
            parent: null,
          });
          continue;
        }
        if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
          for (let d = 0; d < decl.namedChildCount; d++) {
            const declarator = decl.namedChild(d);
            if (declarator.type === 'variable_declarator') {
              const value = declarator.childForFieldName('value');
              if (value && (value.type === 'arrow_function' || value.type === 'function')) {
                const name = getIdentifierName(declarator) || 'arrow_function';
                symbols.push({
                  node: child,
                  symbol: name,
                  symbolKind: 'function',
                  parent: null,
                });
              }
            }
          }
          continue;
        }
        if (decl.type === 'class_declaration') {
          const className = getIdentifierName(decl) || 'ExportedClass';
          symbols.push({
            node: child,
            symbol: className,
            symbolKind: 'class',
            parent: null,
          });
          continue;
        }
      }
    }

    // 4. Variable declaration holding function (const foo = () => {})
    if (type === 'lexical_declaration' || type === 'variable_declaration') {
      for (let d = 0; d < child.namedChildCount; d++) {
        const declarator = child.namedChild(d);
        if (declarator.type === 'variable_declarator') {
          const value = declarator.childForFieldName('value');
          if (value && (value.type === 'arrow_function' || value.type === 'function')) {
            const name = getIdentifierName(declarator) || 'arrow_function';
            symbols.push({
              node: child,
              symbol: name,
              symbolKind: 'function',
              parent: null,
            });
          }
        }
      }
    }
  }

  return symbols;
}

/**
 * Extracts AST symbol nodes from Python.
 */
function extractPythonNodes(node, sourceLines) {
  const symbols = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    const type = child.type;

    if (type === 'function_definition') {
      const name = child.childForFieldName('name')?.text || 'function';
      symbols.push({
        node: child,
        symbol: name,
        symbolKind: 'function',
        parent: null,
      });
      continue;
    }

    if (type === 'class_definition') {
      const className = child.childForFieldName('name')?.text || 'Class';
      const body = child.childForFieldName('body');
      const startLine = child.startPosition.row + 1;
      const endLine = child.endPosition.row + 1;
      const isLarge = (endLine - startLine > 20) || (body && body.namedChildCount > 1);

      if (isLarge && body) {
        let firstMethodStart = endLine;
        const methods = [];

        for (let j = 0; j < body.namedChildCount; j++) {
          const member = body.namedChild(j);
          if (member.type === 'function_definition') {
            const methodName = member.childForFieldName('name')?.text || `method_${j + 1}`;
            methods.push({
              node: member,
              symbol: methodName,
              symbolKind: 'method',
              parent: className,
            });
            if (member.startPosition.row + 1 < firstMethodStart) {
              firstMethodStart = member.startPosition.row + 1;
            }
          }
        }

        if (firstMethodStart > startLine) {
          symbols.push({
            virtual: true,
            startLine,
            endLine: firstMethodStart - 1,
            symbol: className,
            symbolKind: 'class',
            parent: null,
          });
        }
        symbols.push(...methods);
      } else {
        symbols.push({
          node: child,
          symbol: className,
          symbolKind: 'class',
          parent: null,
        });
      }
    }
  }

  return symbols;
}

/**
 * Checks if a range of 1-based lines has any non-empty / non-whitespace content.
 */
function hasNonEmptyLines(sourceLines, startLine, endLine) {
  for (let l = startLine; l <= endLine && l <= sourceLines.length; l++) {
    if (sourceLines[l - 1].trim().length > 0) return true;
  }
  return false;
}

/**
 * Chunks a source code file using AST parsing when available,
 * seamlessly covering preambles, top-level lines, and line fallbacks.
 *
 * Never throws an error.
 */
export async function chunkFile(content, filePath, options = {}) {
  const limits = options.limits || INGESTION_LIMITS;
  const wasmDir = options.wasmDir || path.resolve(process.cwd(), 'wasm');

  if (typeof content !== 'string' || content.trim().length === 0) {
    return [];
  }

  const { language, grammar } = detectLanguage(filePath);

  // Markdown handling
  if (language === 'markdown') {
    return chunkMarkdown(content, filePath, limits);
  }

  // Unsupported languages -> line fallback
  if (!grammar) {
    return chunkByLineWindow(content, filePath, language, limits);
  }

  // Attempt AST chunking
  try {
    const lang = await loadLanguage(grammar, wasmDir);
    if (!lang) {
      return chunkByLineWindow(content, filePath, language, limits);
    }

    const parser = new ParserClass();
    parser.setLanguage(lang);

    const tree = parser.parse(content);
    if (!tree || !tree.rootNode) {
      return chunkByLineWindow(content, filePath, language, limits);
    }

    const sourceLines = content.split('\n');
    const totalLines = sourceLines.length;

    let symbolDescriptors = [];
    if (language === 'python') {
      symbolDescriptors = extractPythonNodes(tree.rootNode, sourceLines);
    } else {
      symbolDescriptors = extractJsNodes(tree.rootNode, sourceLines);
    }

    // If no symbols discovered or root node has syntax error and no symbols
    if (symbolDescriptors.length === 0) {
      return chunkByLineWindow(content, filePath, language, limits);
    }

    // Convert symbol descriptors into resolved line ranges
    const resolvedSymbols = symbolDescriptors.map((desc) => {
      const startLine = desc.virtual ? desc.startLine : desc.node.startPosition.row + 1;
      const endLine = desc.virtual ? desc.endLine : desc.node.endPosition.row + 1;
      const chunkContent = sourceLines.slice(startLine - 1, endLine).join('\n');
      return {
        symbol: desc.symbol,
        symbolKind: desc.symbolKind,
        parent: desc.parent,
        startLine,
        endLine,
        content: chunkContent,
      };
    });

    // Sort symbols by start line
    resolvedSymbols.sort((a, b) => a.startLine - b.startLine);

    // Assemble final chunks with module preamble / gaps covered
    const allChunks = [];
    let currentLine = 1;

    function addGapChunk(gapStart, gapEnd, isPreamble) {
      let first = -1;
      let last = -1;
      for (let l = gapStart; l <= gapEnd && l <= totalLines; l++) {
        if (sourceLines[l - 1].trim().length > 0) {
          if (first === -1) first = l;
          last = l;
        }
      }
      if (first !== -1 && last !== -1) {
        const gapContent = sourceLines.slice(first - 1, last).join('\n');
        allChunks.push(
          createChunk({
            filePath,
            language,
            symbol: isPreamble ? 'module preamble' : 'module statements',
            symbolKind: 'module',
            parent: null,
            startLine: first,
            endLine: last,
            content: gapContent,
          })
        );
      }
    }

    for (const sym of resolvedSymbols) {
      // Gap before symbol
      if (sym.startLine > currentLine) {
        const gapStart = currentLine;
        const gapEnd = sym.startLine - 1;
        addGapChunk(gapStart, gapEnd, gapStart === 1);
      }

      // Add the symbol chunk
      allChunks.push(
        createChunk({
          filePath,
          language,
          symbol: sym.symbol,
          symbolKind: sym.symbolKind,
          parent: sym.parent,
          startLine: sym.startLine,
          endLine: sym.endLine,
          content: sym.content,
        })
      );

      currentLine = Math.max(currentLine, sym.endLine + 1);
    }

    // Trailing lines after last symbol
    if (currentLine <= totalLines) {
      addGapChunk(currentLine, totalLines, false);
    }

    // Split any oversized chunks
    return allChunks.flatMap((c) => splitOversizedChunk(c, limits));
  } catch (err) {
    console.warn(`[chunker] AST parsing failed for ${filePath}: ${err.message}. Falling back to line windows.`);
    return chunkByLineWindow(content, filePath, language, limits);
  }
}
