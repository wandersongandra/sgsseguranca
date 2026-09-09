import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PtForm } from './PtForm';
import { initialChecklists } from './pt-schema-and-data';

const searchParamsGet = jest.fn();
const push = jest.fn();
const refresh = jest.fn();
const mockToastError = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@/lib/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: jest.fn(),
  },
}));

jest.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    info: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: searchParamsGet }),
  useRouter: () => ({ push, refresh }),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      nome: 'Tecnico',
      company_id: 'company-1',
      profile: { nome: 'Técnico de Segurança' },
    },
    hasPermission: () => true,
  }),
}));

jest.mock('@/components/AuditSection', () => ({
  AuditSection: () => <div>Audit Section</div>,
}));

jest.mock('@/components/DocumentEmailModal', () => ({
  DocumentEmailModal: () => null,
}));

jest.mock('../../checklists/components/SignatureModal', () => ({
  SignatureModal: () => null,
}));

jest.mock('@/components/layout', () => ({
  PageHeader: ({ title, description }: { title: string; description: string }) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  ),
}));

jest.mock('./BasicInfoSection', () => ({
  BasicInfoSection: ({
    filteredAprs,
    filteredSites,
    filteredUsers,
    onCompanyChange,
  }: {
    filteredAprs: Array<{ id: string }>;
    filteredSites: Array<{ id: string }>;
    filteredUsers: Array<{ id: string }>;
    onCompanyChange: (companyId: string) => void;
  }) => {
    const { useFormContext } = jest.requireActual('react-hook-form');
    const { setValue, watch } = useFormContext();
    return (
      <div>
        <div>Status atual: {watch('status')}</div>
        <div>Empresa atual: {watch('company_id') || ''}</div>
        <div>Obra atual: {watch('site_id') || ''}</div>
        <div>Responsável atual: {watch('responsavel_id') || ''}</div>
        <div>APR atual: {watch('apr_id') || ''}</div>
        <div>APRs disponíveis: {filteredAprs.map((item) => item.id).join(',')}</div>
        <div>Obras disponíveis: {filteredSites.map((item) => item.id).join(',')}</div>
        <div>Usuários disponíveis: {filteredUsers.map((item) => item.id).join(',')}</div>
        <button
          type="button"
          onClick={() => {
            setValue('company_id', 'company-2');
            onCompanyChange('company-2');
          }}
        >
          Trocar para empresa 2
        </button>
      </div>
    );
  },
}));

jest.mock('./RiskTypesSection', () => ({
  RiskTypesSection: () => <div>Risk Types Section</div>,
}));

jest.mock('./RapidRiskAnalysisSection', () => ({
  RapidRiskAnalysisSection: () => <div>Rapid Risk Section</div>,
}));

jest.mock('./ResponsibleExecutorsSection', () => ({
  ResponsibleExecutorsSection: () => <div>Responsible Executors Section</div>,
}));

jest.mock('./ChecklistSection', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

jest.mock('./PtPreApprovalHistoryPanel', () => ({
  PtPreApprovalHistoryPanel: () => <div>Pre Approval History</div>,
}));

jest.mock('./PtReadinessPanel', () => ({
  PtReadinessPanel: ({
    readyForRelease,
  }: {
    readyForRelease: boolean;
  }) => <div>{readyForRelease ? 'Readiness OK' : 'Readiness Blocked'}</div>,
}));

const createPt = jest.fn();
const updatePt = jest.fn();
const attachPtFile = jest.fn();
const findPt = jest.fn();
const getPreApprovalHistory = jest.fn();
const findCompaniesPaginated = jest.fn();
const findCompany = jest.fn();
const findAprsPaginated = jest.fn();
const findApr = jest.fn();
const findSitesPaginated = jest.fn();
const findSite = jest.fn();
const findUsersPaginated = jest.fn();
const findUser = jest.fn();
const findSignatures = jest.fn();
const createSignature = jest.fn();

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makePtFixture(id: string, companyId: string, siteId: string) {
  return {
    id,
    numero: id.toUpperCase(),
    titulo: `PT ${id}`,
    status: 'Pendente',
    company_id: companyId,
    site_id: siteId,
    apr_id: `${id}-apr`,
    responsavel_id: `${id}-user`,
    executantes: [],
    trabalho_altura: false,
    espaco_confinado: false,
    trabalho_quente: false,
    eletricidade: false,
    escavacao: false,
  };
}

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    create: (...args: unknown[]) => createPt(...args),
    update: (...args: unknown[]) => updatePt(...args),
    attachFile: (...args: unknown[]) => attachPtFile(...args),
    findOne: (...args: unknown[]) => findPt(...args),
    getPreApprovalHistory: (...args: unknown[]) => getPreApprovalHistory(...args),
  },
}));

