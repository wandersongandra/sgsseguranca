import api from "@/lib/api";
import { aprsService } from "@/services/aprsService";
import { enqueueOfflineMutation } from "@/lib/offline-sync";
import { queryKeys } from "@/lib/query-keys";

jest.mock("@/lib/api", () => ({
  __esModule: true,
  TIMEOUT_PDF: 180000,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
  },
}));

jest.mock("@/lib/offline-sync", () => ({
  enqueueOfflineMutation: jest.fn(),
}));

jest.mock("@/lib/offline-cache", () => ({
  setOfflineCache: jest.fn(),
  getOfflineCache: jest.fn(),
  consumeOfflineCache: jest.fn(),
  createOfflineCacheContext: jest.fn(() => ({})),
  CACHE_TTL: { CRITICAL: 60000, RECORD: 300000 },
  isOfflineRequestError: jest.fn(() => false),
}));

jest.mock("@/lib/offline-db-secure", () => ({
  secureOfflineDB: {
    get: jest.fn(),
    set: jest.fn(),
    keys: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
  },
}));

describe("aprsService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("gera chaves segregadas por empresa e obra", () => {
    const keyX = queryKeys.aprs.list({
      companyId: "company-x",
      siteId: "site-x",
      page: 1,
      limit: 20,
      filters: { search: "abc" },
    });
    const keyY = queryKeys.aprs.list({
      companyId: "company-x",
      siteId: "site-y",
      page: 1,
      limit: 20,
      filters: { search: "abc" },
    });

    expect(keyX).not.toEqual(keyY);
  });

  it("usa companyId e siteId explicitamente na listagem", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { data: [], total: 0, page: 1, lastPage: 1 },
    });

    await aprsService.findPaginated({
      companyId: "company-x",
      siteId: "site-x",
      page: 1,
      limit: 20,
      search: "segurança",
      signal: new AbortController().signal,
    });

    expect(api.get).toHaveBeenCalledWith(
      "/aprs",
      expect.objectContaining({
        params: expect.objectContaining({
          company_id: "company-x",
          site_id: "site-x",
          search: "segurança",
        }),
      }),
    );
  });

  it("exige companyId para listar APRs", async () => {
    await expect(
      aprsService.findPaginated({
        page: 1,
        limit: 20,
      }),
    ).rejects.toThrow("companyId é obrigatório para listar APRs.");
  });

  it("lista APRs sem siteId (filtro opcional no backend — sem obra ativa selecionada)", async () => {
    // Regressão (achado real, confirmado ao vivo em produção): site_id é
    // documentado como filtro OPCIONAL em GET /aprs no backend
    // (aprs.controller.ts: "Filtra a fila por obra/unidade"). Exigi-lo aqui
    // travava a listagem para qualquer usuário sem uma obra ativa
    // selecionada no dashboard (siteStore, um seletor separado e opcional).
    (api.get as jest.Mock).mockResolvedValue({
      data: { data: [], total: 0, page: 1, lastPage: 1 },
    });

    await aprsService.findPaginated({
      companyId: "company-x",
      page: 1,
      limit: 20,
    });

    expect(api.get).toHaveBeenCalledWith(
      "/aprs",
      expect.objectContaining({
        params: expect.objectContaining({ company_id: "company-x" }),
      }),
    );
    const [, callOptions] = (api.get as jest.Mock).mock.calls.at(-1) as [
      string,
      { params: Record<string, unknown> },
    ];
    expect(callOptions.params).not.toHaveProperty("site_id");
  });

  it("usa a mesma key normalizada para filtros com ordem diferente", () => {
    const a = queryKeys.aprs.list({
      companyId: "company-x",
      siteId: "site-x",
      page: 1,
      limit: 20,
      filters: { b: 2, a: 1 },
    });
    const b = queryKeys.aprs.list({
      companyId: "company-x",
      siteId: "site-x",
      page: 1,
      limit: 20,
      filters: { a: 1, b: 2 },
    });

    expect(a).toEqual(b);
  });

  it("gera chave detalhada segregada por obra", () => {
    const detailX = queryKeys.aprs.detail({
      aprId: "apr-1",
      companyId: "company-x",
      siteId: "site-x",
    });
    const detailY = queryKeys.aprs.detail({
      aprId: "apr-1",
      companyId: "company-x",
      siteId: "site-y",
    });

    expect(detailX).not.toEqual(detailY);
  });
});
