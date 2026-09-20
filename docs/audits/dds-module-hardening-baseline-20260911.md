# Baseline — hardening do módulo DDS

Repositório: `wandersongandra/sgsseguranca`
Worktree: `C:\Users\User\Documents\trae_projects\sgs-dds-hardening-20260911`
Branch: `audit/dds-module-hardening-20260911`
START_MAIN_SHA: `21a675466cee63844ea2f01741898b71c3dd42bb`

## Estado inicial

- `git status --short --branch` registrou somente as alterações pré-existentes em `frontend/app/verify/page.tsx` e `frontend/app/verify/page.test.tsx` (normalização CRLF/EOL); preservadas e fora do escopo.
- Nenhuma correção de código do DDS foi aplicada antes deste baseline.

## Backend

| Check | Comando | Resultado observado |
|---|---|---|
| Dependências | `npm ci --no-audit --no-fund` | PASS — 1.503 pacotes adicionados; browser Puppeteer já disponível |
| Lint | `npm run lint` | PASS — exit 0 |
| Typecheck | `$env:NODE_OPTIONS='--max-old-space-size=4096'; npm run type-check` | PASS — exit 0 |
| Testes | `npm run test:ci` | PASS — 327 suítes e 2.870 testes |
| Build | `npm run build` | PASS — exit 0 |
| Dependências | `npm audit --audit-level=high` | PASS — `found 0 vulnerabilities` |

## Frontend

| Check | Comando | Resultado observado |
|---|---|---|
| Dependências | `npm ci --no-audit --no-fund` | PASS — 1.006 pacotes adicionados; avisos de peer/depreciação registrados pelo npm |
| Lint | `npm run lint` | PASS — `PERMISSION_IMPORTS_OK`, ESLint e Stylelint concluídos |
| Typecheck | `$env:NODE_OPTIONS='--max-old-space-size=8192'; npx tsc --noEmit --pretty false` | PASS — exit 0 |
| Testes | `npm run test:ci` | PASS — 169 suítes passaram, 1 skipped; 921 testes passaram, 2 skipped |
| Build | `npm run build` | BLOCKED — `NEXT_PUBLIC_API_URL` obrigatória para build/start protegidos |
| Dependências | `npm audit --audit-level=high` | PASS — `found 0 vulnerabilities` |

O bloqueio de build é de configuração local e não foi contornado com fallback ou segredo inventado.
