# SGS frontend visual quality audit log

BASE_SHA: `b6939387bd7ae61fddfc8dd2cf96ed1e8d725546`
WORKTREE: `C:\Users\User\Documents\trae_projects\sgs-frontend-visual-quality-phase2`
BRANCH: `design/frontend-visual-quality-phase2`

## GATE SETUP

- **Comando ou inspeção:** `git fetch origin`; `git rev-parse origin/main`; `git worktree add -b design/frontend-visual-quality-phase2 ... origin/main`; inventário de arquivos e leitura dos tokens/primitives.
- **Evidência:** `docs/frontend-visual/BASELINE.md`; worktree limpo criado em `b6939387`; `frontend/package.json` confirma Next 16.3.1, React 19.2.8, Tailwind 4.2.1, Radix e Lucide.
- **Classificação:** CONFIRMED / isolamento e baseline estrutural.
- **Ação tomada:** nenhuma alteração funcional ou visual; somente documentação do baseline.

## GATE BASELINE_CHECKS

- **Comando ou inspeção:** `npm ci`, lint, typecheck, testes, build, audit e browser baseline antes das alterações.
- **Evidência:** `docs/frontend-visual/BASELINE.md`; `npm ci` exit 0 (1006 packages, 0 vulnerabilities); lint exit 0; typecheck exit 0; `npm run test:ci` exit 0 (161 suítes passed/1 skipped; 893 testes passed/2 skipped); build exit 0 (91 páginas); audit exit 0 (0 vulnerabilities).
- **Classificação:** CONFIRMED / baseline executável verde.
- **Ação tomada:** nenhuma correção antes do baseline.

## GATE INVENTORY_AND_SHARED_PATTERNS

- **Comando ou inspeção:** inventário de `frontend/**` com `rg`, leitura de `PageHeader`, `ListPageLayout`, `FormPageLayout`, `ResponsiveDataList`, `ModalFrame`, `ConfirmModal`, Sidebar, Header, tokens e CSS legal.
- **Evidência:** `docs/frontend-visual/BASELINE.md` — matriz `COMPONENT_OR_PATTERN / VARIANTS_FOUND / INCONSISTENCY / IMPACT / RECOMMENDED_STANDARD`; `frontend/src/components/layout/PageHeader.tsx:14-52`; `frontend/src/components/ui/responsive-data-list.tsx:47-91`; `frontend/src/components/ui/modal-frame.tsx:76-127`.
- **Classificação:** CONFIRMED / padrões compartilhados disponíveis; V2 residual em telas autenticadas por falta de sessão de teste.
- **Ação tomada:** preservados tokens, Radix, Tailwind, Next, React e layouts existentes; nenhum redesign ou troca de biblioteca.

## GATE V2-001_LEGAL_MOBILE_LINKS

- **Comando ou inspeção:** browser real headed com Playwright CLI em `/cookies`, viewport `320x568`, screenshot antes/depois e inspeção de `getBoundingClientRect()` dos links Cloudflare/Neon.
- **Evidência:** antes `output/playwright/before-cookies-links-320.png`; antes os links tinham `left=535/right=744` e `left=615/right=744`, fora do viewport. Causa em `frontend/app/legal-pages.module.css:811-924`: grid/flex sem contenção de min-content, agravado por `.page { overflow: hidden }`. Depois `output/playwright/final-cookies-320.png`; `cloudflare.com/privacypolicy` `left=66/right=259` e `neon.tech/privacy` `left=66/right=195`, `scrollWidth=320`.
- **Classificação:** V2 CONFIRMED / corrigido e validado visualmente.
- **Ação tomada:** `frontend/app/legal-pages.module.css:811-924` passou a conter largura mínima, usar fluxo de bloco para o item e quebrar URLs longas; tabela horizontal existente foi preservada.

## GATE V2-002_VERIFY_SELECTED_MODE

- **Comando ou inspeção:** leitura de `frontend/app/verify/page.tsx`, teste Jest direcionado e browser real em `390x844`, incluindo clique nos modos.
- **Evidência:** antes, `git show b6939387:frontend/app/verify/page.tsx` mostrava botões sem `role`/`aria-pressed`; screenshot de referência `output/playwright/baseline-verify-390.png`. Depois `frontend/app/verify/page.tsx:336-345` expõe grupo nomeado e `aria-pressed`; browser observou inicialmente Código `true`, demais `false`, e após clique em Evidência APR observou Evidência `true`; `frontend/app/verify/page.test.tsx:290-304` passou.
- **Classificação:** V2 CONFIRMED / corrigido e validado em browser e teste.
- **Ação tomada:** adicionada somente semântica acessível, sem alterar o contrato de validação.

## GATE V2-003_KEYBOARD_LOGIN

- **Comando ou inspeção:** browser real headed em `/login`, `390x844`, `Tab` e `Enter` no skip-link.
- **Evidência:** antes o `autoFocus` em `frontend/app/(auth)/login/LoginPageClient.tsx` fazia o primeiro foco cair no CPF; depois `frontend/app/(auth)/login/LoginPageClient.tsx:259-264` não força foco, o primeiro Tab foi `A[href="#main-content"]` e Enter produziu `location.hash="#main-content"`. Screenshot final `output/playwright/final-login-1440.png`.
- **Classificação:** V2 CONFIRMED / corrigido e validado em browser.
- **Ação tomada:** removido o `autoFocus` que quebrava a ordem do skip-link; foco visual e labels existentes foram preservados.

