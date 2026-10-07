import { expect, test } from "@playwright/test";

const apiOrigin = process.env.NEXT_PUBLIC_API_URL || "";
const accessToken = process.env.DDS_CERT_ACCESS_TOKEN || "";
const companyId = "00000000-0000-4000-8000-000000000001";
const siteId = "00000000-0000-4000-8000-000000000002";
const userId = "f84d7cd4-6fee-470c-9bc7-f882eb37d6f5";

function syntheticAuthBody() {
  return {
    accessToken,
    user: {
      id: userId,
      nome: "Usuário DDS Sintético",
      email: "dds-cert@example.invalid",
      cpf: null,
      role: "Administrador da Empresa",
      company_id: companyId,
      site_id: siteId,
      site_ids: [siteId],
      profile_id: "synthetic-dds-admin",
      created_at: "2026-08-16T00:00:00.000Z",
      updated_at: "2026-08-16T00:00:00.000Z",
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

test.describe("DDS - certificação autenticada no ambiente sintético", () => {
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
        headers: {
          "set-cookie": "refresh_csrf=synthetic; Path=/; SameSite=Lax",
        },
        body: JSON.stringify({ csrfToken: "synthetic-csrf-token" }),
      });
    });

    await page.route("**/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(syntheticAuthBody()),
      });
    });

    await page.route("**/auth/refresh", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accessToken }),
      });
    });

    await page.route("**/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "set-cookie": "refresh_csrf=synthetic; Path=/; SameSite=Lax",
        },
        body: JSON.stringify(syntheticAuthBody()),
      });
    });
  });

  test("autentica, abre o módulo de DDS e cria um registro governado", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("CPF").fill("00000000000");
    await page.locator("#senha").fill("senha-sintetica");
    await page.getByRole("button", { name: "Acessar" }).click();

    await expect(page).toHaveURL(/\/dashboard(?:\/)?$/);
    await page.goto("/dashboard/dds");
    await expect(page.getByText("Cockpit DDS", { exact: true })).toBeVisible();
    const onboardingClose = page.getByRole("button", { name: "Fechar modal" });
    await onboardingClose
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => onboardingClose.click())
      .catch(() => undefined);
    await page.getByRole("link", { name: "Novo DDS" }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/dds\/new/);
    await expect(page.getByLabel("Tema do DDS")).toBeVisible();

    await page.getByLabel("Tema do DDS").fill("DDS certificação runtime 2026-08-16");
    await page.getByLabel("Conteúdo do DDS").fill(
      "Registro sintético para prova autenticada, tenant, site e governança.",
    );
    await page.getByLabel("Data do DDS").fill("2026-08-16");
    await page.getByLabel("Site ou unidade do DDS").selectOption(siteId);
    await page.locator("#dds-facilitador-id").selectOption({ index: 1 });
    await page
      .getByRole("button", { name: /capturar assinatura e incluir no DDS/i })
      .first()
      .click();
    await page.getByRole("button", { name: "Digital", exact: true }).click();
    const signatureCanvas = page.locator("canvas").last();
    await expect(signatureCanvas).toBeVisible();
    const canvasBox = await signatureCanvas.boundingBox();
    if (!canvasBox) throw new Error("canvas de assinatura indisponível");
    await page.mouse.move(canvasBox.x + 30, canvasBox.y + canvasBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width - 30, canvasBox.y + canvasBox.height / 2 + 8, {
      steps: 4,
    });
    await page.mouse.up();
    await page.getByRole("button", { name: "Confirmar assinatura" }).click();
    await page.getByRole("button", { name: "Salvar DDS" }).click();

    await expect(page).toHaveURL(/\/dashboard\/dds\/edit\//, { timeout: 30_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("mantém navegação essencial operável por teclado em mobile", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("CPF").fill("00000000000");
    await page.locator("#senha").fill("senha-sintetica");
    await page.getByRole("button", { name: "Acessar" }).click();
    await expect(page).toHaveURL(/\/dashboard(?:\/)?$/);
    await page.goto("/dashboard/dds");
    await expect(page.getByText("Cockpit DDS", { exact: true })).toBeVisible();
    const onboardingClose = page.getByRole("button", { name: "Fechar modal" });
    await onboardingClose
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => onboardingClose.click())
      .catch(() => undefined);

    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
