import {
  clearFetchAllPagesCache,
  fetchAllPages,
  type PaginatedResponse,
} from "./pagination";

describe("fetchAllPages", () => {
  beforeEach(() => {
    clearFetchAllPagesCache();
  });

  it("carrega páginas em batches paralelos e mantém o resultado completo", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await fetchAllPages<number>({
      fetchPage: async (page) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);

        await new Promise((resolve) => setTimeout(resolve, 5));

        inFlight -= 1;
        return {
          data: [page],
          total: 7,
          page,
          lastPage: 7,
        };
      },
      batchSize: 3,
      limit: 1,
      maxPages: 10,
    });

    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("executa callback de progresso durante o carregamento", async () => {
    const progress: Array<[number, number, number]> = [];

    await fetchAllPages<number>({
      fetchPage: async (page) => ({
        data: [page],
        total: 4,
        page,
        lastPage: 4,
      }),
      batchSize: 2,
      limit: 1,
      onProgress: (loaded, total, items) => {
        progress.push([loaded, total, items]);
      },
    });

    expect(progress[0]).toEqual([1, 4, 1]);
    expect(progress[progress.length - 1]).toEqual([4, 4, 4]);
  });

  it("respeita AbortSignal e interrompe o fluxo", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchAllPages({
        fetchPage: async (page) => ({
          data: [page],
          total: 1,
          page,
          lastPage: 1,
        }),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("usa cache por cacheKey dentro de 30s", async () => {
    let calls = 0;

    const fetchPage = async (page: number) => {
      calls += 1;
      return {
        data: [page],
        total: 2,
        page,
        lastPage: 2,
      };
    };

    const first = await fetchAllPages<number>({
      fetchPage,
      cacheKey: "GET:/trainings?limit=1",
      limit: 1,
    });
    const second = await fetchAllPages<number>({
      fetchPage,
      cacheKey: "GET:/trainings?limit=1",
      limit: 1,
    });

    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  it("não repovoa o cache depois de uma limpeza de sessão durante a busca", async () => {
    let resolveStale!: (value: PaginatedResponse<number>) => void;
    const staleResponse = new Promise<PaginatedResponse<number>>((resolve) => {
      resolveStale = resolve;
    });

    const staleRequest = fetchAllPages<number>({
      cacheKey: "GET:/users?limit=1",
      limit: 1,
      fetchPage: async () => staleResponse,
    });

    await Promise.resolve();
    clearFetchAllPagesCache();
    resolveStale({ data: [1], total: 1, page: 1, lastPage: 1 });
    await staleRequest;

    let freshCalls = 0;
    const fresh = await fetchAllPages<number>({
      cacheKey: "GET:/users?limit=1",
      limit: 1,
      fetchPage: async () => {
        freshCalls += 1;
        return { data: [2], total: 1, page: 1, lastPage: 1 };
      },
    });

    expect(fresh).toEqual([2]);
    expect(freshCalls).toBe(1);
  });
});
