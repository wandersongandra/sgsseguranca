import { renderHook, waitFor } from '@testing-library/react';

jest.mock('@/lib/siteStore', () => ({
  siteStore: {
    get: () => null,
  },
}));

jest.mock('@/lib/selectedTenantStore', () => ({
  selectedTenantStore: {
    get: () => null,
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
  });

  beforeEach(() => {
    jest.clearAllMocks();
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
});
