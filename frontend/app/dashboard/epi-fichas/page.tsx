'use client';
import { logger } from '@/lib/logger';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { PaginationControls } from '@/components/PaginationControls';
import { SignatureModal } from '@/components/SignatureModal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  epiAssignmentsService,
  EpiAssignment,
  EpiLookupItem,
  EpiLookupUser,
} from '@/services/epiAssignmentsService';
import { FileDown, Plus } from 'lucide-react';
import { useCachedFetch } from '@/hooks/useCachedFetch';
import { CACHE_KEYS } from '@/lib/cache/cacheKeys';
import { safeToLocaleDateString } from '@/lib/date/safeFormat';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { Button } from '@/components/ui/button';
import { ModalBody, ModalFooter, ModalFrame, ModalHeader } from '@/components/ui/modal-frame';

const SUMMARY_CACHE_TTL_MS = 60_000;
const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const panelClassName =
  'rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--ds-color-surface-base)_94%,white_6%)_0%,var(--ds-color-surface-base)_100%)] shadow-[var(--ds-shadow-xs)]';
const sectionHeaderClassName = 'space-y-1';
const sectionEyebrowClassName =
  'text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-muted)]';
const sectionDescriptionClassName = 'text-sm text-[var(--ds-color-text-secondary)]';
const fieldClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] transition-all duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--ds-shadow-sm)]';

type SignatureTarget =
  | { mode: 'create' }
  | { mode: 'return'; assignmentId: string };

