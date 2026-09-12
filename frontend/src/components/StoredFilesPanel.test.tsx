import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoredFilesPanel } from './StoredFilesPanel';

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

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockApiGet(...args) },
}));

jest.mock('@/lib/print-utils', () => ({
  openPdfForPrint: jest.fn(),
  preparePdfPrintWindow: jest.fn(),
  resolveSafeBrowserUrl: (url: string) => {
    if (url.startsWith('https://evil.example/')) {
      throw new Error('URL bloqueada pela política de segurança.');
    }
    return url;
  },
}));

const listStoredFilesMock = jest.fn();
const mockApiGet = jest.fn();
const getPdfAccessMock = jest.fn();

function file(id: string, companyId: string) {
  return {
    entityId: id,
    title: `PT ${id}`,
    date: '2026-09-11T12:00:00.000Z',
    companyId,
    fileKey: `pts/${id}.pdf`,
    folderPath: `pts/${companyId}`,
    originalName: `${id}.pdf`,
  };
}

describe('StoredFilesPanel tenant isolation', () => {
  beforeEach(() => {
    tenantListeners.clear();
    siteListeners.clear();
    currentTenant = { companyId: 'company-a', companyName: 'Empresa A' };
    currentSite = { siteId: 'site-a', siteName: 'Obra A', companyId: 'company-a' };
    listStoredFilesMock.mockReset();
    mockApiGet.mockReset();
    getPdfAccessMock.mockReset();
  });

  it('limpa arquivos antigos e recarrega após trocar empresa', async () => {
    listStoredFilesMock
      .mockResolvedValueOnce([file('a', 'company-a')])
      .mockResolvedValueOnce([file('b', 'company-b')]);

    render(
      <StoredFilesPanel
        title="Arquivos PT"
        description="Arquivos governados"
        listStoredFiles={listStoredFilesMock}
        getPdfAccess={jest.fn()}
        companyOptions={[]}
      />,
    );

    await waitFor(() => expect(screen.getByText('PT a')).toBeInTheDocument());

    act(() => {
      currentTenant = { companyId: 'company-b', companyName: 'Empresa B' };
      currentSite = { siteId: 'site-b', siteName: 'Obra B', companyId: 'company-b' };
      tenantListeners.forEach((listener) => listener(currentTenant));
      siteListeners.forEach((listener) => listener(currentSite));
    });

    expect(screen.queryByText('PT a')).not.toBeInTheDocument();
    await waitFor(() => expect(listStoredFilesMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('PT b')).toBeInTheDocument());
  });

  it('pode ocultar filtro de empresa quando o tenant é definido pelo contexto', async () => {
    listStoredFilesMock.mockResolvedValue([]);

    render(
      <StoredFilesPanel
        title="Arquivos PT"
        description="Arquivos governados"
        listStoredFiles={listStoredFilesMock}
        getPdfAccess={jest.fn()}
        showCompanyFilter={false}
      />,
    );

    expect(screen.queryByLabelText('Filtrar arquivos por empresa')).not.toBeInTheDocument();
    await waitFor(() => expect(listStoredFilesMock).toHaveBeenCalled());
  });

  it('bloqueia URL de arquivo não permitida antes de requisitar o blob', async () => {
    listStoredFilesMock.mockResolvedValue([file('a', 'company-a')]);
    getPdfAccessMock.mockResolvedValue({ url: 'https://evil.example/pt.pdf' });

    render(
      <StoredFilesPanel
        title="Arquivos PT"
        description="Arquivos governados"
        listStoredFiles={listStoredFilesMock}
        getPdfAccess={getPdfAccessMock}
      />,
    );

    await waitFor(() => expect(screen.getByText('PT a')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Baixar' }));

    await waitFor(() => expect(getPdfAccessMock).toHaveBeenCalledWith('a'));
    expect(mockApiGet).not.toHaveBeenCalled();
  });
});
