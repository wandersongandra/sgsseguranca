# Historical Secret Review

This review documents the historical secret findings observed for frozen
release `f44dbbed2bd3879c557fdb6bd6398ace99a454d0`.

The file intentionally contains metadata only. It does not contain secret
values, token material, JWT claims, hashes derived from secrets, or
authorization headers.

## Evidence boundary

- Gitleaks findings reviewed: 13.
- TruffleHog result: 0 verified and 15 unverified findings.
- The scheduled Gitleaks run observed version 8.24.3.
- The scheduled TruffleHog run observed version 3.97.4.
- Current-tree presence was checked against the frozen commit.
- Provider checks were read-only and did not mutate credentials or services.
- The historical Render credential returned HTTP 401 and is resolved as
  revoked or invalid.
- The historical JWT in `.tmp_pdf_head.ps1` has a valid structure, an
  expiration claim, and is expired now.
- The historical R2 credential did not match the current production
  credentials. The owner confirmed revocation or removal; no provider API
  lookup is claimed.
- The old authorization credential is not a JWT and does not match the
  current `JwtAuthGuard` scheme. The owner confirmed retirement of the old
  Railway resources and services; no Railway login or historical credential
  check was performed.

The full-history TruffleHog replay correlated the 15 concrete unverified
records without retaining their detected values: ten were static SVG path data,
four were local/documentation Postgres configuration examples, and one was a
Gitleaks fingerprint entry in `.gitleaksignore`. Three additional JSON records
had no Git finding metadata and were not counted as findings. The corresponding
paths are covered by exact, anchored entries in
`.github/trufflehog-exclude.txt`; findings 12 and 13 remain outside any new
exception. Gitleaks still scans the complete history independently.

## Finding manifest

| ID | Rule | Commit | Path:line | Current tree | Classification | Provider/status proof | Exact allowlist |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `generic-api-key` | `0e12bb217a3c1e5166e76a2b7c0fa5dfcd757d17` | `backend/test/setup/test-env.ts:48` | YES | `SYNTHETIC_TEST_VALUE` | deterministic test setup | YES |
| 2 | `jwt` | `2e633e748a06981c00d62ea618a81c2935ffa9ef` | `.tmp_pdf_head.ps1:1` | NO | `EXPIRED_EPHEMERAL_TOKEN` | valid JWT with proven expiration | YES |
| 3 | `generic-api-key` | `6a24daaf11a66ff2f6774a33c8cf03197d940407` | `backend/.env.example:39` | YES | `DOCUMENTATION_PLACEHOLDER` | example configuration | YES |
| 4 | `generic-api-key` | `6a24daaf11a66ff2f6774a33c8cf03197d940407` | `backend/.env.example:41` | YES | `DOCUMENTATION_PLACEHOLDER` | example configuration | YES |
| 5 | `jwt` | `8beb5bebd73d156e659eea6ac921554fee0927f5` | `backend/test/critical/admin-routes-security.e2e-spec.ts:251` | YES | `SYNTHETIC_TEST_VALUE` | invalid-auth test case | YES |
| 6 | `jwt` | `4c0cdc2ffc842aabd9c3026f12170f95b01b4ecc` | `backend/test/critical/admin-routes-security.e2e-spec.ts:248` | YES | `SYNTHETIC_TEST_VALUE` | invalid-auth test case | YES |
| 7 | `curl-auth-header` | `d5d024b37c9226eaa75169dda49ef6fd018a0c84` | `FIXAR_MIGRAÇÕES_RENDER.md:23` | NO | `REVOKED_OR_ROTATED_CREDENTIAL` | Render GET returned HTTP 401 | YES |
| 8 | `curl-auth-header` | `c6c4929a89365254b70460ce69d45315d916ece6` | `CHEAT_SHEET.md:266` | NO | `SYNTHETIC_TEST_VALUE` | invalid-token documentation test | YES |
| 9 | `curl-auth-header` | `c6c4929a89365254b70460ce69d45315d916ece6` | `GUIA_INTEGRACAO_MELHORIAS.md:219` | NO | `DOCUMENTATION_PLACEHOLDER` | explicit documentation placeholder | YES |
| 10 | `curl-auth-header` | `026ece85ef2d3edd052d30f8fff75745fcce599f` | `CHEAT_SHEET.md:266` | NO | `SYNTHETIC_TEST_VALUE` | invalid-token documentation test | YES |
| 11 | `curl-auth-header` | `026ece85ef2d3edd052d30f8fff75745fcce599f` | `GUIA_INTEGRACAO_MELHORIAS.md:219` | NO | `DOCUMENTATION_PLACEHOLDER` | explicit documentation placeholder | YES |
| 12 | `generic-api-key` | `355c9000c918fa839705f1fc812d5464aa9b7568` | `prompts/CLOUDFLARE_R2_CONFIGURADO.md:14` | NO | `REVOKED_OR_RETIRED_CREDENTIAL` | `OWNER_CONFIRMED_REVOCATION_OR_REMOVAL` | YES |
| 13 | `curl-auth-header` | `355c9000c918fa839705f1fc812d5464aa9b7568` | `prompts/CLOUDFLARE_R2_CONFIGURADO.md:25` | NO | `RETIRED_SERVICE_CREDENTIAL` | `OWNER_CONFIRMED_SERVICE_RETIREMENT` | YES |

