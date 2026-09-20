# Cutover Resumption Security Gate

This gate is an operational appendix for a future release candidate. It does
not authorize production work and does not replace the production cutover
preflight.

## Candidate and migration boundary

- The historical reference release is
  `f44dbbed2bd3879c557fdb6bd6398ace99a454d0`.
- A candidate created after this review must use the eventual reviewed merge
  commit, not the historical SHA automatically.
- The database boundary remains `1709000000384` through
  `1709000000402`.
- Migration `0403` and every later migration remain outside this cutover.

## Required security gates

1. Run the pinned Gitleaks action against the candidate with full Git history
   and the checked-in `.gitleaksignore`.
2. Require zero unresolved findings. Exact fingerprints may cover only
   findings documented in `docs/security/historical-secret-review.md`.
3. Findings 12 and 13 are resolved by the owner confirmations recorded in
   `docs/security/historical-secret-review.md`; keep their exact fingerprints
   limited to those reviewed findings and do not add broad exclusions.
4. Run the pinned TruffleHog action with the checked-in
   `.github/trufflehog-exclude.txt`.
5. Treat `verified`, `unknown`, and `unverified` results as reviewable scan
   evidence. Do not replace the scan with `--only-verified`, broad path
   exclusions, `continue-on-error`, or a zero exit code. The checked-in
   exclude file may contain only anchored paths documented in the historical
   finding manifest; findings 12 and 13 remain outside any new exception.
6. Re-run only the incremental release and cutover preflight checks required
   for the new candidate after the security gate is green.

## Safe local commands

These commands are metadata-oriented examples. Their output must be captured
and redacted before reporting. They must not be given real secrets through
arguments, files, or logs.

```text
gitleaks git --no-banner --redact --report-format json --report-path - --log-opts=--all
docker run --rm -v .:/tmp -w /tmp <pinned-trufflehog-image> git file:///tmp/ --since-commit <base-sha> --branch <head-sha> --fail --no-update --github-actions --exclude-paths=.github/trufflehog-exclude.txt
```

## Production boundary

The security gate never authorizes a migration, deploy, restart, recreate,
rollback, cutover, provider mutation, or database write. Those operations
require the separate owner authorization and the complete live preflight.

## Historical security gate closure

- Finding #12 historical Cloudflare/R2 credential: resolved by
  owner-confirmed revocation or removal.
- Finding #13 historical Railway authorization: resolved by
  owner-confirmed retirement of the old Railway resources and services.
- Gitleaks 8.24.3 full-history replay: PASS with 0 findings.
- TruffleHog 3.97.4 full-history: PASS (prior accepted evidence).
- PR CI: PASS.
- No production operation is authorized by this document.
