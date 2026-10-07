import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

const apiOrigin = process.env.NEXT_PUBLIC_API_URL || "";
const accessToken = process.env.DDS_CERT_ACCESS_TOKEN || "";

function syntheticAuthBody() {
  return {
    accessToken,
    user: {
      id: "f84d7cd4-6fee-470c-9bc7-f882eb37d6f5",
      nome: "Usuário DDS Sintético",
      email: "dds-cert@example.invalid",
      cpf: null,
      role: "Administrador da Empresa",
      company_id: "00000000-0000-4000-8000-000000000001",
      site_id: "00000000-0000-4000-8000-000000000002",
      site_ids: ["00000000-0000-4000-8000-000000000002"],
      profile_id: "synthetic-dds-admin",
    },
    roles: ["Administrador da Empresa"],
    permissions: [
      "can_view_dds",
      "can_manage_dds",
      "can_approve_dds",
      "can_audit_dds",
      "can_view_documents_registry",
    ],
    isAdminGeral: false,
  };
}

async function installAxe(page: Page) {
  await page.addScriptTag({
    content: fs.readFileSync("node_modules/axe-core/axe.min.js", "utf8"),
  });
}

async function assertAxe(page: Page, routeName: string) {
  await installAxe(page);
  const result = await page.evaluate(async () => {
    const axeApi = (globalThis as typeof globalThis & {
      axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string | null }> }> };
    }).axe;
    return axeApi.run();
  });
  const seriousOrCritical = result.violations.filter((item) =>
    item.impact === "serious" || item.impact === "critical",
  );
  console.log(
    `AXE_ROUTE=${routeName} AXE_VIOLATIONS=${result.violations.length} AXE_SERIOUS_CRITICAL=${seriousOrCritical.length}`,
  );
  expect(seriousOrCritical, `${routeName}: serious/critical Axe violations`).toEqual([]);
}

test.describe("DDS - Axe autenticado no ambiente sintético", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!apiOrigin || !accessToken, "Credencial sintética não configurada");

    await page.route(`${apiOrigin}/**`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    await page.route("**/auth/csrf", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "set-cookie": "refresh_csrf=synthetic; Path=/; SameSite=Lax" },
        body: JSON.stringify({ csrfToken: "synthetic-csrf-token" }),
      });
    });
    await page.route("**/auth/me", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(syntheticAuthBody()) });
    });
    await page.route("**/auth/refresh", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accessToken }) });
    });
    await page.route("**/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "set-cookie": "refresh_csrf=synthetic; Path=/; SameSite=Lax" },
        body: JSON.stringify(syntheticAuthBody()),
      });
    });
  });

  test("não apresenta violações serious/critical no cockpit, lista e formulário DDS", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("CPF").fill("00000000000");
    await page.locator("#senha").fill("senha-sintetica");
    await page.getByRole("button", { name: "Acessar" }).click();
    await expect(page).toHaveURL(/\/dashboard(?:\/)?$/);

    await page.goto("/dashboard");
    await expect(page).toHaveTitle(/dashboard|sgs/i);
    await assertAxe(page, "dashboard");

    await page.goto("/dashboard/dds");
    await expect(page.getByText("Diálogos Diários de Segurança", { exact: true })).toBeVisible();
    const onboardingClose = page.getByRole("button", { name: "Fechar modal" });
    await onboardingClose.waitFor({ state: "visible", timeout: 3_000 }).then(() => onboardingClose.click()).catch(() => undefined);
    await assertAxe(page, "dds-list");

    await page.goto("/dashboard/dds/new");
    await expect(page.getByLabel("Tema do DDS")).toBeVisible();
    await assertAxe(page, "dds-form");
  });
});
