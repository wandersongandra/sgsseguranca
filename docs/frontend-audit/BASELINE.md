# Frontend hardening audit — baseline

Data: 2026-09-09
Repositório: `wandersongandra/sgsseguranca`
Worktree: `C:\Users\User\Documents\trae_projects\sgs-frontend-hardening-20260909`
Branch: `audit/frontend-hardening-phase1`
Base: `origin/main`
START_MAIN_SHA: `3a3cc0232e168dab8d42e76fd814cfbdc573dc10`

O baseline foi executado no worktree isolado, em `frontend/`, antes de qualquer
alteração de código ou teste.

## Resultados

| Comando | Resultado | Evidência observada |
|---|---|---|
| `npm ci` | PASS | exit 0; `added 1006 packages, and audited 1007 packages in 1m`; avisos de peer/depreciação, sem `--force`/`--legacy-peer-deps` |
| `npm run lint` | PASS | exit 0; `PERMISSION_IMPORTS_OK`, ESLint e Stylelint concluídos sem erro |
| `$env:NODE_OPTIONS='--max-old-space-size=4096'; npx tsc --noEmit --pretty false` | PASS | exit 0, sem output de erro |
| `npm run test:ci` | PASS COM SKIP EXISTENTE | exit 0; `154 passed`, `1 skipped` suites; `872 passed`, `2 skipped` tests; 874 total |
| `npm run build` | BLOCKED | `prebuild` falhou porque `NEXT_PUBLIC_API_URL` é obrigatória para build/start protegidos; nenhum código foi alterado |
| `npm audit` | PASS | exit 0; `found 0 vulnerabilities` |

## Baseline de integridade

O checkout principal estava em branch `probe/throttler-nest12-compat` e continha
somente arquivos não rastreados fora do escopo frontend. Esses arquivos foram
preservados. O worktree deste relatório iniciou limpo sobre `origin/main`.

O bloqueio do build é de configuração/contrato de ambiente e não foi contornado
no baseline com URL inventada.
