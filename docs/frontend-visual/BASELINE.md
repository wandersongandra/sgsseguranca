# SGS frontend visual quality — baseline

BASE_SHA: `b6939387bd7ae61fddfc8dd2cf96ed1e8d725546`
WORKTREE: `C:\Users\User\Documents\trae_projects\sgs-frontend-visual-quality-phase2`
BRANCH: `design/frontend-visual-quality-phase2`
SCOPE: `frontend/**` (PDFs excluded)

## Stack and visual foundation

- Next.js: `16.3.1` (`frontend/package.json`)
- React / React DOM: `19.2.8`
- Tailwind CSS: `4.2.1`
- Component primitives: Radix UI (`Dialog`, `DropdownMenu`, `Select`, `Tabs`, `Checkbox`, `Switch`, `Slider`, `Separator`)
- Icon library: `lucide-react 1.40.0`
- Theme: single light theme; tokens in `frontend/styles/tokens.css` and `frontend/styles/theme-light.css`, global composition in `frontend/app/globals.css`
- Shared shell: `frontend/app/dashboard/layout.tsx`, Header, Sidebar, mobile field navigation and shared overlays
- Existing modal primitive: `frontend/src/components/ui/modal-frame.tsx` (Radix)
- Existing list precedent: `frontend/app/dashboard/document-registry/page.tsx` with mobile cards

## Inventory size

- Frontend files excluding `node_modules`: 725
- App pages (`page.tsx`): 112
- Frontend test files: 161

## Baseline evidence

The checkout was clean at creation. `git fetch origin` confirmed `origin/main` at
`b6939387bd7ae61fddfc8dd2cf96ed1e8d725546`; the original checkout remains dirty
and was not used for this work.

The following checks are intentionally run before implementation and recorded
below with their real output:

| Check | Result |
| --- | --- |
| `npx --version` | `11.12.1` |
| `npm ci` | PASS — added 1006 packages, audited 1007, 0 vulnerabilities |
| `npm run lint` | PASS — `PERMISSION_IMPORTS_OK` and Stylelint completed |
| `npx tsc --noEmit --pretty false` | PASS |
| `npm run test:ci` | PASS — 161 suites passed, 1 skipped; 893 tests passed, 2 skipped |
| `npm run build` | PASS — Next.js 16.3.4, 91 static pages generated, synthetic public env |
| `npm audit` | PASS — found 0 vulnerabilities |
| Browser visual baseline | PASS parcial — rotas públicas executadas em browser real; dashboard autenticado pendente de sessão de teste legítima |

## Visual inventory matrix

| COMPONENT_OR_PATTERN | VARIANTS_FOUND | INCONSISTENCY | IMPACT | RECOMMENDED_STANDARD |
| --- | --- | --- | --- | --- |
| Page header | `PageHeader`, `ListPageLayout`, `FormPageLayout` e títulos locais | módulos legados ainda têm cabeçalhos próprios | V2: hierarquia e ações podem variar entre módulos | usar `PageHeader` através dos layouts compartilhados |
| Listas e tabelas | `ResponsiveDataList` + mobile card, tabelas com `overflow-x-auto`, cards locais | o padrão responsivo não está presente em todas as telas | V2: leitura e ação em telas estreitas | desktop table + mobile card com um único padrão interativo |
| Formulários | `FormPageLayout`/`MobileActionBar` e formulários locais | densidade e barras de ação variam | V2: maior custo cognitivo e risco de ação fora da área visível | `FormPageLayout`, `FormField` e `MobileActionBar` |
| Diálogos e confirmações | `ModalFrame`/`ConfirmModal` Radix e confirmações nativas históricas | 13 consumidores ainda dependiam de `confirm()` | V2: bloqueio nativo, sem foco/semântica uniforme | `ConfirmActionProvider` + `ConfirmModal` compartilhado |
| Status | `StatusPill`, `Badge` e classes locais | semântica visual duplicada em módulos antigos | V3: reconhecimento menos consistente | `StatusPill`/`Badge` por significado semântico |
| Shell e navegação | Sidebar, Header, `MobileFieldNav`, overlays e command palette | autenticação impediu validar o fluxo real em browser | V2: risco de regressão responsiva não observado | validar shell em sessão de teste em todos os breakpoints |
| Páginas legais | hero/painéis compartilhados, listas e tabelas | links longos escapavam de flex/grid em mobile | V2: link de privacidade inacessível em 320 px | conteúdo com `min-width: 0` e quebra de URL longa |
| Validação pública | `PageHeader`, Card e grupo de botões de modo | modo selecionado não era exposto a AT | V2: estado do controle ambíguo para teclado/leitor | grupo nomeado + `aria-pressed` |

## Browser evidence

- Browser real: Playwright CLI headed, servidor local do build final em `http://127.0.0.1:3000`.
- Viewports executados: `320x568`, `360x800`, `390x844`, `412x915`, `768x1024`, `1024x768`, `1366x768`, `1440x900`, `1920x1080` e landscape `844x390`.
- Rotas públicas: `/login`, `/forgot-password`, `/verify`, `/cookies`, `/privacidade`, `/termos` e smoke de `/validar/DEMO`.
- Evidências visuais reais: `output/playwright/final-login-1440.png`, `output/playwright/final-verify-390.png`, `output/playwright/final-cookies-320.png`.
- O browser não recebeu credenciais, tokens inventados ou bypass de autenticação. Rotas `/dashboard/**`, diálogos destrutivos e fluxo mobile autenticado permanecem `NÃO VERIFICADO` em browser.
