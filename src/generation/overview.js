/**
 * Repository overview generator using map-reduce analysis.
 *
 * Inputs: README, dependency manifests, entry points, and file tree.
 * Output: Structured markdown with purpose, tech stack, architecture,
 *         important modules, execution flow, and setup instructions.
 */
import { generate } from '../adapters/llm.js';
import {
  OVERVIEW_SYSTEM_PROMPT,
  buildOverviewPrompt,
} from './prompts.js';

// Common manifest filenames
export const MANIFEST_FILENAMES = new Set([
  'package.json',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'go.mod',
  'cargo.toml',
  'setup.py',
  'pyproject.toml',
  'gemfile',
]);

// Common entry point patterns
export const ENTRY_POINT_PATTERNS = [
  /^(src\/)?(index|main|app|server|cli)\.(js|ts|jsx|tsx|py|go)$/i,
  /^scripts\/(index|start|main|cli)\.(js|ts|py)$/i,
];

/**
 * Checks if a file path is a README file.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isReadme(filePath = '') {
  const base = filePath.split(/[/\\]/).pop().toLowerCase();
  return base.startsWith('readme');
}

/**
 * Checks if a file path is a dependency manifest.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isManifest(filePath = '') {
  const base = filePath.split(/[/\\]/).pop().toLowerCase();
  return MANIFEST_FILENAMES.has(base);
}

/**
 * Checks if a file path looks like an application entry point.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isEntryPoint(filePath = '') {
  const normalized = filePath.replace(/\\/g, '/');
  return ENTRY_POINT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Extracts sections from the overview markdown.
 *
 * @param {string} markdown
 * @returns {object} Extracted structured sections
 */
export function parseOverviewSections(markdown = '') {
  const sections = {
    purpose: '',
    techStack: '',
    architecture: '',
    importantModules: '',
    setup: '',
  };

  const lines = markdown.split('\n');
  let currentSection = null;
  const sectionBuffers = {
    purpose: [],
    techStack: [],
    architecture: [],
    importantModules: [],
    setup: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##?\s+purpose/i.test(trimmed)) {
      currentSection = 'purpose';
      continue;
    } else if (/^##?\s+tech\s*stack/i.test(trimmed)) {
      currentSection = 'techStack';
      continue;
    } else if (/^##?\s+(architecture|execution\s*flow)/i.test(trimmed)) {
      currentSection = 'architecture';
      continue;
    } else if (/^##?\s+(important\s*modules|entry\s*points)/i.test(trimmed)) {
      currentSection = 'importantModules';
      continue;
    } else if (/^##?\s+setup/i.test(trimmed)) {
      currentSection = 'setup';
      continue;
    } else if (/^##?\s+/i.test(trimmed)) {
      currentSection = null;
    }

    if (currentSection && sectionBuffers[currentSection]) {
      sectionBuffers[currentSection].push(line);
    }
  }

  for (const [key, buffer] of Object.entries(sectionBuffers)) {
    sections[key] = buffer.join('\n').trim();
  }

  return sections;
}

/**
 * Generates a structured repository overview from its core assets.
 *
 * @param {object} params
 * @param {Array<{ filePath: string, content: string }>} params.files
 * @param {string} [params.fileTree]
 * @param {Function} [params.llmGenerateFn] Override for generate()
 * @returns {Promise<{ rawMarkdown: string, sections: object }>}
 */
export async function generateOverview({
  files = [],
  fileTree = '',
  llmGenerateFn = generate,
}) {
  // 1. Partition files into README, Manifests, and Entry Points
  let readme = '';
  const manifests = [];
  const entryPoints = [];

  for (const f of files) {
    if (!readme && isReadme(f.filePath)) {
      readme = f.content || '';
    } else if (isManifest(f.filePath)) {
      manifests.push(f);
    } else if (isEntryPoint(f.filePath)) {
      entryPoints.push(f);
    }
  }

  // 2. Generate file tree if not provided
  let computedFileTree = fileTree;
  if (!computedFileTree && files.length > 0) {
    computedFileTree = files.map((f) => f.filePath).sort().join('\n');
  }

  // 3. Formulate the prompt
  const userPrompt = buildOverviewPrompt({
    readme,
    manifests,
    entryPoints,
    fileTree: computedFileTree,
  });

  // 4. Generate overview via LLM
  const rawMarkdown = await llmGenerateFn(userPrompt, {
    systemPrompt: OVERVIEW_SYSTEM_PROMPT,
  });

  // 5. Parse structured sections
  const sections = parseOverviewSections(rawMarkdown);

  return {
    rawMarkdown,
    sections,
  };
}

/**
 * Persists the generated overview string into the MongoDB repository document.
 *
 * @param {string} repoId
 * @param {string} overviewMarkdown
 * @param {object} [options]
 * @param {object} [options.RepositoryModel] Mongoose Repository model
 * @returns {Promise<boolean>}
 */
export async function storeOverview(repoId, overviewMarkdown, { RepositoryModel } = {}) {
  if (!repoId || !overviewMarkdown) return false;

  if (RepositoryModel) {
    try {
      await RepositoryModel.updateOne(
        { _id: repoId },
        { $set: { overview: overviewMarkdown } }
      );
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
