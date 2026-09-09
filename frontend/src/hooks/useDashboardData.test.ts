import { act, renderHook, waitFor } from '@testing-library/react';

type Tenant = { companyId: string; companyName: string } | null;

const tenantListeners = new Set<(t: Tenant) => void>();
let currentTenant: Tenant = { companyId: 'tenant-a', companyName: 'Tenant A' };

function setTenant(next: Tenant) {
  currentTenant = next;
  tenantListeners.forEach((l) => l(next));
}

jest.mock('@/lib/selectedTenantStore', () => ({
  selectedTenantStore: {
    get: () => currentTenant,
    set: (t: Tenant) => setTenant(t),
    subscribe: (fn: (t: Tenant) => void) => {
      tenantListeners.add(fn);
      return () => {
        tenantListeners.delete(fn);
      };
    },
  },
}));

const getSummary = jest.fn();
const getPendingQueue = jest.fn();

jest.mock('@/services/dashboardService', () => ({
  dashboardService: {
    getSummary: (...args: unknown[]) => getSummary(...args),
    getPendingQueue: (...args: unknown[]) => getPendingQueue(...args),
  },
}));

const summaryInvalidateAll = jest.fn();
const queueInvalidateAll = jest.fn();

// Objetos estáticos por chave de cache para que referências não mudem entre
// renders e os useEffects de token funcionem corretamente no ambiente de teste.
const cacheControllers: Record<
  string,
  { fetch: jest.Mock; invalidate: jest.Mock; invalidateAll: jest.Mock }
> = {};

jest.mock('@/hooks/useCachedFetch', () => ({
  useCachedFetch: (cacheKey: string, fetcher: (...args: unknown[]) => Promise<unknown>) => {
    if (!cacheControllers[cacheKey]) {
      const isSummary = cacheKey.includes('summary');
      cacheControllers[cacheKey] = {
        fetch: jest.fn((...args: unknown[]) => fetcher(...args)),
        invalidate: jest.fn(),
        invalidateAll: isSummary ? summaryInvalidateAll : queueInvalidateAll,
      };
    } else {
      // Mantém a referência estável mas atualiza o fetcher subjacente
      cacheControllers[cacheKey].fetch.mockImplementation((...args: unknown[]) => fetcher(...args));
    }
    return cacheControllers[cacheKey];
  },
}));

// Usa o caminho canônico — o jest.config.cjs faz moduleNameMapper para @/ → <rootDir>
import { useDashboardData } from '@/hooks/useDashboardData';

const SUMMARY_FIXTURE = {
  expiringEpis: [],
  expiringTrainings: [],
  pendingApprovals: { aprs: 1, pts: 0, checklists: 0, nonconformities: 0 },
  riskSummary: { alto: 1, medio: 2, baixo: 3 },
  siteCompliance: [],
  recentActivities: [],
  actionPlanItems: [],
};

const QUEUE_FIXTURE = {
  degraded: false,
  failedSources: [],
  summary: {
    total: 5,
    totalFound: 5,
    hasMore: false,
    critical: 1,
    high: 1,
    medium: 3,
    documents: 2,
    health: 1,
    actions: 2,
    slaBreached: 0,
    slaDueToday: 1,
    slaDueSoon: 2,
  },
  items: [],
};

