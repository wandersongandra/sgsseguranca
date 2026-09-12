import { act, renderHook, waitFor } from '@testing-library/react';
import { usePts } from './usePts';

type TenantScope = { companyId: string; companyName: string } | null;
type SiteScope = { siteId: string; siteName: string; companyId: string } | null;

const tenantListeners = new Set<(tenant: TenantScope) => void>();
const siteListeners = new Set<(site: SiteScope) => void>();
let currentTenant: TenantScope = { companyId: 'company-a', companyName: 'Empresa A' };
let currentSite: SiteScope = { siteId: 'site-a', siteName: 'Obra A', companyId: 'company-a' };

jest.mock('@/lib/selectedTenantStore', () => ({
  selectedTenantStore: {
    get: () => currentTenant,
    subscribe: (listener: (tenant: TenantScope) => void) => {
      tenantListeners.add(listener);
      return () => tenantListeners.delete(listener);
    },
  },
}));

jest.mock('@/lib/siteStore', () => ({
  siteStore: {
    get: () => currentSite,
    subscribe: (listener: (site: SiteScope) => void) => {
      siteListeners.add(listener);
      return () => siteListeners.delete(listener);
    },
  },
}));

const mockFindPaginated = jest.fn();
const mockGetAnalyticsOverview = jest.fn();
const mockGetApprovalRules = jest.fn();
const mockReject = jest.fn();
const mockFindOne = jest.fn();
const mockGetPdfAccess = jest.fn();
const mockFindByDocument = jest.fn();
const mockGeneratePtPdf = jest.fn();

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    findPaginated: (...args: unknown[]) => mockFindPaginated(...args),
    getAnalyticsOverview: (...args: unknown[]) => mockGetAnalyticsOverview(...args),
    getApprovalRules: (...args: unknown[]) => mockGetApprovalRules(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    getPdfAccess: (...args: unknown[]) => mockGetPdfAccess(...args),
    reject: (...args: unknown[]) => mockReject(...args),
  },
  getPtApprovalBlockedPayload: jest.fn(() => null),
}));

jest.mock('@/services/aiService', () => ({
  aiService: { getInsights: jest.fn() },
}));

jest.mock('@/services/signaturesService', () => ({
  signaturesService: { findByDocument: (...args: unknown[]) => mockFindByDocument(...args) },
}));

jest.mock('@/services/usersService', () => ({
  usersService: { getWorkerTimelineById: jest.fn() },
}));

