# Vendor provenance — peerDependencies compatibility patches for NestJS 12

Both packages below have **zero real runtime incompatibility** with NestJS 12.
Their published `peerDependencies` range simply predates the NestJS 12 release.
Full audit and boot-level proof: `THROTTLER_NEST12_COMPATIBILITY_PROVEN` (see PR description).

The only change applied to either package, in either case, is widening
`peerDependencies` to also accept `^12.0.0`. No other file in either package
was touched — verified below with a full `diff -rq` against the untouched
upstream tarball extraction.

## Format: packed `.tgz`, not an extracted directory — and why

A first attempt vendored these as plain extracted **directories** (so the
patch would be a normal `git diff` instead of a binary blob). That was
reverted after it broke `npm install --package-lock-only` cleanliness in
practice: a `file:` dependency pointing at a raw directory bypasses `npm
pack`'s publish-time filtering (`files`/`.npmignore`), so npm resolved each
vendored package's own **devDependencies** too — pulling in `fastify`,
`@apollo/server`, `@nestjs/graphql`, and an old `@typescript-eslint`
toolchain nested under `vendor/*/node_modules/`. None of this is ever
required at runtime (SGS uses Express, not Fastify or GraphQL), but it
doubled the resolved package count (~1.6k → ~3k) and `npm audit
--audit-level=high` went from 0 to 36 findings, all phantom (unreachable
code paths from packages the project never imports).

Repacking with `npm pack` from the same patched directory reproduces
exactly what upstream would have published — same file count as the
original tarball, devDependencies excluded — while keeping the *patch
diff itself* (shown below) fully documented and independently
reproducible. This satisfies the "no clean-install weakening" requirement
that a raw directory reference did not.

---

## 1. `@nestjs/throttler@6.5.0`

| Field | Value |
|---|---|
| Upstream registry | `https://registry.npmjs.org/@nestjs/throttler/-/throttler-6.5.0.tgz` |
| Version | `6.5.0` (latest published; no `^12` release exists upstream) |
| License | MIT (preserved unmodified) |
| Original tarball SHA-1 (npm `dist.shasum`) | `1ee550a258c4ae697d3978f2c8932adff927439e` |
| Original tarball SHA-512 (npm `dist.integrity`, SRI base64) | `sha512-9j0ZRfH0QE1qyrj9JjIRDz5gQLPqq9yVC2nHsrosDVAfI5HHw08/aUAWx9DZLSdQf4HDkmhTTEGLrRFHENvchQ==` |
| Original tarball SHA-256 (local re-verification) | `c74117b72c966e6f430efcec3b693b28f7c397e4b6f06933038f5d180a050b82` |
| Files in original tarball | 49 |
| Files in repacked vendor tarball | 49 (identical — confirms no devDependency leakage) |
| Vendored artifact | `backend/vendor/nestjs-throttler-6.5.0-nestjs12-compat.tgz` |
| Vendored artifact SHA-256 | `d683375c56572a5234a57ce6eabb44e56feadafb74375d3139a6618358fbfe63` |

### Patch applied (full diff — the only change in the package)

```diff
--- package/package.json  (original, upstream)
+++ package.json           (vendored, patched)
@@ -76,8 +76,8 @@
     "ws": "8.18.3"
   },
   "peerDependencies": {
-    "@nestjs/common": "^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0",
-    "@nestjs/core": "^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0",
+    "@nestjs/common": "^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0 || ^12.0.0",
+    "@nestjs/core": "^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0 || ^12.0.0",
     "reflect-metadata": "^0.1.13 || ^0.2.0"
   },
   "jest": {
```

`diff -rq` between the untouched original extraction and the pre-pack
patched directory confirms this is the **only** file that differs — every
other file (all compiled `dist/*.js`, `dist/*.d.ts`, `LICENSE`, `README.md`)
is byte-identical to what `npm pack @nestjs/throttler@6.5.0` produces from
the registry.

APIs actually used by SGS (`AdvancedThrottlerGuard`, `IpThrottlerGuard`,
`ThrottlerRedisStorageService`, `@Throttle`) — `Injectable`, `Global`,
`Module`, `Inject`, `HttpException`, `HttpStatus`, `Reflector` — are stable,
unchanged surface between NestJS 11 and 12. Confirmed at runtime via a
compiled boot probe (`NestFactory.create()` + `ThrottlerModule.forRoot()` +
`APP_GUARD` + a `ThrottlerGuard` subclass + `@Throttle()`), not just
type-checking.

---

## 2. `nest-winston@1.10.2`

