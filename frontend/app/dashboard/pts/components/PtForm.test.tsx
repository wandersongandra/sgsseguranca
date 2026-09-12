import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PtForm } from './PtForm';
import { initialChecklists } from './pt-schema-and-data';

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: (loader: () => Promise<unknown>) => {
    const React = require('react') as typeof import('react');
    const LazyComponent = React.lazy(async () => {
      const loaded = (await loader()) as { default?: unknown } | unknown;
      return {
        default:
          loaded && typeof loaded === 'object' && 'default' in loaded
            ? loaded.default
            : loaded,
      } as { default: React.ComponentType<unknown> };
    });
    return ({
      photos,
      onPhotosChanged,
      ...props
    }: {
      photos?: Array<unknown>;
      onPhotosChanged?: () => void;
      [key: string]: unknown;
    }) =>
      Array.isArray(photos) && onPhotosChanged ? (
        <div>
          <div>Fotos atuais: {photos.length}</div>
          <button type="button" onClick={onPhotosChanged}>
            Recarregar PT por evidência
          </button>
        </div>
      ) : (
        <React.Suspense fallback={null}>
          <LazyComponent {...props} />
        </React.Suspense>
      );
  },
}));

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
      site_id: 'site-1',
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
    onAprChange,
  }: {
    filteredAprs: Array<{ id: string }>;
    filteredSites: Array<{ id: string }>;
    filteredUsers: Array<{ id: string }>;
    onCompanyChange: (companyId: string) => void;
    onAprChange?: (aprId: string) => void;
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
        <div>Altura atual: {String(Boolean(watch('trabalho_altura')))}</div>
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
        <button type="button" onClick={() => onAprChange?.('apr-old')}>
          Carregar APR antiga
        </button>
        <button type="button" onClick={() => onAprChange?.('apr-new')}>
          Carregar APR nova
        </button>
        <button
          type="button"
          onClick={() => setValue('site_id', 'site-b', { shouldDirty: true, shouldValidate: true })}
        >
          Selecionar obra 2
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

jest.mock('./PtEvidencePhotosSection', () => {
  const MockPtEvidencePhotosSection = ({
    photos,
    onPhotosChanged,
  }: {
    photos: Array<unknown>;
    onPhotosChanged: () => void;
  }) => (
    <div>
      <div>Fotos atuais: {photos.length}</div>
      <button type="button" onClick={onPhotosChanged}>
        Recarregar PT por evidência
      </button>
    </div>
  );
  return {
    __esModule: true,
    PtEvidencePhotosSection: MockPtEvidencePhotosSection,
    default: MockPtEvidencePhotosSection,
  };
});

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
const replaceSignatures = jest.fn();
const mockGeneratePtPdf = jest.fn();

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
    fotos_evidencia: [] as Array<{
      ref: string;
      fase: string;
      uploaded_at: string;
    }>,
  };
}

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    create: (...args: unknown[]) => createPt(...args),
    update: (...args: unknown[]) => updatePt(...args),
    attachFile: (...args: unknown[]) => attachPtFile(...args),
    findOne: (...args: unknown[]) => findPt(...args),
    getPreApprovalHistory: (...args: unknown[]) => getPreApprovalHistory(...args),
    replaceSignatures: (...args: unknown[]) => replaceSignatures(...args),
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

