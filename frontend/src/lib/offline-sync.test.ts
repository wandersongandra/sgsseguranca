import api from "@/lib/api";
import {
  enqueueOfflineMutation,
  getOfflineQueueSnapshot,
  removeOfflineQueueItem,
  retryOfflineQueueItem,
} from "./offline-sync";
import { sessionStore } from "./sessionStore";
import { selectedTenantStore } from "./selectedTenantStore";
import { siteStore } from "./siteStore";

jest.mock("@/lib/api", () => ({
  __esModule: true,
  default: {
    request: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock: IndexedDB seguro — substituído por Map em memória nos testes
// ---------------------------------------------------------------------------

const mockSyncStore: Record<string, unknown> = {};

jest.mock("./offline-db-secure", () => ({
  secureOfflineDB: {
    get: jest.fn(async (_store: string, key: string) => mockSyncStore[key] ?? null),
    set: jest.fn(async (_store: string, key: string, value: unknown) => {
      mockSyncStore[key] = value;
    }),
    del: jest.fn(async (_store: string, key: string) => {
      delete mockSyncStore[key];
    }),
    keys: jest.fn(async () => Object.keys(mockSyncStore)),
    clear: jest.fn(async () => {
      Object.keys(mockSyncStore).forEach((k) => delete mockSyncStore[k]);
    }),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("offline-sync", () => {
  beforeEach(async () => {
    // Limpa o mock do IndexedDB entre testes
    Object.keys(mockSyncStore).forEach((k) => delete mockSyncStore[k]);

    Object.defineProperty(window, "crypto", {
      value: {
        randomUUID: () => "offline-test-id",
        getRandomValues: (array: Uint8Array) => {
          array.fill(1);
          return array;
        },
        subtle: {
          generateKey: jest.fn(async () => ({ type: "secret" })),
          encrypt: jest.fn(
            async (_algorithm: unknown, _key: unknown, data: BufferSource) => data,
          ),
          decrypt: jest.fn(
            async (_algorithm: unknown, _key: unknown, data: BufferSource) => data,
          ),
        },
      },
      configurable: true,
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
    sessionStore.set({ userId: "user-1", companyId: "company-1", user: { id: "user-1", companyId: "company-1", isAdminGeral: false } });
    await selectedTenantStore.set({ companyId: "company-1", companyName: "Empresa" });
    await siteStore.set({ siteId: "site-1", siteName: "Obra", companyId: "company-1" });
    jest.clearAllMocks();
    jest.spyOn(window, "dispatchEvent").mockImplementation(() => true);
    Object.defineProperty(window.navigator, "onLine", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("deduplica enqueue pela dedupeKey e preserva um identificador estavel", async () => {
    const first = await enqueueOfflineMutation({
      url: "/aprs",
      method: "post",
      data: { numero: "APR-1" },
      label: "APR",
      correlationId: "apr:draft:draft-1",
      dedupeKey: "apr:create:draft-1",
      meta: {
        module: "apr",
        entityType: "apr_base",
        draftId: "draft-1",
      },
    });
    const second = await enqueueOfflineMutation({
      url: "/aprs",
      method: "post",
      data: { numero: "APR-1B" },
      label: "APR",
      correlationId: "apr:draft:draft-1",
      dedupeKey: "apr:create:draft-1",
      meta: {
        module: "apr",
        entityType: "apr_base",
        draftId: "draft-1",
      },
    });

    const snapshot = await getOfflineQueueSnapshot();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.id).toBe(first.id);
    expect(snapshot[0]!.correlationId).toBe("apr:draft:draft-1");
    expect(snapshot[0]!.data).toEqual({ numero: "APR-1B" });
    expect((second as { deduplicated?: boolean }).deduplicated).toBe(true);
  });

  it("mantem a mesma entrada durante retentativas sem duplicar a fila", async () => {
    (api.request as jest.Mock).mockRejectedValue(new Error("falha de rede"));

    const queued = await enqueueOfflineMutation({
      url: "/aprs",
      method: "post",
      data: { numero: "APR-2" },
      label: "APR",
      correlationId: "apr:draft:draft-2",
      dedupeKey: "apr:create:draft-2",
      meta: {
        module: "apr",
        entityType: "apr_base",
        draftId: "draft-2",
      },
    });

    const result = await retryOfflineQueueItem(queued.id);
    const snapshot = await getOfflineQueueSnapshot();

    expect(result.status).toBe("pending");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.id).toBe(queued.id);
    expect(snapshot[0]!.state).toBe("retry_waiting");
    expect(snapshot[0]!.attempts).toBe(1);
  });

  it("remove explicitamente a entrada da fila sem deixar resíduo duplicado", async () => {
    const queued = await enqueueOfflineMutation({
      url: "/aprs",
      method: "post",
      data: { numero: "APR-3" },
      label: "APR",
      correlationId: "apr:draft:draft-3",
      dedupeKey: "apr:create:draft-3",
    });

    await removeOfflineQueueItem(queued.id);

    expect(await getOfflineQueueSnapshot()).toEqual([]);
  });

  it("minimiza payload sensivel antes de persistir na fila offline", async () => {
    await enqueueOfflineMutation({
      url: "/aprs",
      method: "post",
      data: {
        titulo: "APR",
        cpf: "12345678900",
        evidencia: { imageDataUrl: "data:image/png;base64,abc" },
        headers: { Authorization: "Bearer token" },
      },
      headers: {
        Authorization: "Bearer token",
        "x-company-id": "company-1",
      },
      label: "APR",
    });

    const snapshot = await getOfflineQueueSnapshot();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.data).toEqual({ titulo: "APR" });
    expect(snapshot[0]!.headers).toEqual({ "x-company-id": "company-1" });
  });

  it("nao persiste fila em plaintext no localStorage (invariante IndexedDB)", async () => {
    const originalCrypto = window.crypto;
    Object.defineProperty(window, "crypto", {
      value: { randomUUID: () => "offline-no-crypto" },
      configurable: true,
    });

    try {
      await enqueueOfflineMutation({
        url: "/aprs",
        method: "post",
        data: { titulo: "APR" },
        label: "APR",
      });
    } catch {
      // Pode falhar se IndexedDB lançar por falta de crypto — comportamento esperado
    }

    // Com a implementação IndexedDB, localStorage nunca é usado para a fila
    expect(window.localStorage.getItem("gst.offline.queue")).toBeNull();

    Object.defineProperty(window, "crypto", {
      value: originalCrypto,
      configurable: true,
    });
  });

  it("nao reproduz mutacao quando a sessao muda antes do replay", async () => {
    const queued = await enqueueOfflineMutation({
      url: "/aprs",
      method: "patch",
      data: { titulo: "APR protegida" },
      label: "APR",
    });

    sessionStore.clear();
    sessionStore.set({ userId: "user-2", companyId: "company-1", user: { id: "user-2", companyId: "company-1", isAdminGeral: false } });
    const result = await retryOfflineQueueItem(queued.id);

    expect(result.status).toBe("sent");
    expect(api.request).not.toHaveBeenCalled();
    expect(await getOfflineQueueSnapshot()).toEqual([]);
  });
});
