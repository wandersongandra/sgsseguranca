import {
  patchImportMeta,
  patchIfNestjsPackage,
} from './nestjs-esm-transformer.js';

describe('patchImportMeta', () => {
  it('leaves source without import.meta completely untouched', () => {
    const source =
      "import { Injectable } from '@nestjs/common';\nexport class X {}\n";
    expect(patchImportMeta(source)).toBe(source);
  });

  it('drops the createRequire(import.meta.url) shadowing declaration', () => {
    const source = [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const pkg = require('some-pkg');",
    ].join('\n');
    const patched = patchImportMeta(source);
    expect(patched).not.toContain('const require =');
    expect(patched).not.toContain('import.meta');
    expect(patched).toContain("require('some-pkg')");
  });

  it('rewrites import.meta.resolve(name) to require.resolve(name)', () => {
    const source = 'try { import.meta.resolve(packageName); } catch {}';
    const patched = patchImportMeta(source);
    expect(patched).toBe('try { require.resolve(packageName); } catch {}');
    expect(patched).not.toContain('import.meta');
  });

  it('rewrites import.meta.dirname to the CJS __dirname global', () => {
    const source = 'const dir = import.meta.dirname;';
    expect(patchImportMeta(source)).toBe('const dir = __dirname;');
  });

  it('rewrites a bare import.meta.url reference to the CJS file-URL equivalent', () => {
    const source = 'const u = import.meta.url;';
    expect(patchImportMeta(source)).toBe(
      "const u = require('url').pathToFileURL(__filename).href;",
    );
  });

  it('produces output that actually parses as valid CommonJS after rewriting', () => {
    // Mirrors the exact shape found in @nestjs/common/utils/load-package.util.js
    // and @nestjs/typeorm/dist/common/typeorm-compat.js, AFTER TypeScript's own
    // ESM->CJS conversion of the surrounding import/export statements (that
    // part is ts-jest's job, not patchImportMeta's — this function only ever
    // sees import.meta, which TypeScript's CommonJS emit leaves untouched).
    // If this throws, the import.meta rewrite itself is wrong.
    const source = [
      "const { createRequire } = require('node:module');",
      'const require = createRequire(import.meta.url);',
      'function loadSync(name) { return require(name); }',
      'function assertInstalled(name) {',
      '  try { import.meta.resolve(name); return true; }',
      '  catch { return false; }',
      '}',
      'module.exports = { loadSync, assertInstalled, dir: import.meta.dirname };',
    ].join('\n');
    const patched = patchImportMeta(source);
    expect(patched).not.toContain('import.meta');
    // new Function throws SyntaxError immediately if the body isn't valid JS —
    // this is the same class of error Jest's vm.Script raised before the fix.
    // Fixed, test-only source; never used with untrusted input.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(patched)).not.toThrow();
  });

  it('does not touch unrelated code that merely mentions "import" as a word', () => {
    const source =
      '// import notes: this is not an import.meta reference\nconst x = 1;';
    expect(patchImportMeta(source)).toBe(source);
  });
});

describe('patchIfNestjsPackage (the path gate actually wired into Jest)', () => {
  const source = 'const u = import.meta.url;';

  it('patches files whose path is inside node_modules/@nestjs/ (POSIX)', () => {
    const path =
      '/repo/backend/node_modules/@nestjs/common/utils/load-package.util.js';
    expect(patchIfNestjsPackage(source, path)).not.toContain('import.meta');
  });

  it('patches files whose path is inside node_modules/@nestjs/ (Windows)', () => {
    const path =
      'C:\\repo\\backend\\node_modules\\@nestjs\\common\\utils\\load-package.util.js';
    expect(patchIfNestjsPackage(source, path)).not.toContain('import.meta');
  });

  it('leaves every other path completely untouched, even if it contains import.meta text', () => {
    // This is the exact bug this gate exists to prevent: without it, a spec
    // file whose *test fixture string* happens to contain "import.meta.url"
    // (like this very file, above) gets corrupted by the blind text replace.
    const projectPaths = [
      '/repo/backend/src/app.module.ts',
      '/repo/backend/test/nestjs-esm-transformer.spec.ts',
      '/repo/backend/node_modules/some-other-esm-pkg/index.js',
      '/repo/backend/node_modules/@nestjs-community/unofficial-pkg/index.js',
    ];
    for (const path of projectPaths) {
      expect(patchIfNestjsPackage(source, path)).toBe(source);
    }
  });
});
