import { expect, test, type Route } from '@playwright/test';
import { expectInputAvoidsIosZoom, expectNoHorizontalPageOverflow } from './helpers/mobile';

const apiHost = new URL(
  process.env.NEXT_PUBLIC_API_URL || 'https://api.sgsseguranca.com.br',
).host;

const accessToken = 'pt-visual-synthetic-token';
const companyId = '00000000-0000-4000-8000-000000000001';
const siteId = '00000000-0000-4000-8000-000000000002';
const ptId = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000004';

const syntheticSession = {
  accessToken,
  user: {
    id: userId,
    nome: 'Usuário PT Sintético',
    email: 'pt-visual@example.invalid',
    cpf: null,
    role: 'Administrador da Empresa',
    company_id: companyId,
    site_id: siteId,
    site_ids: [siteId],
    profile_id: 'synthetic-pt-admin',
    created_at: '2026-09-11T00:00:00.000Z',
    updated_at: '2026-09-11T00:00:00.000Z',
  },
  roles: ['Administrador da Empresa'],
  permissions: [
    'can_view_pt',
    'can_manage_pt',
    'can_approve_pt',
    'can_manage_mail',
  ],
  isAdminGeral: false,
};

const syntheticPt = {
  id: ptId,
  numero: 'PT-2026-001',
  titulo: 'Inspeção operacional sintética',
  data_hora_inicio: '2026-09-11T08:00:00.000Z',
  data_hora_fim: '2026-09-11T17:00:00.000Z',
  status: 'Pendente',
  pdf_file_key: null,
};

type SyntheticRouteResponse = {
  body: unknown;
  headers?: Record<string, string>;
};

async function fulfillJson(
  route: Route,
  body: unknown,
  headers?: Record<string, string>,
) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  });
}

const syntheticResponses = new Map<string, SyntheticRouteResponse>([
  ['*:/auth/csrf', { body: { csrfToken: 'synthetic-csrf-token' } }],
  [
    '*:/auth/login',
    {
      body: syntheticSession,
      headers: { 'set-cookie': 'refresh_csrf=synthetic; Path=/; SameSite=Lax' },
    },
  ],
  ['*:/auth/me', { body: syntheticSession }],
  ['*:/auth/refresh', { body: { accessToken } }],
  ['GET:/pts', { body: { data: [syntheticPt], total: 1, lastPage: 1 } }],
  [
    '*:/pts/analytics/overview',
    {
      body: {
        totalPts: 1,
        aprovadas: 0,
        pendentes: 1,
        canceladas: 0,
        encerradas: 0,
        expiradas: 0,
      },
    },
  ],
  [
    '*:/pts/approval-rules',
    {
      body: {
        blockCriticalRiskWithoutEvidence: true,
        blockWorkerWithoutValidMedicalExam: false,
        blockWorkerWithExpiredBlockingTraining: true,
        requireAtLeastOneExecutante: false,
      },
    },
  ],
  ['*:/pts/files/list', { body: [] }],
  [
    '*:/companies/:id',
    {
      body: {
        id: companyId,
        razao_social: 'Empresa PT Sintética',
        cnpj: '00000000000000',
        endereco: 'Endereço sintético',
        responsavel: 'Responsável sintético',
        status: true,
        created_at: '2026-09-11T00:00:00.000Z',
        updated_at: '2026-09-11T00:00:00.000Z',
      },
    },
  ],
  [
    '*:/sites',
    {
      body: {
        data: [{
          id: siteId,
          nome: 'Obra PT Sintética',
          company_id: companyId,
          created_at: '2026-09-11T00:00:00.000Z',
          updated_at: '2026-09-11T00:00:00.000Z',
        }],
        total: 1,
        lastPage: 1,
      },
    },
  ],
  [
    '*:/users',
    {
      body: {
        data: [{
          id: userId,
          nome: 'Usuário PT Sintético',
          company_id: companyId,
          site_id: siteId,
          site_ids: [siteId],
        }],
        total: 1,
        lastPage: 1,
      },
    },
  ],
  ['*:/aprs', { body: { data: [], total: 0, lastPage: 1 } }],
  ['*:/ai/', { body: { insights: [] } }],
]);

function normalizeSyntheticPath(pathname: string): string {
  if (pathname.startsWith('/companies/')) return '*:/companies/:id';
  if (pathname.startsWith('/ai/')) return '*:/ai/';
  return pathname;
}