describe('useDashboardData', () => {
  beforeEach(() => {
    getSummary.mockReset();
    getPendingQueue.mockReset();
    summaryInvalidateAll.mockReset();
    queueInvalidateAll.mockReset();
    // Limpa cache de controllers entre testes para evitar contaminação
    for (const key of Object.keys(cacheControllers)) {
      delete cacheControllers[key];
    }
    currentTenant = { companyId: 'tenant-a', companyName: 'Tenant A' };
  });

  it('expõe summary/queue após fetch bem-sucedido e registra lastUpdatedAt', async () => {
    getSummary.mockResolvedValue(SUMMARY_FIXTURE);
    getPendingQueue.mockResolvedValue(QUEUE_FIXTURE);

    const { result } = renderHook(() => useDashboardData());

    await waitFor(() => {
      expect(result.current.summary.loading).toBe(false);
      expect(result.current.pendingQueue.loading).toBe(false);
    });

    expect(result.current.summary.data).toEqual(SUMMARY_FIXTURE);
    expect(result.current.pendingQueue.data).toEqual(QUEUE_FIXTURE);
    expect(result.current.lastUpdatedAt).toBeInstanceOf(Date);
    expect(result.current.summary.error).toBeNull();
    expect(result.current.pendingQueue.error).toBeNull();
  });

  it('preenche campo error ao falhar o fetch do summary', async () => {
    getSummary.mockRejectedValue(new Error('boom'));
    getPendingQueue.mockResolvedValue(QUEUE_FIXTURE);

    const { result } = renderHook(() => useDashboardData());

    await waitFor(() => {
      expect(result.current.summary.loading).toBe(false);
    });

    expect(result.current.summary.error).toBeInstanceOf(Error);
    expect(result.current.summary.error?.message).toBe('boom');
    expect(result.current.summary.data).toBeNull();
  });

  it('refreshAll invalida ambos os caches e força re-fetch', async () => {
    getSummary.mockResolvedValue(SUMMARY_FIXTURE);
    getPendingQueue.mockResolvedValue(QUEUE_FIXTURE);

    const { result } = renderHook(() => useDashboardData());

    await waitFor(() => expect(result.current.summary.loading).toBe(false));

    act(() => {
      result.current.refreshAll();
    });

    // Após refreshAll ambos os caches devem ser invalidados imediatamente
    expect(summaryInvalidateAll).toHaveBeenCalledTimes(1);
    expect(queueInvalidateAll).toHaveBeenCalledTimes(1);

    // Os fetches disparam novamente após a invalidação
    await waitFor(() => {
      expect(getSummary.mock.calls.length).toBeGreaterThan(1);
      expect(getPendingQueue.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('dispara re-fetch quando o tenant selecionado muda', async () => {
    getSummary.mockResolvedValue(SUMMARY_FIXTURE);
    getPendingQueue.mockResolvedValue(QUEUE_FIXTURE);

    const { result } = renderHook(() => useDashboardData());

    await waitFor(() => expect(result.current.summary.loading).toBe(false));
    const summaryCallsBefore = getSummary.mock.calls.length;

    // Muda o tenant — o hook observa o store e entra em loading novamente
    act(() => {
      setTenant({ companyId: 'tenant-b', companyName: 'Tenant B' });
    });

    await waitFor(() => {
      // Volta ao loading enquanto busca dados do novo tenant
      expect(result.current.summary.loading).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.summary.loading).toBe(false);
      expect(getSummary.mock.calls.length).toBeGreaterThan(summaryCallsBefore);
    });
  });

  it('não expõe dados do tenant anterior enquanto a nova leitura está pendente', async () => {
    let resolveNextSummary!: (value: typeof SUMMARY_FIXTURE) => void;
    getSummary.mockResolvedValueOnce(SUMMARY_FIXTURE).mockImplementationOnce(
      () =>
        new Promise<typeof SUMMARY_FIXTURE>((resolve) => {
          resolveNextSummary = resolve;
        }),
    );
    getPendingQueue.mockResolvedValue(QUEUE_FIXTURE);

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.summary.loading).toBe(false));
    expect(result.current.summary.data).toEqual(SUMMARY_FIXTURE);

    act(() => {
      setTenant({ companyId: 'tenant-b', companyName: 'Tenant B' });
    });

    await waitFor(() => {
      expect(result.current.summary.loading).toBe(true);
      expect(result.current.summary.data).toBeNull();
      expect(result.current.lastUpdatedAt).toBeNull();
    });

    await act(async () => {
      resolveNextSummary(SUMMARY_FIXTURE);
      await Promise.resolve();
    });
  });

  it('não chama setState após unmount (cancelamento via active flag)', async () => {
    let resolveSummary!: (v: typeof SUMMARY_FIXTURE) => void;
    getSummary.mockImplementation(
      () =>
        new Promise<typeof SUMMARY_FIXTURE>((res) => {
          resolveSummary = res;
        }),
    );
    getPendingQueue.mockResolvedValue(QUEUE_FIXTURE);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderHook(() => useDashboardData());

    unmount();

    await act(async () => {
      resolveSummary(SUMMARY_FIXTURE);
      await Promise.resolve();
    });

    const reactStateWarning = errorSpy.mock.calls.find((args) =>
      String(args[0] ?? '').includes("Can't perform a React state update"),
    );
    expect(reactStateWarning).toBeUndefined();

    errorSpy.mockRestore();
  });
});