jest.mock('@/lib/featureFlags', () => ({
  isAiEnabled: jest.fn(() => false),
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

jest.mock('@/lib/pdf/ptGenerator', () => ({
  generatePtPdf: (...args: unknown[]) => mockGeneratePtPdf(...args),
}));

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('usePts mutation safety', () => {
  beforeEach(() => {
    tenantListeners.clear();
    siteListeners.clear();
    currentTenant = { companyId: 'company-a', companyName: 'Empresa A' };
    currentSite = { siteId: 'site-a', siteName: 'Obra A', companyId: 'company-a' };
    mockFindPaginated.mockReset();
    mockFindPaginated.mockResolvedValue({ data: [], total: 0, lastPage: 1 });
    mockGetAnalyticsOverview.mockReset();
    mockGetAnalyticsOverview.mockResolvedValue({
      totalPts: 0,
      aprovadas: 0,
      pendentes: 0,
      canceladas: 0,
      encerradas: 0,
      expiradas: 0,
    });
    mockGetApprovalRules.mockReset();
    mockGetApprovalRules.mockResolvedValue({
      blockCriticalRiskWithoutEvidence: true,
      blockWorkerWithoutValidMedicalExam: false,
      blockWorkerWithExpiredBlockingTraining: true,
      requireAtLeastOneExecutante: true,
    });
    mockReject.mockReset();
    mockFindOne.mockReset();
    mockGetPdfAccess.mockReset();
    mockFindByDocument.mockReset();
    mockGeneratePtPdf.mockReset();
  });

  it('envia uma única reprovação quando o mesmo alvo é confirmado duas vezes', async () => {
    const pendingReject = deferred<unknown>();
    mockReject.mockReturnValue(pendingReject.promise);

    const { result } = renderHook(() => usePts());

    await waitFor(() => expect(mockFindPaginated).toHaveBeenCalled());

    act(() => {
      result.current.handleReject('pt-1');
    });
    await waitFor(() => expect(result.current.rejectTargetId).toBe('pt-1'));

    let firstAttempt!: Promise<void>;
    let secondAttempt!: Promise<void>;
    act(() => {
      firstAttempt = result.current.confirmReject('Motivo válido');
      secondAttempt = result.current.confirmReject('Motivo válido');
    });

    pendingReject.resolve({});
    await act(async () => {
      await Promise.all([firstAttempt, secondAttempt]);
    });

    expect(mockReject).toHaveBeenCalledTimes(1);
  });

  it('não permite que uma resposta de página antiga sobrescreva a página atual', async () => {
    const pageTwo = deferred<{ data: Array<{ id: string }>; total: number; lastPage: number }>();
    const pageThree = deferred<{ data: Array<{ id: string }>; total: number; lastPage: number }>();

    mockFindPaginated.mockImplementation(({ page }: { page: number }) => {
      if (page === 2) return pageTwo.promise;
      if (page === 3) return pageThree.promise;
      return Promise.resolve({ data: [], total: 0, lastPage: 3 });
    });

    const { result } = renderHook(() => usePts());

    await waitFor(() => expect(mockFindPaginated).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })));

    act(() => result.current.setPage(2));
    await waitFor(() => expect(mockFindPaginated).toHaveBeenCalledWith(expect.objectContaining({ page: 2 })));

    act(() => result.current.setPage(3));
    await waitFor(() => expect(mockFindPaginated).toHaveBeenCalledWith(expect.objectContaining({ page: 3 })));

    await act(async () => {
      pageThree.resolve({ data: [{ id: 'pt-page-three' }], total: 1, lastPage: 3 });
      await pageThree.promise;
    });
    await waitFor(() => expect(result.current.filteredPts.map((pt) => pt.id)).toEqual(['pt-page-three']));

    await act(async () => {
      pageTwo.resolve({ data: [{ id: 'pt-page-two' }], total: 1, lastPage: 3 });
      await pageTwo.promise;
    });

    expect(result.current.filteredPts.map((pt) => pt.id)).toEqual(['pt-page-three']);
  });

  it('limpa dados em memória e recarrega a PT após troca de empresa', async () => {
    mockFindPaginated
      .mockResolvedValueOnce({
        data: [{ id: 'pt-company-a' }],
        total: 1,
        lastPage: 1,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'pt-company-b' }],
        total: 1,
        lastPage: 1,
      });

    const { result } = renderHook(() => usePts());

    await waitFor(() => expect(result.current.filteredPts.map((pt) => pt.id)).toEqual(['pt-company-a']));

    act(() => {
      currentTenant = { companyId: 'company-b', companyName: 'Empresa B' };
      currentSite = { siteId: 'site-b', siteName: 'Obra B', companyId: 'company-b' };
      tenantListeners.forEach((listener) => listener(currentTenant));
      siteListeners.forEach((listener) => listener(currentSite));
    });

    await waitFor(() => expect(mockFindPaginated).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.filteredPts.map((pt) => pt.id)).toEqual(['pt-company-b']),
    );
  });

  it('revoga a URL temporária quando imprime uma cópia local', async () => {
    const pt = {
      id: 'pt-1',
      titulo: 'PT teste',
      numero: '1',
      status: 'Pendente',
      pdf_file_key: null,
    } as never;
    const createObjectURL = jest.fn(() => 'blob:pt-local');
    const revokeObjectURL = jest.fn();

    mockFindOne.mockResolvedValue(pt);
    mockFindByDocument.mockResolvedValue([]);
    mockGeneratePtPdf.mockResolvedValue({ base64: 'encoded-pdf', filename: 'PT_1.pdf' });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });

    const { result } = renderHook(() => usePts());
    await waitFor(() => expect(mockFindPaginated).toHaveBeenCalled());

    jest.useFakeTimers();
    try {
      await act(async () => {
        await result.current.handlePrint('pt-1');
      });

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).not.toHaveBeenCalled();

      act(() => jest.advanceTimersByTime(60_000));

      expect(revokeObjectURL).toHaveBeenCalledWith('blob:pt-local');
    } finally {
      jest.useRealTimers();
    }
  });
});
