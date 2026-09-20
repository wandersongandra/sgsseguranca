/**
 * @nestjs/* v12 packages ship pure ESM ("type": "module") and several of
 * them (common, mapped-types, swagger, terminus, typeorm) use `import.meta`
 * (`.url`, `.resolve`, `.dirname`) inside optional-peer-dependency loader
 * helpers (e.g. createRequire(import.meta.url), import.meta.resolve(name)).
 *
 * Jest runs every transformed file as a CommonJS script via vm.Script, where
 * any `import.meta` usage is a SyntaxError regardless of whether that code
 * path is ever executed. TypeScript's CommonJS emit has no translation for
 * `import.meta` (it leaves it untouched), so ts-jest alone can't fix this.
 *
 * This wraps ts-jest: it rewrites `import.meta.*` to CJS equivalents (Jest's
 * module wrapper always provides `require`/`__filename`/`__dirname`) before
 * handing the source to ts-jest for the normal ESM->CJS import/export
 * transform.
 */
const tsJest = require('ts-jest');

// `const require = createRequire(import.meta.url);` is the standard ESM
// idiom for getting a CJS-style require inside a real ES module. Jest's
// module wrapper already injects a working `require` parameter, so
// redeclaring it as `const` is a hard SyntaxError ("Identifier 'require' has
// already been declared") — independent of the import.meta rewrite below.
// It's also unnecessary in Jest's CJS context, so we drop the declaration
// entirely and let call sites fall through to the ambient `require`.
const SHADOWING_REQUIRE_RE =
  /const\s+require\s*=\s*createRequire\s*\(\s*import\.meta\.url\s*\)\s*;?/g;
// import.meta.resolve(name) resolves a specifier without evaluating it and
// throws if missing — require.resolve(name) is the exact CJS equivalent.
const IMPORT_META_RESOLVE_RE = /import\.meta\.resolve\s*\(/g;
// import.meta.dirname (Node 20.11+) mirrors CJS's ambient __dirname.
const IMPORT_META_DIRNAME_RE = /import\.meta\.dirname/g;
const IMPORT_META_URL_RE = /import\.meta\.url/g;

// Matches node_modules/@nestjs/... on both POSIX and Windows path separators.
const NESTJS_PACKAGE_PATH_RE = /node_modules[\\/]@nestjs[\\/]/;

function patchImportMeta(sourceText) {
  if (!sourceText.includes('import.meta')) return sourceText;
  return sourceText
    .replace(SHADOWING_REQUIRE_RE, '')
    .replace(IMPORT_META_RESOLVE_RE, 'require.resolve(')
    .replace(IMPORT_META_DIRNAME_RE, '__dirname')
    .replace(IMPORT_META_URL_RE, "require('url').pathToFileURL(__filename).href");
}

// Gated by sourcePath so this NEVER touches project source or test files —
// only the @nestjs/* packages it exists to fix. Without this gate, a blind
// text replace runs on every file Jest transforms; a project file that merely
// *mentions* the string "import.meta" (a comment, a test fixture, a doc
// string) would get corrupted even though it contains no real import.meta
// syntax. (This is exactly how nestjs-esm-transformer.spec.ts's own test
// fixtures were found to break before this gate was added — see git history.)
function patchIfNestjsPackage(sourceText, sourcePath) {
  if (!NESTJS_PACKAGE_PATH_RE.test(sourcePath)) return sourceText;
  return patchImportMeta(sourceText);
}

module.exports = {
  // Exported so nestjs-esm-transformer.spec.ts can assert on the pure text
  // transform directly, without needing to mock ts-jest's compiler pipeline
  // or fight the sourcePath gate below.
  patchImportMeta,
  // Exported so the spec can assert the path gate itself, without spinning
  // up a real TsJestTransformer instance just to prove which paths it touches.
  patchIfNestjsPackage,
  createTransformer(tsJestConfig) {
    const inner = new tsJest.TsJestTransformer(tsJestConfig);
    return {
      process(sourceText, sourcePath, options) {
        return inner.process(
          patchIfNestjsPackage(sourceText, sourcePath),
          sourcePath,
          options,
        );
      },
      processAsync(sourceText, sourcePath, options) {
        return inner.processAsync(
          patchIfNestjsPackage(sourceText, sourcePath),
          sourcePath,
          options,
        );
      },
      getCacheKey(sourceText, sourcePath, options) {
        return inner.getCacheKey(
          patchIfNestjsPackage(sourceText, sourcePath),
          sourcePath,
          options,
        );
      },
      getCacheKeyAsync(sourceText, sourcePath, options) {
        return inner.getCacheKeyAsync(
          patchIfNestjsPackage(sourceText, sourcePath),
          sourcePath,
          options,
        );
      },
    };
  },
};