## GATE V2-004_NATIVE_CONFIRMATIONS

- **Comando ou inspeção:** busca `rg -n "window.confirm|confirm\(" frontend/app/dashboard frontend/src`; leitura dos 13 consumidores; Jest `app/dashboard/adminWaveBResponsivePattern.test.ts`, `src/components/ui/confirm-action-provider.test.tsx` e teste do workspace fotográfico.
- **Evidência:** antes a busca listava 15 chamadas em `activities`, `audits`, `checklist-models`, `checklists`, `dids`, `epis`, `expenses/[id]`, `machines`, `photographic-reports`, `risks`, `service-orders`, `sites` e `tools`. Depois a busca não retornou chamadas nativas; `frontend/src/components/ui/confirm-action-provider.tsx:31-75` usa `ConfirmModal`, `frontend/app/dashboard/layout.tsx:351-357` provê o contexto e `frontend/app/dashboard/adminWaveBResponsivePattern.test.ts:12-75` cobre os consumidores.
- **Classificação:** V2 CONFIRMED / corrigido por código e testes; browser autenticado do diálogo `NÃO VERIFICADO` por falta de sessão legítima.
- **Ação tomada:** migradas confirmações destrutivas para o primitivo Radix existente; locks, endpoints, payloads e ordem das mutações não foram alterados.

## GATE RESPONSIVE_PUBLIC_MATRIX

- **Comando ou inspeção:** Playwright CLI headed, 6 rotas públicas × 10 viewports, medindo `scrollWidth` e controles horizontais; `/validar/DEMO` também foi exercitada como redirect para `/verify`.
- **Evidência:** comando retornou `{"checked":60,"failures":[]}`; combinações incluem `320x568`, `360x800`, `390x844`, `412x915`, tablet `768x1024`/`1024x768`, desktop `1366x768`/`1440x900`/`1920x1080` e landscape `844x390`.
- **Classificação:** PASS representativo para rotas públicas; dashboard autenticado `NÃO VERIFICADO`.
- **Ação tomada:** nenhuma alteração ampla de layout; correções ficaram nos dois achados V2 confirmados.

## GATE ACCESSIBILITY_AND_MOTION

- **Comando ou inspeção:** browser real com `Tab`/`Enter`, inspeção ARIA do verify, `page.emulateMedia({ reducedMotion: 'reduce' })` e leitura de CSS de redução de movimento.
- **Evidência:** skip-link recebeu foco e ativou `#main-content`; verify reportou grupo `Tipo de validação` e estado `aria-pressed`; reduced motion reportou `display=none` para ambient glow e `transitionDuration=1e-05s`. Primitivo de diálogo existente mantém foco/modal semântico em `frontend/src/components/ui/modal-frame.tsx:104-127`; testes `frontend/src/components/ui/modal-frame.test.tsx` passaram na suíte.
- **Classificação:** PASS nas superfícies públicas e primitives compartilhadas; navegação do shell autenticado `NÃO VERIFICADO`.
- **Ação tomada:** removido apenas o `autoFocus` incompatível com skip-link; não alterada a política de motion existente.

## GATE FINAL_REGRESSION

- **Comando ou inspeção:** `npm ci`; `npm run lint`; `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --pretty false`; `npm run test:ci`; build com `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001` e `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000`; `npm audit`; `git diff --check`.
- **Evidência:** `npm ci` exit 0, 1006 pacotes/1007 auditados/0 vulnerabilidades; lint exit 0 com `PERMISSION_IMPORTS_OK` e Stylelint; typecheck exit 0; testes `162 passed, 1 skipped; 908 passed, 2 skipped`; build exit 0 com Next.js 16.3.4 e 91 páginas; audit `found 0 vulnerabilities`; diff check sem saída.
- **Classificação:** PASS nos checks executáveis; STATUS=PARTIAL por browser autenticado e CI remoto não executados.
- **Ação tomada:** nenhuma mudança fora de `frontend/**` e `docs/frontend-visual/**`; produção, backend, migrations, workflows e PDFs permaneceram intocados.

## GATE EOL_HYGIENE

- **Comando ou inspeção:** contagem de bytes de quebra de linha e `git check-attr text eol -- frontend/app/verify/page.tsx frontend/app/verify/page.test.tsx`.
- **Evidência:** ambos os arquivos reportam `eol: lf` e, após a normalização, `crlf=0`; `git diff --check` não reportou erro. A mudança funcional permaneceu verificável com `npm exec jest -- --runInBand app/verify/page.test.tsx app/dashboard/adminWaveBResponsivePattern.test.ts src/components/ui/confirm-action-provider.test.tsx` — 3 suítes e 33 testes passed.
- **Classificação:** CONFIRMED / conformidade de EOL; sem alteração funcional adicional.
- **Ação tomada:** normalizados somente `frontend/app/verify/page.tsx` e `frontend/app/verify/page.test.tsx`, que já estavam no escopo desta fase e violavam `*.tsx text eol=lf`.