function resolveSyntheticResponse(
  pathname: string,
  method: string,
): SyntheticRouteResponse {
  const normalizedPath = normalizeSyntheticPath(pathname);
  return (
    syntheticResponses.get(`${method}:${normalizedPath}`) ??
    syntheticResponses.get(`*:${normalizedPath}`) ??
    syntheticResponses.get(normalizedPath) ??
    { body: {} }
  );
}

async function handleSyntheticApiRoute(route: Route) {
  const requestUrl = new URL(route.request().url());
  const isProxyRequest = requestUrl.pathname.startsWith('/proxy');
  if (requestUrl.host !== apiHost && !isProxyRequest) {
    await route.continue();
    return;
  }

  const pathname = requestUrl.pathname.replace(/^\/proxy(?=\/|$)/, '');
  const response = resolveSyntheticResponse(pathname, route.request().method());
  await fulfillJson(route, response.body, response.headers);
}

test.describe('PT autenticada — smoke visual e acessibilidade', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/*', handleSyntheticApiRoute);

    await page.context().addCookies([
      {
        name: 'refresh_csrf',
        value: 'synthetic',
        url: 'http://127.0.0.1:3100',
        sameSite: 'Lax',
      },
    ]);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard(?:\/)?$/, { timeout: 30_000 });
    await page.goto('/dashboard/pts');
    await expect(page.getByRole('heading', { name: 'Permissão de Trabalho (PT)' })).toBeVisible();
    await expect(page.getByText('PT-2026-001')).toBeVisible();
    const onboardingClose = page.getByRole('button', { name: 'Fechar modal' });
    await onboardingClose
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => onboardingClose.click())
      .catch(() => undefined);
  });

  test('mantém o PT utilizável sem overflow em viewport autenticado', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalPageOverflow(page);

    const filters = page.locator('input:visible, select:visible');
    for (let index = 0; index < await filters.count(); index += 1) {
      const box = await filters.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      if ((page.viewportSize()?.width || 0) < 768) {
        await expectInputAvoidsIosZoom(filters.nth(index));
      }
    }
  });

  test('restaura foco ao fechar os modais destrutivos', async ({ page }) => {
    const deleteButton = page.getByRole('button', { name: /Excluir(?: PT)?/i }).first();
    await deleteButton.focus();
    await deleteButton.click();
    await expect(page.getByRole('dialog')).toContainText('Excluir PT');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(deleteButton).toBeFocused();

    const rejectButton = page.getByRole('button', { name: 'Reprovar', exact: true }).first();
    await rejectButton.focus();
    await rejectButton.click();
    await expect(page.getByRole('dialog')).toContainText('Reprovar PT');
    await expect(page.getByLabel('Motivo da reprovação')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(rejectButton).toBeFocused();
  });

  test('respeita prefers-reduced-motion no shell do PT', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const motion = await page.locator('input[aria-label="Pesquisar PTs"]').evaluate((element) => {
      const transitionDuration = window.getComputedStyle(element).transitionDuration;
      const numericDuration = Number.parseFloat(transitionDuration);
      const durationMs = transitionDuration.endsWith('s')
        ? numericDuration * 1_000
        : numericDuration;

      return {
        scrollBehavior: window.getComputedStyle(document.documentElement).scrollBehavior,
        durationMs,
      };
    });

    expect(motion.scrollBehavior).toBe('auto');
    expect(motion.durationMs).toBeLessThanOrEqual(0.1);
  });

  test('mantém os controles do formulário PT acessíveis no celular', async ({ page }) => {
    await page.goto('/dashboard/pts/new?field=1');
    await expect(page.getByRole('heading', { name: 'Nova PT em campo' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalPageOverflow(page);

    const controls = page.locator(
      '.ds-pt-form-page input:not([type="checkbox"]):not([type="radio"]):visible, .ds-pt-form-page select:visible, .ds-pt-form-page textarea:visible',
    );
    expect(await controls.count()).toBeGreaterThan(0);
    for (let index = 0; index < await controls.count(); index += 1) {
      const control = controls.nth(index);
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      const controlInfo = await control.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        name: element.getAttribute('name'),
        type: element.getAttribute('type'),
        fontSize: window.getComputedStyle(element).fontSize,
      }));
      expect(box!.height, JSON.stringify(controlInfo)).toBeGreaterThanOrEqual(44);
      if ((page.viewportSize()?.width || 0) < 768) {
        expect(Number.parseFloat(controlInfo.fontSize), JSON.stringify(controlInfo)).toBeGreaterThanOrEqual(16);
      }
    }
  });
});
