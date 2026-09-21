# Signature timestamp keyring — production contract

This document is the operational source of truth for signature timestamp keys introduced with migration 0402.

## Rules

- `SIGNATURE_TIMESTAMP_SECRET` is the **legacy v1 verification/signing secret only when the real historical secret is known**.
- Never generate a new value and label it as `SIGNATURE_TIMESTAMP_SECRET` to replace a lost historical key. A newly generated value cannot validate historical tokens and would create false continuity.
- New issuance should use an explicit active pair:
  - `SIGNATURE_TIMESTAMP_ACTIVE_KEY_ID`
  - `SIGNATURE_TIMESTAMP_ACTIVE_SECRET`
- Historical keys that are no longer active belong only in `SIGNATURE_TIMESTAMP_VERIFICATION_KEYS_JSON`.
- The active secret must be different from every legacy/verification-only secret.
- Key IDs are non-secret metadata. Secret values must never be committed, logged, returned by health endpoints, or exposed to the frontend.

## Safe cutover when no historical token exists

If production evidence proves that there are no historical `timestamp_token` values and no external artifact was produced by a token-capable historical runtime, keep `SIGNATURE_TIMESTAMP_SECRET` empty and provision a fresh active pair for new issuance.

## Safe cutover when historical tokens exist

Recover the authentic historical secret before claiming historical validation. Configure that secret only as legacy/verification-only material. If the historical secret cannot be recovered, the system must report `LEGACY_KEY_UNAVAILABLE`; it must not classify those tokens as `INVALID` solely because the key is unavailable.

## Do not

- reuse `JWT_SECRET`, `JWT_REFRESH_SECRET`, proxy secrets, storage credentials, or encryption keys;
- put any signing/verifying secret in the database;
- rewrite or regenerate historical timestamp tokens;
- silently fall back from an active key to an unrelated secret.