export default function EpiFichasPage() {
  const { hasPermission } = useAuth();
  const canManageEpi = hasPermission(Permission.CAN_MANAGE_EPI_ASSIGNMENTS);

  const summaryCache = useCachedFetch(
    CACHE_KEYS.epiAssignmentsSummary,
    epiAssignmentsService.getSummary,
    SUMMARY_CACHE_TTL_MS,
  );
  const episLookupCache = useCachedFetch(
    CACHE_KEYS.epiFichasEpisLookup,
    epiAssignmentsService.findAllLookupEpis,
    LOOKUP_CACHE_TTL_MS,
  );
  const usersLookupCache = useCachedFetch(
    CACHE_KEYS.epiFichasUsersLookup,
    epiAssignmentsService.findAllLookupUsers,
    LOOKUP_CACHE_TTL_MS,
  );
  const [assignments, setAssignments] = useState<EpiAssignment[]>([]);
  const [epis, setEpis] = useState<EpiLookupItem[]>([]);
  const [selectedEpi, setSelectedEpi] = useState<EpiLookupItem | null>(null);
  const [userOptions, setUserOptions] = useState<EpiLookupUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<EpiLookupUser | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [epiSearch, setEpiSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const deferredEpiSearch = useDeferredValue(epiSearch);
  const deferredUserSearch = useDeferredValue(userSearch);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);
  const [summary, setSummary] = useState({
    total: 0,
    entregue: 0,
    devolvido: 0,
    substituido: 0,
    caExpirado: 0,
  });
  const [form, setForm] = useState({
    epi_id: '',
    user_id: '',
    quantidade: 1,
    observacoes: '',
  });
  const [deliverySignature, setDeliverySignature] = useState('');
  const [deliverySignatureType, setDeliverySignatureType] = useState<
    'digital' | 'upload' | 'facial'
  >('digital');
  const [signatureTarget, setSignatureTarget] = useState<SignatureTarget | null>(
    null,
  );
  const [actionModal, setActionModal] = useState<{
    assignment: EpiAssignment;
    mode: 'return' | 'replace';
    signatureData?: string;
    signatureType?: string;
  } | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [actionSaving, setActionSaving] = useState(false);
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const assignmentsRequestRef = useRef(0);

  const filteredEpis = useMemo(
    () => filterByTerm(epis, deferredEpiSearch, ['nome', 'ca']),
    [epis, deferredEpiSearch],
  );
  const filteredUsers = useMemo(
    () => filterByTerm(userOptions, deferredUserSearch, ['nome', 'funcao']),
    [deferredUserSearch, userOptions],
  );
  const availableUsers = useMemo(() => {
    if (!selectedUser) {
      return filteredUsers;
    }

    return [selectedUser, ...filteredUsers.filter((item) => item.id !== selectedUser.id)];
  }, [filteredUsers, selectedUser]);
  const availableEpis = useMemo(() => {
    if (!selectedEpi) {
      return filteredEpis;
    }

    return [selectedEpi, ...filteredEpis.filter((item) => item.id !== selectedEpi.id)];
  }, [filteredEpis, selectedEpi]);
  const usersMap = useMemo(
    () => new Map(availableUsers.map((item) => [item.id, item.nome])),
    [availableUsers],
  );
  const episMap = useMemo(
    () => new Map(availableEpis.map((item) => [item.id, item.nome])),
    [availableEpis],
  );

  const loadAssignments = useCallback(async () => {
    const requestId = ++assignmentsRequestRef.current;
    try {
      setAssignmentsLoading(true);
      const assignmentsPage = await epiAssignmentsService.findPaginated({
        page,
        limit: 20,
      });
      if (requestId !== assignmentsRequestRef.current) {
        return;
      }
      setAssignments(assignmentsPage.data);
      setTotal(assignmentsPage.total);
      setLastPage(assignmentsPage.lastPage);
    } catch (error) {
      logger.error('Erro ao carregar fichas EPI:', error);
      toast.error('Erro ao carregar fichas de EPI.');
    } finally {
      if (requestId === assignmentsRequestRef.current) {
        setAssignmentsLoading(false);
      }
    }
  }, [page]);

  const loadSummary = useCallback(async () => {
    try {
      setSummaryLoading(true);
      const summaryData = await summaryCache.fetch();
      setSummary(summaryData);
    } catch (error) {
      logger.error('Erro ao carregar resumo de EPI:', error);
      toast.error('Erro ao carregar resumo de EPI.');
    } finally {
      setSummaryLoading(false);
    }
  }, [summaryCache]);

  const refreshAll = useCallback(async () => {
    await loadAssignments();
    void loadSummary();
  }, [loadAssignments, loadSummary]);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    const loadEpis = async () => {
      try {
        const nextEpis = dedupeById(await episLookupCache.fetch());
        setEpis(nextEpis);
      } catch (error) {
        logger.error('Erro ao carregar EPIs:', error);
        toast.error('Erro ao carregar catálogo de EPIs.');
      }
    };

    void loadEpis();
  }, [episLookupCache]);

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const nextUsers = dedupeById(await usersLookupCache.fetch());
        setUserOptions(nextUsers);
      } catch (error) {
        logger.error('Erro ao carregar colaboradores da ficha EPI:', error);
        toast.error('Erro ao carregar colaboradores.');
      }
    };

    void loadUsers();
  }, [usersLookupCache]);

  const handleCreate = async () => {
    if (!form.epi_id || !form.user_id) {
      toast.error('Selecione EPI e colaborador.');
      return;
    }
    if (!deliverySignature) {
      toast.error('Assinatura de entrega obrigatoria.');
      return;
    }
    try {
      setCreating(true);
      await epiAssignmentsService.create({
        epi_id: form.epi_id,
        user_id: form.user_id,
        quantidade: Number(form.quantidade) || 1,
        observacoes: form.observacoes || undefined,
        assinatura_entrega: {
          signature_data: deliverySignature,
          signature_type: deliverySignatureType,
          signer_name: usersMap.get(form.user_id),
        },
      });
      summaryCache.invalidate();
      toast.success('Ficha de EPI registrada.');
      setForm({ epi_id: '', user_id: '', quantidade: 1, observacoes: '' });
      setDeliverySignature('');
      setDeliverySignatureType('digital');
      setSelectedEpi(null);
      setSelectedUser(null);
      setEpiSearch('');
      setUserSearch('');
      if (page !== 1) {
        setPage(1);
        void loadSummary();
        return;
      }
      await refreshAll();
    } catch (error) {
      logger.error('Erro ao criar ficha EPI:', error);
      toast.error('Falha ao registrar ficha de EPI.');
    } finally {
      setCreating(false);
    }
  };

  const openReturn = (assignment: EpiAssignment, signatureData: string, signatureType: string) => {
    setActionReason('');
    setActionModal({ assignment, mode: 'return', signatureData, signatureType });
  };

  const openReplace = (assignment: EpiAssignment) => {
    setActionReason(assignment.motivo_devolucao || '');
    setActionModal({ assignment, mode: 'replace' });
  };

  const confirmAssignmentAction = async () => {
    if (!actionModal || (actionModal.mode === 'replace' && !actionReason.trim())) return;
    const { assignment, mode, signatureData, signatureType } = actionModal;
    try {
      setActionSaving(true);
      if (mode === 'return') {
        if (!signatureData || !signatureType) return;
        await epiAssignmentsService.returnAssignment(assignment.id, {
          assinatura_devolucao: {
            signature_data: signatureData,
            signature_type: signatureType,
            signer_name: assignment.user?.nome || usersMap.get(assignment.user_id),
          },
          motivo_devolucao: actionReason.trim() || undefined,
        });
        toast.success('Devolucao registrada.');
      } else {
        await epiAssignmentsService.replaceAssignment(assignment.id, {
          motivo_substituicao: actionReason.trim(),
        });
        toast.success('Ficha marcada como substituida.');
      }
      summaryCache.invalidate();
      setActionModal(null);
      await refreshAll();
    } catch (error) {
      logger.error('Erro ao atualizar ficha EPI:', error);
      toast.error('Falha ao atualizar a ficha de EPI.');
    } finally {
      setActionSaving(false);
    }
  };

  const openGovernedPdf = async (assignment: EpiAssignment) => {
    try {
      setPdfLoadingId(assignment.id);
      const access = assignment.pdf_file_key
        ? await epiAssignmentsService.getPdfAccess(assignment.id)
        : await epiAssignmentsService.generateFinalPdf(assignment.id);
      if (!access.url) {
        toast.error(access.message || 'PDF governado indisponível no momento.');
        return;
      }
      const link = document.createElement('a');
      link.href = access.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.click();
    } catch (error) {
      logger.error('Erro ao emitir ou abrir PDF governado da ficha EPI:', error);
      toast.error('Não foi possível acessar o PDF oficial da ficha.');
    } finally {
      setPdfLoadingId(null);
    }
  };

  const resolveCaStatus = (validadeCa?: string) => {
    if (!validadeCa) return 'Nao informado';
    const due = new Date(validadeCa);
    if (due < new Date()) return 'CA expirado';
    return 'CA valido';
  };

  return (
    <div className="ds-system-scope mx-auto max-w-6xl space-y-6">
      <section className={`${panelClassName} p-5`}>
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl space-y-2">
            <p className={sectionEyebrowClassName}>Fichas de EPI</p>
            <h1 className="text-2xl font-semibold text-[var(--ds-color-text-primary)]">
              Entrega, devolução e rastreabilidade
            </h1>
            <p className="text-sm text-[var(--ds-color-text-secondary)]">
              Controle de CA, movimentação por colaborador e assinatura eletrônica com carimbo de tempo.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5">
              <p className={sectionEyebrowClassName}>Total</p>
              <p className="mt-1 text-xl font-semibold text-[var(--ds-color-text-primary)]">
                {summaryLoading ? '...' : summary.total}
              </p>
            </div>
            <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5">
              <p className={sectionEyebrowClassName}>Entregues</p>
              <p className="mt-1 text-xl font-semibold text-[var(--ds-color-text-primary)]">
                {summaryLoading ? '...' : summary.entregue}
              </p>
            </div>
            <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5">
              <p className={sectionEyebrowClassName}>Devolvidos</p>
              <p className="mt-1 text-xl font-semibold text-[var(--ds-color-text-primary)]">
                {summaryLoading ? '...' : summary.devolvido}
              </p>
            </div>
            <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5">
              <p className={sectionEyebrowClassName}>Substituídos</p>
              <p className="mt-1 text-xl font-semibold text-[var(--ds-color-text-primary)]">
                {summaryLoading ? '...' : summary.substituido}
              </p>
            </div>
            <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5">
              <p className={sectionEyebrowClassName}>CA expirado</p>
              <p className="mt-1 text-xl font-semibold text-[var(--ds-color-text-primary)]">
                {summaryLoading ? '...' : summary.caExpirado}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={panelClassName}>
        <div className="border-b border-[var(--ds-color-border-subtle)] px-5 py-4">
          <div className={sectionHeaderClassName}>
            <p className={sectionEyebrowClassName}>Filtro rápido</p>
            <p className={sectionDescriptionClassName}>
              Ajuste as listas de EPIs e colaboradores antes de montar uma nova ficha de entrega.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 px-5 py-5 md:grid-cols-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[var(--ds-color-text-secondary)]" htmlFor="epi-search">
              Buscar EPI
            </label>
            <input
              id="epi-search"
              type="text"
              value={epiSearch}
              onChange={(e) => { setEpiSearch(e.target.value); setSelectedEpi(null); setForm((prev) => ({ ...prev, epi_id: '' })); }}
              className={fieldClassName}
              placeholder="Nome ou C.A."
              aria-controls="epi_id"
              aria-label="Filtrar EPIs disponíveis"
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[var(--ds-color-text-secondary)]" htmlFor="user-search">
              Buscar colaborador
            </label>
            <input
              id="user-search"
              type="text"
              value={userSearch}
              onChange={(e) => { setUserSearch(e.target.value); setSelectedUser(null); setForm((prev) => ({ ...prev, user_id: '' })); }}
              className={fieldClassName}
              placeholder="Nome ou função"
              aria-controls="user_id"
              aria-label="Filtrar colaboradores disponíveis"
            />
          </div>
        </div>
      </section>

      <section className={panelClassName}>
        <div className="border-b border-[var(--ds-color-border-subtle)] px-5 py-4">
          <div className={sectionHeaderClassName}>
            <p className={sectionEyebrowClassName}>Nova ficha de entrega</p>
            <p className={sectionDescriptionClassName}>
              Selecione o EPI, o colaborador e a assinatura para registrar a movimentação com rastreabilidade.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-5 px-5 py-5 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[var(--ds-color-text-secondary)]" htmlFor="epi_id">
              EPI
            </label>
            <select
              id="epi_id"
              value={form.epi_id}
              onChange={(e) => {
                const value = e.target.value;
                const found = availableEpis.find((item) => item.id === value) || null;
                setSelectedEpi(found);
                setForm((prev) => ({ ...prev, epi_id: value }));
                if (found) setEpiSearch(found.nome);
              }}
              className={fieldClassName}
              aria-labelledby="epi-search"
            >
              <option value="">Selecione um EPI</option>
              {availableEpis.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.nome}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[var(--ds-color-text-secondary)]" htmlFor="user_id">
              Colaborador
            </label>
            <select
              id="user_id"
              value={form.user_id}
              onChange={(e) => {
                const value = e.target.value;
                const found = availableUsers.find((item) => item.id === value) || null;
                setSelectedUser(found);
                setForm((prev) => ({ ...prev, user_id: value }));
                if (found) setUserSearch(found.nome);
              }}
              className={fieldClassName}
              aria-labelledby="user-search"
            >
              <option value="">Selecione um colaborador</option>
              {availableUsers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.nome}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[var(--ds-color-text-secondary)]" htmlFor="quantidade">
              Quantidade
            </label>
            <input
              id="quantidade"
              type="number"
              min={1}
              value={form.quantidade}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  quantidade: Number(e.target.value) || 1,
                }))
              }
              className={fieldClassName}
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[var(--ds-color-text-secondary)]" htmlFor="signature-action">
              Assinatura
            </label>
            <button
              id="signature-action"
              type="button"
              onClick={() => setSignatureTarget({ mode: 'create' })}
              className={`inline-flex h-[46px] w-full items-center justify-center rounded-[var(--ds-radius-md)] border px-4 text-sm font-semibold transition-colors ${
                deliverySignature
                  ? 'border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success)]'
                  : 'border-[var(--ds-color-border-default)] text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]'
              }`}
            >
              {deliverySignature ? 'Assinatura capturada' : 'Assinar entrega'}
            </button>
          </div>
          <div className="space-y-2 lg:col-span-2">
            <label className="block text-sm font-medium text-[var(--ds-color-text-secondary)]" htmlFor="observacoes">
              Observações
            </label>
            <textarea
              id="observacoes"
              value={form.observacoes}
              onChange={(e) => setForm((prev) => ({ ...prev, observacoes: e.target.value }))}
              className={fieldClassName}
              rows={4}
              placeholder="Observações, restrições ou detalhes da entrega"
            />
          </div>
          <div className="lg:col-span-2 flex justify-end border-t border-[var(--ds-color-border-subtle)] pt-4">
            <button
              type="button"
              disabled={creating}
              onClick={() => void handleCreate()}
              className="inline-flex items-center justify-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--ds-color-action-primary-foreground)] transition-colors hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-60"
            >
              <Plus className="mr-2 h-4 w-4" />
              {creating ? 'Salvando...' : 'Registrar'}
            </button>
          </div>
        </div>
      </section>

      <section className={panelClassName}>
        <div className="border-b border-[var(--ds-color-border-subtle)] px-5 py-4">
          <div className={sectionHeaderClassName}>
            <p className={sectionEyebrowClassName}>Movimentações registradas</p>
            <p className={sectionDescriptionClassName}>
              Acompanhe as fichas emitidas, a validade do CA e as ações de devolução ou substituição.
            </p>
          </div>
        </div>
        <ResponsiveDataList
          items={assignments}
          getKey={(assignment) => assignment.id}
          loading={assignmentsLoading ? <p className="p-6 text-center text-sm">Carregando fichas...</p> : undefined}
          empty={<p className="p-6 text-center text-sm text-[var(--ds-color-text-muted)]">Nenhuma ficha registrada.</p>}
          mobileClassName="space-y-3 p-3"
          mobile={(assignment) => (
            <article className="ds-mobile-card">
              <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold">{assignment.user?.nome || usersMap.get(assignment.user_id) || '-'}</h3><p className="text-sm text-[var(--ds-color-text-secondary)]">{assignment.epi?.nome || episMap.get(assignment.epi_id) || '-'}</p></div><span className="rounded-full border px-2.5 py-1 text-xs font-semibold">{assignment.status}</span></div>
              <dl className="ds-mobile-detail-grid mt-3 grid grid-cols-1 gap-3 text-sm min-[360px]:grid-cols-2"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">CA</dt><dd>{assignment.ca || '-'}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Validade</dt><dd>{assignment.validade_ca ? (<><span>{safeToLocaleDateString(assignment.validade_ca, 'pt-BR', undefined, '—')}</span>{' '}<span className={resolveCaStatus(assignment.validade_ca) === 'CA expirado' ? 'text-[var(--ds-color-danger)] font-semibold' : 'text-[var(--ds-color-success)]'}>({resolveCaStatus(assignment.validade_ca)})</span></>) : '-'}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Entrega</dt><dd>{safeToLocaleDateString(assignment.entregue_em, 'pt-BR', undefined, '—')}</dd></div></dl>
              <div className="ds-mobile-card__actions mt-4 grid grid-cols-1 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3 min-[360px]:grid-cols-2 sm:grid-cols-3">
                <Button size="sm" variant="outline" onClick={() => void openGovernedPdf(assignment)} disabled={pdfLoadingId === assignment.id}>
                  <FileDown className="mr-1 h-4 w-4" />
                  {pdfLoadingId === assignment.id ? 'Processando...' : assignment.pdf_file_key ? 'Abrir PDF oficial' : 'Emitir PDF oficial'}
                </Button>
                {canManageEpi && assignment.status === 'entregue' ? <><Button size="sm" variant="success" onClick={() => setSignatureTarget({ mode: 'return', assignmentId: assignment.id })}>Devolver</Button><Button size="sm" variant="outline" onClick={() => openReplace(assignment)}>Substituir</Button></> : null}
              </div>
            </article>
          )}
          desktop={() => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Colaborador</TableHead>
              <TableHead>EPI</TableHead>
              <TableHead>CA</TableHead>
              <TableHead>Validade CA</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Entrega</TableHead>
              <TableHead className="text-right">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignmentsLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-[var(--ds-color-text-muted)]">
                  Carregando fichas...
                </TableCell>
              </TableRow>
            ) : assignments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-[var(--ds-color-text-muted)]">
                  Nenhuma ficha registrada.
                </TableCell>
              </TableRow>
            ) : (
              assignments.map((assignment) => (
                <TableRow key={assignment.id}>
                  <TableCell>
                    {assignment.user?.nome || usersMap.get(assignment.user_id) || '-'}
                  </TableCell>
                  <TableCell>
                    {assignment.epi?.nome || episMap.get(assignment.epi_id) || '-'}
                  </TableCell>
                  <TableCell>{assignment.ca || '-'}</TableCell>
                  <TableCell>
                    {assignment.validade_ca ? (
                      <>
                        <span>{safeToLocaleDateString(assignment.validade_ca, 'pt-BR', undefined, '—')}</span>
                        {' '}
                        <span className={resolveCaStatus(assignment.validade_ca) === 'CA expirado' ? 'font-semibold text-[var(--ds-color-danger)]' : 'text-[var(--ds-color-success)]'}>
                          ({resolveCaStatus(assignment.validade_ca)})
                        </span>
                      </>
                    ) : '-'}
                  </TableCell>
                  <TableCell>{assignment.status}</TableCell>
                  <TableCell>
                    {safeToLocaleDateString(assignment.entregue_em, 'pt-BR', undefined, '—')}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center rounded border px-2 py-1 text-xs text-[var(--ds-color-text-primary)] hover:bg-[var(--ds-color-primary-subtle)] disabled:opacity-60"
                        onClick={() => void openGovernedPdf(assignment)}
                        disabled={pdfLoadingId === assignment.id}
                      >
                        <FileDown className="mr-1 h-3.5 w-3.5" />
                        {pdfLoadingId === assignment.id
                          ? 'Processando...'
                          : assignment.pdf_file_key
                            ? 'PDF oficial'
                            : 'Emitir PDF'}
                      </button>
                      {canManageEpi && assignment.status === 'entregue' && (
                        <button
                          type="button"
                          className="rounded border px-2 py-1 text-xs text-[var(--ds-color-success)] hover:bg-[var(--ds-color-success-subtle)]"
                          onClick={() =>
                            setSignatureTarget({
                              mode: 'return',
                              assignmentId: assignment.id,
                            })
                          }
                        >
                          Devolver
                        </button>
                      )}
                      {canManageEpi && assignment.status === 'entregue' && (
                        <button
                          type="button"
                          className="rounded border px-2 py-1 text-xs text-[var(--ds-color-text-primary)] hover:bg-[var(--ds-color-primary-subtle)]"
                          onClick={() => openReplace(assignment)}
                        >
                          Substituir
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
          )}
        />
        {!assignmentsLoading && assignments.length > 0 ? (
          <PaginationControls
            page={page}
            lastPage={lastPage}
            total={total}
            onPrev={handlePrevPage}
            onNext={handleNextPage}
          />
        ) : null}
      </section>

      <SignatureModal
        isOpen={Boolean(signatureTarget)}
        onClose={() => setSignatureTarget(null)}
        userName={
          signatureTarget?.mode === 'create'
            ? usersMap.get(form.user_id) || 'Colaborador'
            : signatureTarget?.mode === 'return'
              ? assignments.find((item) => item.id === signatureTarget.assignmentId)
                  ?.user?.nome ||
                usersMap.get(
                  assignments.find((item) => item.id === signatureTarget.assignmentId)
                    ?.user_id || '',
                ) ||
                'Colaborador'
              : 'Colaborador'
        }
        onSave={(signatureData, type) => {
          if (!signatureTarget) {
            return;
          }
          if (signatureTarget.mode === 'create') {
            setDeliverySignature(signatureData);
            const normalizedType =
              type === 'upload' || type === 'facial' ? type : 'digital';
            setDeliverySignatureType(normalizedType);
            toast.success('Assinatura de entrega capturada.');
            return;
          }
          const assignment = assignments.find(
            (item) => item.id === signatureTarget.assignmentId,
          );
          if (!assignment) {
            toast.error('Ficha nao encontrada para devolucao.');
            return;
          }
          openReturn(assignment, signatureData, type);
        }}
      />
      <ModalFrame isOpen={Boolean(actionModal)} onClose={() => !actionSaving && setActionModal(null)} shellClassName="max-w-md">
        <form onSubmit={(event) => { event.preventDefault(); void confirmAssignmentAction(); }}>
          <ModalHeader title={actionModal?.mode === 'replace' ? 'Substituir EPI' : 'Registrar devolução'} description={actionModal?.mode === 'replace' ? 'Informe o motivo obrigatório da substituição.' : 'Confirme a devolução assinada e, se necessário, registre o motivo.'} onClose={() => !actionSaving && setActionModal(null)} />
          <ModalBody><label htmlFor="epi-action-reason" className="mb-1.5 block text-sm font-medium">Motivo {actionModal?.mode === 'replace' ? '*' : '(opcional)'}</label><textarea id="epi-action-reason" required={actionModal?.mode === 'replace'} rows={4} value={actionReason} onChange={(e) => setActionReason(e.target.value)} className="min-h-24 w-full rounded-md border p-3" /></ModalBody>
          <ModalFooter><Button variant="outline" onClick={() => setActionModal(null)} disabled={actionSaving}>Cancelar</Button><Button type="submit" loading={actionSaving} disabled={actionModal?.mode === 'replace' && !actionReason.trim()}>Confirmar</Button></ModalFooter>
        </form>
      </ModalFrame>
    </div>
  );
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function filterByTerm<T extends object>(
  items: T[],
  term: string,
  fields: Array<keyof T>,
) {
  const normalized = term.trim().toLowerCase();
  if (!normalized) {
    return items;
  }

  return items.filter((item) =>
    fields.some((field) => {
      const value = item[field];
      return typeof value === 'string' && value.toLowerCase().includes(normalized);
    }),
  );
}