jest.mock('@/lib/pdf/ptGenerator', () => ({
  generatePtPdf: (...args: unknown[]) => mockGeneratePtPdf(...args),
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
    replaceSignatures.mockResolvedValue({ entityId: 'pt-1', replaced: 0 });
    mockGeneratePtPdf.mockResolvedValue({
      base64: 'JVBERi0xLjQ=',
      filename: 'pt-final.pdf',
    });
  });

  it('mantém o papel de botão nas etapas do wizard para navegação assistiva', async () => {
    render(<PtForm />);

    const stepList = await screen.findByRole('list');
    const stepItems = within(stepList).getAllByRole('listitem');
    expect(stepItems).toHaveLength(3);
    const firstStep = stepItems[0];
    expect(firstStep).toBeDefined();
    if (!firstStep) throw new Error('A primeira etapa do wizard não foi renderizada.');
    expect(within(firstStep).getByRole('button', { name: /Etapa 1/ })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('ignora um destino de foco inválido vindo da URL', async () => {
    searchParamsGet.mockImplementation((key: string) =>
      key === 'focus' ? '"]' : null,
    );

    render(<PtForm />);

    expect(await screen.findByText('Etapa 1 de 3')).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    });
  });

  it('aguarda a obra antes de consultar APRs com escopo', async () => {
    searchParamsGet.mockImplementation((key: string) =>
      key === 'company_id' ? 'company-1' : null,
    );
    localStorage.setItem(
      'gst.pt.wizard.draft.company-1.user-1',
      JSON.stringify({
        step: 1,
        values: { company_id: 'company-1' },
        metadata: {},
      }),
    );

    render(<PtForm />);

    await waitFor(() => expect(findSitesPaginated).toHaveBeenCalled());
    expect(findAprsPaginated).not.toHaveBeenCalled();
  });

  it('não restaura rascunho compartilhado apenas pela empresa', async () => {
    localStorage.setItem(
      'gst.pt.wizard.draft.company-1',
      JSON.stringify({
        step: 1,
        values: {
          company_id: 'company-1',
          titulo: 'Rascunho de outro usuário',
        },
        metadata: {},
      }),
    );
    localStorage.setItem(
      'compliancex.pt.wizard.draft.company-1',
      JSON.stringify({
        step: 1,
        values: {
          company_id: 'company-1',
          titulo: 'Rascunho legado de outro usuário',
        },
        metadata: {},
      }),
    );

    render(<PtForm />);

    expect(await screen.findByText('Etapa 1 de 3')).toBeInTheDocument();
    expect(screen.queryByText('Rascunho de outro usuário')).not.toBeInTheDocument();
    expect(screen.queryByText('Rascunho legado de outro usuário')).not.toBeInTheDocument();
    expect(screen.queryByText('Rascunho restaurado')).not.toBeInTheDocument();
    expect(localStorage.getItem('gst.pt.wizard.draft.company-1')).toBeNull();
    expect(localStorage.getItem('compliancex.pt.wizard.draft.company-1')).toBeNull();
  });

  it('switches sidebar context when a restored draft opens directly in step 2', async () => {
    localStorage.setItem(
      'gst.pt.wizard.draft.company-1.user-1',
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
      'gst.pt.wizard.draft.company-1.user-1',
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
      'gst.pt.wizard.draft.company-1.user-1',
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
      'gst.pt.wizard.draft.company-1.user-1',
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
      'gst.pt.wizard.draft.company-1.user-1',
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
    searchParamsGet.mockImplementation((key: string) => {
      if (key === 'company_id') return 'company-1';
      if (key === 'site_id') return 'site-a';
      return null;
    });
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
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar obra 2' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar obra 2' }));
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
      'gst.pt.wizard.draft.company-1.user-1',
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
    searchParamsGet.mockImplementation((key: string) => {
      if (key === 'company_id') return 'company-1';
      if (key === 'site_id') return 'site-a';
      return null;
    });

    render(<PtForm />);
    await waitFor(() => {
      expect(findApr).toHaveBeenCalledWith('apr-a');
      expect(findSite).toHaveBeenCalledWith('site-a');
      expect(findUser).toHaveBeenCalledWith('user-a');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar para empresa 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar obra 2' }));
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

  it('ignora o contexto de APR que chega depois de uma seleção mais recente', async () => {
    const staleApr = deferred<{
      id: string;
      company_id: string;
      site_id: string;
      titulo: string;
      descricao: string;
    }>();
    findAprsPaginated.mockResolvedValue({ data: [] });
    findApr.mockImplementation((aprId: string) =>
      aprId === 'apr-old'
        ? staleApr.promise
        : Promise.resolve({
            id: 'apr-new',
            company_id: 'company-1',
            site_id: 'site-new',
            titulo: 'APR nova geral',
          descricao: 'Atividade geral sem risco adicional.',
        }),
    );
    searchParamsGet.mockImplementation((key: string) =>
      key === 'company_id' ? 'company-1' : null,
    );

    render(<PtForm />);
    await screen.findByText('Empresa atual: company-1');

    fireEvent.click(screen.getByRole('button', { name: 'Carregar APR antiga' }));
    fireEvent.click(screen.getByRole('button', { name: 'Carregar APR nova' }));

    await waitFor(() => expect(screen.getByText('Obra atual: site-new')).toBeInTheDocument());
    expect(screen.getByText('Altura atual: false')).toBeInTheDocument();

    await act(async () => {
      staleApr.resolve({
        id: 'apr-old',
        company_id: 'company-1',
        site_id: 'site-old',
        titulo: 'APR antiga trabalho em altura',
        descricao: 'Trabalho em altura com risco elevado.',
      });
      await staleApr.promise;
    });

    expect(screen.getByText('Obra atual: site-new')).toBeInTheDocument();
    expect(screen.getByText('Altura atual: false')).toBeInTheDocument();
  });

  it('mantém a resposta mais recente ao revalidar a PT após mutações concorrentes', async () => {
    const firstRefresh = deferred<ReturnType<typeof makePtFixture>>();
    const secondRefresh = deferred<ReturnType<typeof makePtFixture>>();
    const initialPt = {
      ...makePtFixture('pt-a', 'company-1', 'site-a'),
      fotos_evidencia: [],
    };
    let findPtCalls = 0;
    findPt.mockImplementation(() => {
      findPtCalls += 1;
      if (findPtCalls === 1) return Promise.resolve(initialPt);
      if (findPtCalls === 2) return firstRefresh.promise;
      return secondRefresh.promise;
    });

    searchParamsGet.mockImplementation((key: string) =>
      key === 'focus' ? 'team' : null,
    );
    render(<PtForm id="pt-a" />);
    await screen.findByText('Etapa 3 de 3');
    expect(await screen.findByText('Fotos atuais: 0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Recarregar PT por evidência' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar PT por evidência' }));

    await act(async () => {
      secondRefresh.resolve({
        ...initialPt,
        fotos_evidencia: [{ ref: 'gst:pt-photo:new', fase: 'depois', uploaded_at: '2026-09-10' }],
      });
      await secondRefresh.promise;
    });
    await waitFor(() => expect(screen.getByText('Fotos atuais: 1')).toBeInTheDocument());

    await act(async () => {
      firstRefresh.resolve({
        ...initialPt,
        fotos_evidencia: [],
      });
      await firstRefresh.promise;
    });

    expect(screen.getByText('Fotos atuais: 1')).toBeInTheDocument();
  });

  it('bloqueia duplo clique síncrono na emissão do PDF final', async () => {
    const attachment = deferred<void>();
    findPt.mockResolvedValue({
      ...makePtFixture('pt-a', 'company-1', 'site-a'),
      status: 'Aprovada',
      pdf_file_key: null,
    });
    attachPtFile.mockReturnValue(attachment.promise);

    render(<PtForm id="pt-a" />);
    const emitButton = await screen.findByRole('button', { name: 'Emitir PDF final' });

    await act(async () => {
      fireEvent.click(emitButton);
      fireEvent.click(emitButton);
    });

    expect(attachPtFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      attachment.resolve();
      await attachment.promise;
    });
  });
});