Final status:

- Finding 12: `RESOLVED`; classification
  `REVOKED_OR_RETIRED_CREDENTIAL`; exact allowlist `YES`.
- Finding 13: `RESOLVED`; classification
  `RETIRED_SERVICE_CREDENTIAL`; exact allowlist `YES`.

## Exact fingerprints

Only the following exact fingerprints are eligible for the reviewed
findings. Findings 12 and 13 were added only after the owner confirmations
recorded above.

```text
0e12bb217a3c1e5166e76a2b7c0fa5dfcd757d17:backend/test/setup/test-env.ts:generic-api-key:48
2e633e748a06981c00d62ea618a81c2935ffa9ef:.tmp_pdf_head.ps1:jwt:1
6a24daaf11a66ff2f6774a33c8cf03197d940407:backend/.env.example:generic-api-key:39
6a24daaf11a66ff2f6774a33c8cf03197d940407:backend/.env.example:generic-api-key:41
8beb5bebd73d156e659eea6ac921554fee0927f5:backend/test/critical/admin-routes-security.e2e-spec.ts:jwt:251
4c0cdc2ffc842aabd9c3026f12170f95b01b4ecc:backend/test/critical/admin-routes-security.e2e-spec.ts:jwt:248
d5d024b37c9226eaa75169dda49ef6fd018a0c84:FIXAR_MIGRAÇÕES_RENDER.md:curl-auth-header:23
c6c4929a89365254b70460ce69d45315d916ece6:CHEAT_SHEET.md:curl-auth-header:266
c6c4929a89365254b70460ce69d45315d916ece6:GUIA_INTEGRACAO_MELHORIAS.md:curl-auth-header:219
026ece85ef2d3edd052d30f8fff75745fcce599f:CHEAT_SHEET.md:curl-auth-header:266
026ece85ef2d3edd052d30f8fff75745fcce599f:GUIA_INTEGRACAO_MELHORIAS.md:curl-auth-header:219
```

These entries are intended for exact fingerprint policy only. Findings 12 and
13 were added to `.gitleaksignore` only after the owner confirmations recorded
in the manifest. They do not authorize path-wide, rule-wide, history-wide, or
documentation-wide ignores.

## Owner confirmation

1. Finding 12 is `RESOLVED` with evidence
   `OWNER_CONFIRMED_REVOCATION_OR_REMOVAL`.
2. Finding 13 is `RESOLVED` with evidence
   `OWNER_CONFIRMED_SERVICE_RETIREMENT`; the historical target is `RETIRED`.

No provider API lookup, Railway login, historical credential request, or
external mutation was performed for these owner confirmations.

## Local reproduction

The exact Gitleaks version observed in the scheduled job was reproduced with
redacted output only:

```text
gitleaks.exe git --no-banner --redact --report-format json --report-path - --log-opts=--all
```

Before the owner confirmation, Gitleaks 8.24.3 reported only findings 12 and
13 and exited with code 1. Their exact fingerprints were then added to
`.gitleaksignore` after the owner confirmed revocation/removal and service
retirement.

The subsequent Gitleaks 8.24.3 full-history replay reported zero findings and
exit code 0. This is an exact-fingerprint closure, not a broad suppression.

The pinned TruffleHog binary 3.97.4 was verified locally. WSL2 Ubuntu was
available, so the full-history Git scan was run against the PR head with
`--branch`, `--fail`, `--no-update`, and the checked-in exclude file. The first
replay produced the 15 concrete unverified records described above. After the
exact path entries were added, the standard replay returned exit code 0 with
zero concrete findings, zero verified findings, and zero unverified findings;
three non-finding records had no Git metadata. No provider verification was
needed after the exact exclusions matched all reviewed artifacts.