| Field | Value |
|---|---|
| Upstream registry | `https://registry.npmjs.org/nest-winston/-/nest-winston-1.10.2.tgz` |
| Version | `1.10.2` (latest published; no `^12` release exists upstream) |
| License | MIT (preserved unmodified) |
| Original tarball SHA-1 (npm `dist.shasum`) | `3a3de151677cbf393d2e2c2efd1f9222a5776708` |
| Original tarball SHA-512 (npm `dist.integrity`, SRI base64) | `sha512-Z9IzL/nekBOF/TEwBHUJDiDPMaXUcFquUQOFavIRet6xF0EbuWnOzslyN/ksgzG+fITNgXhMdrL/POp9SdaFxA==` |
| Original tarball SHA-256 (local re-verification) | `40e4778a8a5e39480e4c2a1cd5bb7c4b77948fd57a8c6685b7494bab540623fa` |
| Files in original tarball | 17 |
| Files in repacked vendor tarball | 17 (identical — confirms no devDependency leakage) |
| Vendored artifact | `backend/vendor/nest-winston-1.10.2-nestjs12-compat.tgz` |
| Vendored artifact SHA-256 | `0f2bd177fceb0a14278fb0e262ddb6a1d02b8b170d55a5fe61cff74f43a4dca7` |

### Patch applied (full diff — the only change in the package)

```diff
--- package/package.json  (original, upstream)
+++ package.json           (vendored, patched)
@@ -43,7 +43,7 @@
     "winston": "3.16.0"
   },
   "peerDependencies": {
-    "@nestjs/common": "^5.0.0 || ^6.6.0 || ^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0",
+    "@nestjs/common": "^5.0.0 || ^6.6.0 || ^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0 || ^12.0.0",
     "winston": "^3.0.0"
   },
   "homepage": "https://github.com/gremo/nest-winston#readme",
```

APIs used (`WinstonModule`, `WINSTON_MODULE_PROVIDER`/`NEST_PROVIDER`,
`utilities.format.nestLike`) do not touch any NestJS 11→12 breaking surface.

---

## Reproduction — how to regenerate and independently verify these artifacts

```bash
# 1. Download the exact upstream tarballs from the public npm registry
npm pack @nestjs/throttler@6.5.0
npm pack nest-winston@1.10.2

# 2. Verify integrity against the registry's own published metadata
#    (must match the SHA-1/SHA-512 values documented above)
sha1sum nestjs-throttler-6.5.0.tgz nest-winston-1.10.2.tgz
npm view @nestjs/throttler@6.5.0 dist.shasum dist.integrity
npm view nest-winston@1.10.2 dist.shasum dist.integrity

# 3. Extract, apply ONLY the peerDependencies edit shown above to package.json
mkdir throttler-patched nest-winston-patched
tar -xzf nestjs-throttler-6.5.0.tgz -C throttler-patched --strip-components=1
tar -xzf nest-winston-1.10.2.tgz -C nest-winston-patched --strip-components=1
# ... edit peerDependencies in each package.json exactly as diffed above ...

# 4. Repack with npm pack (NOT a manual tar/zip) so publish-time filtering
#    (files/.npmignore) is honoured and devDependencies are excluded —
#    this is the step that was skipped in the first (rejected) attempt.
(cd throttler-patched && npm pack --pack-destination ..)
(cd nest-winston-patched && npm pack --pack-destination ..)

# 5. Confirm file counts match the originals (49 and 17) and sha256sum
#    matches the "Vendored artifact SHA-256" values documented above.
sha256sum nestjs-throttler-6.5.0.tgz nest-winston-1.10.2.tgz
```

## Why a vendor patch instead of `--legacy-peer-deps` / `overrides`

- `--legacy-peer-deps` disables npm's peer-dependency resolution **globally**
  for the entire install, silently masking any *other* real peer conflict
  that might exist or appear later — not just these two known-safe packages.
- npm `overrides` only rewrites which **version** of a transitive dependency
  gets installed; it cannot change a package's own declared
  `peerDependencies`, so it would not resolve the `ERESOLVE` at all without
  also disabling peer checks some other way — i.e. it would still require
  `--legacy-peer-deps` or `--force` underneath, just hidden behind
  `overrides` config instead of a CLI flag.
- A vendor patch changes exactly the one incorrect metadata field, is fully
  reviewable via this document, resolves cleanly with a plain
  `npm install --package-lock-only` / `npm ci` (no flags), and is trivially
  reproducible/auditable by anyone via the steps above.
