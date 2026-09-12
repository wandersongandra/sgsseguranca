import { act, renderHook, waitFor } from '@testing-library/react';

const tenantListeners = new Set<(tenant: { companyId?: string; companyName?: string } | null) => void>();
const siteListeners = new Set<(site: { siteId?: string; siteName?: string; companyId?: string } | null) => void>();
let currentTenant: { companyId?: string; companyName?: string } | null = { companyId: 'company-x', companyName: 'Empresa X' };
let currentSite: { siteId?: string; siteName?: string; companyId?: string } | null = { siteId: 'site-x', siteName: 'Obra X', companyId: 'company-x' };

jest.mock('@/lib/selectedTenantStore', () => ({
  selectedTenantStore: {
    get: () => currentTenant,
    subscribe: (fn: (tenant: { companyId?: string; companyName?: string } | null) => void) => {
      tenantListeners.add(fn);
      return () => tenantListeners.delete(fn);
    },
    set: async (tenant: typeof currentTenant) => {
      currentTenant = tenant;
      tenantListeners.forEach((listener) => listener(tenant));
    },
    clear: () => {
      currentTenant = null;
      tenantListeners.forEach((listener) => listener(null));
    },
  },
}));

jest.mock('@/lib/siteStore', () => ({
  siteStore: {
    get: () => currentSite,
    subscribe: (fn: (site: typeof currentSite) => void) => {
      siteListeners.add(fn);
      return () => siteListeners.delete(fn);
    },
    set: async (site: typeof currentSite) => {
      currentSite = site;
      siteListeners.forEach((listener) => listener(site));
    },
    clear: () => {
      currentSite = null;
      siteListeners.forEach((listener) => listener(null));
    },
  },
}));

// Usuário comum (não admin_geral): selectedTenantStore fica sempre vazio
// (persistAuthenticatedSession limpa no login); o tenant real vem do JWT via
// sessionStore. Default do mock reflete esse caso mais comum na produção.
let currentSession: { companyId?: string } | null = { companyId: 'company-session' };

jest.mock('@/lib/sessionStore', () => ({
  sessionStore: {
    get: () => currentSession,
  },
}));

const findPaginatedMock = jest.fn();
const getAnalyticsOverviewMock = jest.fn();
const getInsightsMock = jest.fn();

jest.mock('@/services/aprsService', () => ({
  aprsService: {
    findPaginated: (...args: unknown[]) => findPaginatedMock(...args),
    getAnalyticsOverview: (...args: unknown[]) => getAnalyticsOverviewMock(...args),
  },
}));

jest.mock('@/services/aiService', () => ({
  aiService: {
    getInsights: (...args: unknown[]) => getInsightsMock(...args),
  },
}));

jest.mock('@/services/signaturesService', () => ({
  signaturesService: {
    findByDocument: jest.fn(),
  },
}));

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock('@/lib/error-handler', () => ({
  handleApiError: jest.fn(),
}));

jest.mock('@/lib/print-utils', () => ({
  openPdfForPrint: jest.fn(),
  openUrlInNewTab: jest.fn(),
}));

jest.mock('@/lib/pdf/pdfFile', () => ({
  base64ToPdfBlob: jest.fn(),
}));

jest.mock('@/lib/featureFlags', () => ({
  isAiEnabled: () => false,
  isAprAnalyticsEnabled: () => false,
}));

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { useAprs } from './useAprs';

describe('useAprs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentTenant = { companyId: 'company-x', companyName: 'Empresa X' };
    currentSite = { siteId: 'site-x', siteName: 'Obra X', companyId: 'company-x' };
    currentSession = { companyId: 'company-x' };
  });

  it('resolve companyId via sessionStore quando selectedTenantStore está vazio (usuário comum, não admin_geral)', async () => {
    // Regressão: persistAuthenticatedSession limpa selectedTenantStore em TODO
    // login (inclusive de usuários comuns) — sem o fallback para sessionStore,
    // loadAprs() nunca chamava a API para nenhum usuário fora do admin_geral.
    currentTenant = null;
    currentSession = { companyId: 'company-session' };
    currentSite = { siteId: 'site-x', siteName: 'Obra X', companyId: 'company-session' };
    findPaginatedMock.mockResolvedValueOnce({ data: [{ id: 'apr-1' }], total: 1, lastPage: 1 });

    const { result } = renderHook(() => useAprs());

    await waitFor(() => expect(result.current.aprs).toEqual([{ id: 'apr-1' }]));
    expect(findPaginatedMock).toHaveBeenCalledTimes(1);
    expect(result.current.loadError).toBeNull();
  });

  it('não consulta sem obra ativa', async () => {
    currentSite = null;
    const { result } = renderHook(() => useAprs());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(findPaginatedMock).not.toHaveBeenCalled();
    expect(result.current.aprs).toEqual([]);
    expect(result.current.loadError).toBeNull();
  });

  it('descarta a resposta atrasada da X quando Y termina primeiro', async () => {
    let resolveX: (value: unknown) => void = () => undefined;
    let resolveY: (value: unknown) => void = () => undefined;

    findPaginatedMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveX = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveY = resolve; }));

    const { result } = renderHook(() => useAprs());

    await act(async () => {
      currentSite = { siteId: 'site-y', siteName: 'Obra Y', companyId: 'company-x' };
      siteListeners.forEach((listener) => listener(currentSite));
    });

    await act(async () => {
      resolveY({ data: [{ id: 'apr-y' }], total: 1, lastPage: 1 });
      await Promise.resolve();
    });

    await act(async () => {
      resolveX({ data: [{ id: 'apr-x' }], total: 1, lastPage: 1 });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.aprs).toEqual([{ id: 'apr-y' }]));
    expect(result.current.loadError).toBeNull();
    expect(result.current.aprs).toEqual([{ id: 'apr-y' }]);
    expect(findPaginatedMock).toHaveBeenCalledTimes(2);
  });

  it('descarta erro atrasado da X quando Y já resolveu com sucesso', async () => {
    let rejectX: (error: unknown) => void = () => undefined;
    let resolveY: (value: unknown) => void = () => undefined;

    findPaginatedMock
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectX = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveY = resolve; }));

    const { result } = renderHook(() => useAprs());

    await act(async () => {
      currentSite = { siteId: 'site-y', siteName: 'Obra Y', companyId: 'company-x' };
      siteListeners.forEach((listener) => listener(currentSite));
    });

    await act(async () => {
      resolveY({ data: [{ id: 'apr-y' }], total: 1, lastPage: 1 });
      await Promise.resolve();
    });

    await act(async () => {
      rejectX(new Error('timeout da X'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.aprs).toEqual([{ id: 'apr-y' }]));
    expect(result.current.loadError).toBeNull();
  });
});
