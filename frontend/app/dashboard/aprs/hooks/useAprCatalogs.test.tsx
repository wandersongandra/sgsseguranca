import { renderHook, waitFor } from '@testing-library/react';

let currentSiteStoreValue: { siteId?: string } | null = null;
jest.mock('@/lib/siteStore', () => ({
  siteStore: {
    get: () => currentSiteStoreValue,
  },
}));

let currentSelectedTenant: { companyId?: string } | null = null;
jest.mock('@/lib/selectedTenantStore', () => ({
  selectedTenantStore: {
    get: () => currentSelectedTenant,
  },
}));

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const toastErrorMock = jest.fn();
jest.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const findAllCompaniesMock = jest.fn();
jest.mock('@/services/companiesService', () => ({
  companiesService: {
    findAll: (...args: unknown[]) => findAllCompaniesMock(...args),
  },
}));

jest.mock('@/services/activitiesService', () => ({
  activitiesService: { findAll: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/services/risksService', () => ({
  risksService: { findAll: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/services/episService', () => ({
  episService: { findAll: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/services/toolsService', () => ({
  toolsService: { findAll: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/services/machinesService', () => ({
  machinesService: { findAll: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/services/sitesService', () => ({
  sitesService: { findAll: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/services/usersService', () => ({
  usersService: { findAll: jest.fn().mockResolvedValue([]) },
}));

import { useAprCatalogs } from './useAprCatalogs';

describe('useAprCatalogs', () => {
  const baseOptions = () => ({
    setValue: jest.fn(),
    setActivities: jest.fn(),
    setRisks: jest.fn(),
    setEpis: jest.fn(),
    setTools: jest.fn(),
    setMachines: jest.fn(),
    setSites: jest.fn(),
    setUsers: jest.fn(),
    setCompanies: jest.fn(),
    companies: [] as Array<{ id: string }>,
    sites: [] as Array<{ id: string }>,
    users: [] as Array<{ id: string }>,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentSiteStoreValue = null;
    currentSelectedTenant = null;
  });

  it('carrega a lista de empresas via companiesService.findAll() ao montar (regressão: select "Empresa" ficava sempre vazio)', async () => {
    // Achado real da auditoria: o estado `companies` do AprForm nunca era
    // populado em lugar nenhum do fluxo — o <select> "Empresa" só tinha o
    // placeholder. Como um <select> nativo não reflete um valor via
    // setValue() sem uma <option> correspondente, isso travava a criação de
    // APR para QUALQUER usuário, mesmo com company_id correto no formulário.
    const companies = [
      { id: 'company-1', razao_social: 'Empresa Teste', cnpj: '00.000.000/0001-00', endereco: '', responsavel: '', status: true },
    ];
    findAllCompaniesMock.mockResolvedValueOnce(companies);
    const options = baseOptions();

    renderHook(() => useAprCatalogs(options));

    await waitFor(() => expect(options.setCompanies).toHaveBeenCalledWith(companies));
    expect(findAllCompaniesMock).toHaveBeenCalledTimes(1);
  });

  it('mostra erro e não chama setCompanies quando companiesService.findAll() falha', async () => {
    findAllCompaniesMock.mockRejectedValueOnce(new Error('network down'));
    const options = baseOptions();

    renderHook(() => useAprCatalogs(options));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(options.setCompanies).not.toHaveBeenCalled();
  });

  it('não chama setCompanies após o unmount (guarda de cancelamento)', async () => {
    let resolveFindAll: (value: unknown[]) => void = () => {};
    findAllCompaniesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFindAll = resolve;
      }),
    );
    const options = baseOptions();

    const { unmount } = renderHook(() => useAprCatalogs(options));
    unmount();
    resolveFindAll([{ id: 'company-1' }]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options.setCompanies).not.toHaveBeenCalled();
  });

  describe('auto-preenchimento de company_id/site_id/elaborador_id em Nova APR', () => {
    // Achado real da auditoria v2: mesmo depois de `companies` carregar,
    // setValue("company_id", …) só "gruda" no <select> nativo se a <option>
    // correspondente já existir no DOM naquele exato tick. O efeito original
    // chamava setValue assim que sabia o companyId, sem esperar `companies`
    // ficar pronto — resultado: o valor nunca aparecia, mesmo com o
    // companyId certo resolvido em memória (o submit lia "" direto do DOM).
    beforeEach(() => {
      findAllCompaniesMock.mockResolvedValue([]);
    });

    const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
    const SITE_ID = '22222222-2222-4222-8222-222222222222';
    const USER_ID = '33333333-3333-4333-8333-333333333333';

    it('NÃO chama setValue("company_id", …) enquanto `companies` ainda não tem a empresa resolvida', () => {
      currentSelectedTenant = { companyId: COMPANY_ID };
      const options = { ...baseOptions(), companies: [] };

      renderHook(() => useAprCatalogs(options));

      expect(options.setValue).not.toHaveBeenCalledWith('company_id', expect.anything());
    });

    it('chama setValue("company_id", …) assim que `companies` passa a conter a empresa resolvida', () => {
      currentSelectedTenant = { companyId: COMPANY_ID };
      const options = { ...baseOptions(), companies: [] as Array<{ id: string }> };

      const { rerender } = renderHook((props) => useAprCatalogs(props), {
        initialProps: options,
      });

      expect(options.setValue).not.toHaveBeenCalledWith('company_id', expect.anything());

      const ready = { ...options, companies: [{ id: COMPANY_ID }] };
      rerender(ready);

      expect(options.setValue).toHaveBeenCalledWith('company_id', COMPANY_ID);
    });

    it('só seta site_id/elaborador_id depois que sites/users (escopados à empresa) carregam, não no mesmo tick da empresa', () => {
      currentSelectedTenant = { companyId: COMPANY_ID };
      currentSiteStoreValue = { siteId: SITE_ID };
      const user = { id: USER_ID, company_id: COMPANY_ID };
      const options = {
        ...baseOptions(),
        user,
        selectedCompanyId: COMPANY_ID,
        companies: [{ id: COMPANY_ID }],
        sites: [] as Array<{ id: string }>,
        users: [] as Array<{ id: string }>,
      };

      const { rerender } = renderHook((props) => useAprCatalogs(props), {
        initialProps: options,
      });

      expect(options.setValue).not.toHaveBeenCalledWith('site_id', expect.anything());
      expect(options.setValue).not.toHaveBeenCalledWith('elaborador_id', expect.anything());

      const ready = {
        ...options,
        sites: [{ id: SITE_ID }],
        users: [{ id: USER_ID }],
      };
      rerender(ready);

      expect(options.setValue).toHaveBeenCalledWith('site_id', SITE_ID);
      expect(options.setValue).toHaveBeenCalledWith('elaborador_id', USER_ID);
      expect(options.setValue).toHaveBeenCalledWith('participants', [USER_ID]);
    });
  });
});