jest.mock('@/services/companiesService', () => ({
  companiesService: {
    findPaginated: (...args: unknown[]) => findCompaniesPaginated(...args),
    findOne: (...args: unknown[]) => findCompany(...args),
  },
}));

jest.mock('@/services/aprsService', () => ({
  aprsService: {
    findPaginated: (...args: unknown[]) => findAprsPaginated(...args),
    findOne: (...args: unknown[]) => findApr(...args),
  },
}));

jest.mock('@/services/sitesService', () => ({
  sitesService: {
    findPaginated: (...args: unknown[]) => findSitesPaginated(...args),
    findOne: (...args: unknown[]) => findSite(...args),
  },
}));

jest.mock('@/services/usersService', () => ({
  usersService: {
    findPaginated: (...args: unknown[]) => findUsersPaginated(...args),
    findOne: (...args: unknown[]) => findUser(...args),
  },
}));

jest.mock('@/services/signaturesService', () => ({
  signaturesService: {
    findByDocument: (...args: unknown[]) => findSignatures(...args),
    create: (...args: unknown[]) => createSignature(...args),
  },
}));

jest.mock('@/services/mailService', () => ({
  mailService: {
    sendStoredDocument: jest.fn(),
  },
}));

jest.mock('@/services/aiService', () => ({
  aiService: {
    analyzePt: jest.fn(),
  },
}));

