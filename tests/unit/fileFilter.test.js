import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterFile, filterFiles } from '../../src/ingestion/fileFilter.js';

describe('Milestone 1: fileFilter (File Classification & Skip Rules)', () => {
  it('includes standard source code files and manifests', () => {
    const files = [
      { relativePath: 'src/index.js', sizeBytes: 1024 },
      { relativePath: 'src/components/App.tsx', sizeBytes: 2048 },
      { relativePath: 'backend/main.py', sizeBytes: 5000 },
      { relativePath: 'services/UserService.java', sizeBytes: 8000 },
      { relativePath: 'Dockerfile', sizeBytes: 400 },
      { relativePath: 'package.json', sizeBytes: 1200 },
      { relativePath: 'README.md', sizeBytes: 3000 },
      { relativePath: 'requirements.txt', sizeBytes: 500 },
      { relativePath: 'Cargo.toml', sizeBytes: 800 },
    ];

    for (const file of files) {
      const result = filterFile(file);
      assert.equal(result.included, true, `Expected ${file.relativePath} to be included`);
    }
  });

  it('excludes vendored, build, and hidden directories', () => {
    const files = [
      { relativePath: 'node_modules/lodash/index.js' },
      { relativePath: 'dist/bundle.js' },
      { relativePath: 'build/static/js/main.js' },
      { relativePath: 'coverage/lcov.info' },
      { relativePath: '.git/config' },
      { relativePath: '.next/server/page.js' },
      { relativePath: 'vendor/bundle/lib.rb' },
      { relativePath: '__pycache__/app.cpython-310.pyc' },
      { relativePath: '.venv/bin/activate' },
    ];

    for (const file of files) {
      const result = filterFile(file);
      assert.equal(result.included, false);
      assert.ok(
        result.reason.startsWith('excluded_directory') ||
          result.reason.startsWith('hidden_directory'),
        `Unexpected reason for ${file.relativePath}: ${result.reason}`
      );
    }
  });

  it('excludes package manager lockfiles', () => {
    const lockfiles = [
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'Cargo.lock',
      'poetry.lock',
      'composer.lock',
    ];

    for (const name of lockfiles) {
      const result = filterFile({ relativePath: name });
      assert.equal(result.included, false);
      assert.equal(result.reason, 'lockfile');
    }
  });

  it('excludes minified files and sourcemaps', () => {
    const files = [
      'public/jquery.min.js',
      'styles/main.min.css',
      'bundle.js.map',
    ];

    for (const name of files) {
      const result = filterFile({ relativePath: name });
      assert.equal(result.included, false);
      assert.equal(result.reason, 'minified_or_sourcemap');
    }
  });

  it('excludes binaries, media, and archive formats', () => {
    const files = [
      'assets/logo.png',
      'docs/manual.pdf',
      'backup/data.zip',
      'engine/runtime.wasm',
      'tools/runner.exe',
      'native/libfoo.so',
    ];

    for (const name of files) {
      const result = filterFile({ relativePath: name });
      assert.equal(result.included, false);
      assert.equal(result.reason, 'binary_or_media');
    }
  });

  it('excludes linter and formatter config files', () => {
    const files = [
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.json',
      '.prettierrc',
      '.prettierrc.yaml',
      '.editorconfig',
      'eslint.config.js',
      'prettier.config.cjs',
    ];

    for (const name of files) {
      const result = filterFile({ relativePath: name });
      assert.equal(result.included, false, `Expected ${name} to be excluded`);
      assert.equal(result.reason, 'linter_or_formatter_config');
    }
  });

  it('excludes LICENSE files entirely', () => {
    const files = [
      'LICENSE',
      'LICENSE.txt',
      'LICENSE.md',
      'LICENCE',
      'COPYING',
    ];

    for (const name of files) {
      const result = filterFile({ relativePath: name });
      assert.equal(result.included, false, `Expected ${name} to be excluded`);
      assert.equal(result.reason, 'license_file');
    }
  });

  it('excludes files exceeding the single-file size limit', () => {
    const normalFile = { relativePath: 'src/big.js', sizeBytes: 150 * 1024 };
    const oversizedFile = { relativePath: 'src/giant.js', sizeBytes: 250 * 1024 };

    assert.equal(filterFile(normalFile, { maxFileSizeKb: 200 }).included, true);
    const oversizedResult = filterFile(oversizedFile, { maxFileSizeKb: 200 });
    assert.equal(oversizedResult.included, false);
    assert.ok(oversizedResult.reason.startsWith('exceeds_size_limit'));
  });

  it('filterFiles groups reasons accurately', () => {
    const fileList = [
      { relativePath: 'src/index.js', sizeBytes: 100 },
      { relativePath: 'node_modules/a/index.js' },
      { relativePath: 'node_modules/b/index.js' },
      { relativePath: 'package-lock.json' },
      { relativePath: 'logo.png' },
    ];

    const { included, skipped, groupedReasons } = filterFiles(fileList);

    assert.equal(included.length, 1);
    assert.equal(skipped.length, 4);
    assert.equal(groupedReasons['excluded_directory'], 2);
    assert.equal(groupedReasons['lockfile'], 1);
    assert.equal(groupedReasons['binary_or_media'], 1);
  });
});