describe('PtForm', () => {
  beforeEach(() => {
    localStorage.clear();
    mockToastError.mockClear();
    mockLoggerError.mockClear();
    searchParamsGet.mockImplementation(() => null);

    createPt.mockResolvedValue({ id: 'pt-1' });
    updatePt.mockResolvedValue({ id: 'pt-1' });
    attachPtFile.mockResolvedValue(undefined);
    findPt.mockResolvedValue(null);
    getPreApprovalHistory.mockResolvedValue([]);
    findCompaniesPaginated.mockResolvedValue({ data: [] });
    findCompany.mockResolvedValue({
      id: 'company-1',
      razao_social: 'Empresa Teste',
    });
    findAprsPaginated.mockResolvedValue({ data: [] });
    findApr.mockResolvedValue(null);
    findSitesPaginated.mockResolvedValue({
      data: [{ id: 'site-1', nome: 'Obra Norte', company_id: 'company-1' }],
    });
    findSite.mockResolvedValue({ id: 'site-1', nome: 'Obra Norte', company_id: 'company-1' });
    findUsersPaginated.mockResolvedValue({
      data: [{ id: 'user-1', nome: 'Responsável', company_id: 'company-1' }],
    });
    findUser.mockResolvedValue({ id: 'user-1', nome: 'Responsável', company_id: 'company-1' });
    findSignatures.mockResolvedValue([]);
    createSignature.mockResolvedValue(undefined);
  });

  it('switches sidebar context when a restored draft opens directly in step 2', async () => {
    localStorage.setItem(
      'gst.pt.wizard.draft.company-1',
      JSON.stringify({
        step: 2,
        values: {
          company_id: 'company-1',
          site_id: 'site-1',
          responsavel_id: 'user-1',
          titulo: 'PT de manutenção',
          trabalho_altura: true,
          executantes: ['user-1'],
        },
        metadata: {},
      }),
    );

    render(<PtForm />);

    expect(await screen.findByText('Etapa 2 de 3')).toBeInTheDocument();
    expect(screen.getAllByText('Pendências').length).toBeGreaterThan(0);
    expect(screen.getByText('Respostas críticas')).toBeInTheDocument();
    expect(screen.queryByText('APR vinculada')).not.toBeInTheDocument();
    expect(screen.queryByText('Readiness OK')).not.toBeInTheDocument();
    expect(screen.queryByText('Readiness Blocked')).not.toBeInTheDocument();
  });

  it('normalizes legacy draft status before the PT generic flow is restored', async () => {
    localStorage.setItem(
      'gst.pt.wizard.draft.company-1',
      JSON.stringify({
        step: 1,
        values: {
          company_id: 'company-1',
          site_id: 'site-1',
          responsavel_id: 'user-1',
          titulo: 'PT herdada',
          numero: 'PT-900',
          status: 'Aprovada',
          executantes: ['user-1'],
        },
        metadata: {},
      }),
    );

    render(<PtForm />);

    expect(await screen.findByText('Etapa 1 de 3')).toBeInTheDocument();
    expect(screen.getByText('Status atual: Pendente')).toBeInTheDocument();
  });

  it('auto-preenche obra e responsável quando a APR chega depois da restauração do draft', async () => {
    findAprsPaginated.mockResolvedValue({
      data: [
        {
          id: 'apr-1',
          numero: 'APR-001',
          titulo: 'APR de manutenção',
          company_id: 'company-1',
          site_id: 'site-1',
          elaborador_id: 'user-1',
        },
      ],
    });

    localStorage.setItem(
      'gst.pt.wizard.draft.company-1',
      JSON.stringify({
        step: 1,
        values: {
          company_id: 'company-1',
          apr_id: 'apr-1',
          titulo: 'PT com APR',
          executantes: ['user-1'],
        },
        metadata: {},
      }),
    );

    render(<PtForm />);

    expect(await screen.findByText('APR atual: apr-1')).toBeInTheDocument();
    expect(await screen.findByText('Obra atual: site-1')).toBeInTheDocument();
    expect(await screen.findByText('Responsável atual: user-1')).toBeInTheDocument();
  });

  it('hides the SOPHIE helper block when the restored draft opens in the final step', async () => {
    localStorage.setItem(
      'gst.pt.wizard.draft.company-1',
      JSON.stringify({
        step: 3,
        values: {
          company_id: 'company-1',
          site_id: 'site-1',
          responsavel_id: 'user-1',
          titulo: 'PT final',
          executantes: ['user-1'],
        },
        metadata: {
          suggestedRisks: [{ label: 'Altura' }],
          mandatoryChecklists: [{ id: 'check-1', label: 'Checklist crítico', reason: 'Obrigatório', source: 'pt-group' }],
          riskLevel: 'Alto',
        },
      }),
    );

    render(<PtForm />);

    expect(await screen.findByText('Etapa 3 de 3')).toBeInTheDocument();
    expect(screen.getAllByText('Fechamento da liberação').length).toBeGreaterThan(0);
    expect(screen.queryByText('Sugestões da SOPHIE')).not.toBeInTheDocument();
    expect(screen.getByText('Situação')).toBeInTheDocument();
    expect(screen.getByText('Readiness Blocked')).toBeInTheDocument();
  });

  it('does not count unanswered optional excavation items as pending blockers', async () => {
    localStorage.setItem(
      'gst.pt.wizard.draft.company-1',
      JSON.stringify({
        step: 2,
        values: {
          company_id: 'company-1',
          site_id: 'site-1',
          responsavel_id: 'user-1',
          titulo: 'Escavação segura',
          escavacao: true,
          executantes: ['user-1'],
          analise_risco_rapida_checklist: initialChecklists.analise_risco_rapida_checklist.map((item) => ({
            ...item,
            resposta: 'Sim',
          })),
          recomendacoes_gerais_checklist: initialChecklists.recomendacoes_gerais_checklist.map((item) => ({
            ...item,
            resposta: 'Ciente',
          })),
          trabalho_escavacao_checklist: initialChecklists.trabalho_escavacao_checklist.map((item) =>
            item.id === 'estruturas_reforcadas_engenheiro'
              ? item
              : { ...item, resposta: 'Sim' },
          ),
        },
        metadata: {},
      }),
    );

    render(<PtForm />);

    expect(await screen.findByText('Etapa 2 de 3')).toBeInTheDocument();
    expect(screen.getAllByText(/0 resposta/i).length).toBeGreaterThan(0);
  });

  it('preserves embedded editing seeds when scoped lookups fail offline', async () => {
    findPt.mockResolvedValue({
      id: 'pt-a',
      numero: 'PT-A',
      titulo: 'PT offline',
      status: 'Pendente',
      company_id: 'company-1',
      site_id: 'site-a',
      apr_id: 'apr-a',
      responsavel_id: 'user-a',
      data_hora_inicio: '2026-07-14T08:00:00.000Z',
      data_hora_fim: '2026-07-14T18:00:00.000Z',
      trabalho_altura: false,
      espaco_confinado: false,
      trabalho_quente: false,
      eletricidade: false,
      escavacao: false,
      // Payload real de Pt: a relação resumida não repete company_id.
      apr: { id: 'apr-a', numero: 'APR-A', titulo: 'APR A' },
      site: { id: 'site-a', company_id: 'company-1', nome: 'Obra A' },
      responsavel: { id: 'user-a', company_id: 'company-1', nome: 'Responsável A' },
      executantes: [{ id: 'user-exec-a', company_id: 'company-1', nome: 'Executante A' }],
      auditado_por: { id: 'user-audit-a', company_id: 'company-1', nome: 'Auditor A' },
      auditado_por_id: 'user-audit-a',
    });
    findAprsPaginated.mockRejectedValue(new TypeError('offline'));
    findSitesPaginated.mockRejectedValue(new TypeError('offline'));
    findUsersPaginated.mockRejectedValue(new TypeError('offline'));

    render(<PtForm id="pt-a" />);

    expect(await screen.findByText('APRs disponíveis: apr-a')).toBeInTheDocument();
    expect(screen.getByText('Obras disponíveis: site-a')).toBeInTheDocument();
    expect(screen.getByText('Usuários disponíveis: user-a,user-exec-a,user-audit-a')).toBeInTheDocument();
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(3));
    expect(mockLoggerError).toHaveBeenCalledTimes(3);
    expect(screen.getByText('APRs disponíveis: apr-a')).toBeInTheDocument();
    expect(screen.getByText('Obras disponíveis: site-a')).toBeInTheDocument();
    expect(screen.getByText('Usuários disponíveis: user-a,user-exec-a,user-audit-a')).toBeInTheDocument();
  });

  it('shows tenant A, then clears it while tenant B is still pending', async () => {
    const aprB = deferred<{ data: Array<{ id: string; company_id: string }> }>();
    const siteB = deferred<{ data: Array<{ id: string; company_id: string }> }>();
    const usersB = deferred<{ data: Array<{ id: string; nome: string; company_id: string }> }>();

    findAprsPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      companyId === 'company-1'
        ? Promise.resolve({ data: [{ id: 'apr-a', company_id: 'company-1' }] })
        : aprB.promise,
    );
    findSitesPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      companyId === 'company-1'
        ? Promise.resolve({ data: [{ id: 'site-a', company_id: 'company-1' }] })
        : siteB.promise,
    );
    findUsersPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      companyId === 'company-1'
        ? Promise.resolve({ data: [{ id: 'user-a', nome: 'Usuário A', company_id: 'company-1' }] })
        : usersB.promise,
    );

    render(<PtForm />);
    expect(await screen.findByText('APRs disponíveis: apr-a')).toBeInTheDocument();
    expect(await screen.findByText('Obras disponíveis: site-a')).toBeInTheDocument();
    expect(await screen.findByText('Usuários disponíveis: user-a')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Trocar para empresa 2' }));

    expect(screen.getByText('APRs disponíveis:')).toBeInTheDocument();
    expect(screen.getByText('Obras disponíveis:')).toBeInTheDocument();
    expect(screen.getByText('Usuários disponíveis:')).toBeInTheDocument();
    expect(screen.queryByText(/disponíveis:.*-a/)).not.toBeInTheDocument();

    await act(async () => {
      aprB.resolve({ data: [{ id: 'apr-b', company_id: 'company-2' }] });
      siteB.resolve({ data: [{ id: 'site-b', company_id: 'company-2' }] });
      usersB.resolve({ data: [{ id: 'user-b', nome: 'Usuário B', company_id: 'company-2' }] });
      await Promise.all([aprB.promise, siteB.promise, usersB.promise]);
    });

    expect(screen.getByText('APRs disponíveis: apr-b')).toBeInTheDocument();
    expect(screen.getByText('Obras disponíveis: site-b')).toBeInTheDocument();
    expect(screen.getByText('Usuários disponíveis: user-b')).toBeInTheDocument();
  });

  it('does not toast stale lookup errors for APRs, sites, or users', async () => {
    const staleAprRequest = deferred<{ data: Array<{ id: string; company_id: string }> }>();
    const staleSiteRequest = deferred<{ data: Array<{ id: string; company_id: string }> }>();
    const staleUserRequest = deferred<{ data: Array<{ id: string; nome: string; company_id: string }> }>();
    findAprsPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      companyId === 'company-1'
        ? staleAprRequest.promise
        : Promise.resolve({ data: [{ id: 'apr-b', company_id: 'company-2' }] }),
    );
    findSitesPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      companyId === 'company-1'
        ? staleSiteRequest.promise
        : Promise.resolve({ data: [{ id: 'site-b', company_id: 'company-2' }] }),
    );
    findUsersPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      companyId === 'company-1'
        ? staleUserRequest.promise
        : Promise.resolve({ data: [{ id: 'user-b', nome: 'Usuário B', company_id: 'company-2' }] }),
    );

    render(<PtForm />);
    await waitFor(() => {
      expect(findAprsPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'company-1' }),
      );
      expect(findSitesPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'company-1' }),
      );
      expect(findUsersPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'company-1' }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar para empresa 2' }));
    expect(await screen.findByText('APRs disponíveis: apr-b')).toBeInTheDocument();
    expect(await screen.findByText('Obras disponíveis: site-b')).toBeInTheDocument();
    expect(await screen.findByText('Usuários disponíveis: user-b')).toBeInTheDocument();

    await act(async () => {
      staleAprRequest.reject(new Error('falha tardia de APR da empresa A'));
      staleSiteRequest.reject(new Error('falha tardia de site da empresa A'));
      staleUserRequest.reject(new Error('falha tardia de usuário da empresa A'));
      await Promise.allSettled([
        staleAprRequest.promise,
        staleSiteRequest.promise,
        staleUserRequest.promise,
      ]);
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('ignores late selected-item fallbacks for APR, site, and user after tenant change', async () => {
    const staleAprFallback = deferred<{ id: string; company_id: string }>();
    const staleSiteFallback = deferred<{ id: string; company_id: string }>();
    const staleUserFallback = deferred<{ id: string; nome: string; company_id: string }>();
    localStorage.setItem(
      'gst.pt.wizard.draft.company-1',
      JSON.stringify({
        step: 1,
        values: {
          company_id: 'company-1',
          apr_id: 'apr-a',
          site_id: 'site-a',
          responsavel_id: 'user-a',
          titulo: 'PT A',
          executantes: [],
        },
        metadata: {},
      }),
    );
    findAprsPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      Promise.resolve(
        companyId === 'company-1'
          ? { data: [] }
          : { data: [{ id: 'apr-b', company_id: 'company-2' }] },
      ),
    );
    findSitesPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      Promise.resolve(
        companyId === 'company-1'
          ? { data: [] }
          : { data: [{ id: 'site-b', company_id: 'company-2' }] },
      ),
    );
    findUsersPaginated.mockImplementation(({ companyId }: { companyId: string }) =>
      Promise.resolve(
        companyId === 'company-1'
          ? { data: [] }
          : { data: [{ id: 'user-b', nome: 'Usuário B', company_id: 'company-2' }] },
      ),
    );
    findApr.mockImplementation((aprId: string) =>
      aprId === 'apr-a' ? staleAprFallback.promise : Promise.resolve(null),
    );
    findSite.mockImplementation((siteId: string) =>
      siteId === 'site-a' ? staleSiteFallback.promise : Promise.resolve(null),
    );
    findUser.mockImplementation((userId: string) =>
      userId === 'user-a' ? staleUserFallback.promise : Promise.resolve(null),
    );

    render(<PtForm />);
    await waitFor(() => {
      expect(findApr).toHaveBeenCalledWith('apr-a');
      expect(findSite).toHaveBeenCalledWith('site-a');
      expect(findUser).toHaveBeenCalledWith('user-a');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar para empresa 2' }));
    expect(await screen.findByText('APRs disponíveis: apr-b')).toBeInTheDocument();
    expect(await screen.findByText('Obras disponíveis: site-b')).toBeInTheDocument();
    expect(await screen.findByText('Usuários disponíveis: user-b')).toBeInTheDocument();

    await act(async () => {
      staleAprFallback.resolve({ id: 'apr-a', company_id: 'company-1' });
      staleSiteFallback.resolve({ id: 'site-a', company_id: 'company-1' });
      staleUserFallback.resolve({ id: 'user-a', nome: 'Usuário A', company_id: 'company-1' });
      await Promise.all([
        staleAprFallback.promise,
        staleSiteFallback.promise,
        staleUserFallback.promise,
      ]);
    });

    expect(screen.getByText('APRs disponíveis: apr-b')).toBeInTheDocument();
    expect(screen.getByText('Obras disponíveis: site-b')).toBeInTheDocument();
    expect(screen.getByText('Usuários disponíveis: user-b')).toBeInTheDocument();
    expect(screen.queryByText(/disponíveis:.*-a/)).not.toBeInTheDocument();
  });

  it('ignora a PT antiga quando a prop id muda antes do carregamento terminar', async () => {
    const requestA = deferred<ReturnType<typeof makePtFixture>>();
    const requestB = deferred<ReturnType<typeof makePtFixture>>();
    findPt.mockImplementation((ptId: string) =>
      ptId === 'pt-a' ? requestA.promise : requestB.promise,
    );

    const rendered = render(<PtForm id="pt-a" />);
    await waitFor(() => expect(findPt).toHaveBeenCalledWith('pt-a'));

    rendered.rerender(<PtForm id="pt-b" />);
    await waitFor(() => expect(findPt).toHaveBeenCalledWith('pt-b'));

    await act(async () => {
      requestB.resolve(makePtFixture('pt-b', 'company-2', 'site-b'));
      await requestB.promise;
    });
    await waitFor(() =>
      expect(screen.getByText('Empresa atual: company-2')).toBeInTheDocument(),
    );

    await act(async () => {
      requestA.resolve(makePtFixture('pt-a', 'company-1', 'site-a'));
      await requestA.promise;
    });

    expect(screen.getByText('Empresa atual: company-2')).toBeInTheDocument();
    expect(screen.queryByText('Empresa atual: company-1')).not.toBeInTheDocument();
  });
});
