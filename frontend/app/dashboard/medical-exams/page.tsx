'use client';
import { logger } from '@/lib/logger';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  medicalExamsService,
  MedicalExam,
  MedicalExamExpirySummary,
  MedicalExamLookupUser,
  TIPO_EXAME_LABEL,
  RESULTADO_LABEL,
} from '@/services/medicalExamsService';
import { downloadExcel } from '@/lib/download-excel';
import { maskCpf } from '@/lib/format/cpf';
import {
  Calendar,
  FileSpreadsheet,
  Pencil,
  Plus,
  ShieldAlert,
  Stethoscope,
  Trash2,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PaginationControls } from '@/components/PaginationControls';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, InlineLoadingState } from '@/components/ui/state';
import { InlineCallout } from '@/components/ui/inline-callout';
import { ListPageLayout } from '@/components/layout';
import { cn } from '@/lib/utils';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';
import {
  ModalBody,
  ModalFooter,
  ModalFrame,
  ModalHeader,
} from '@/components/ui/modal-frame';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import {
  formatMedicalExamDateOnly,
  getMedicalExamExpiryTone,
  toMedicalExamInputDateValue,
} from '@/lib/medical-exams/date';

type FormState = {
  user_id: string;
  tipo_exame: string;
  resultado: string;
  data_realizacao: string;
  data_vencimento: string;
  medico_responsavel: string;
  crm_medico: string;
  observacoes: string;
};

const INITIAL_FORM: FormState = {
  user_id: '',
  tipo_exame: 'periodico',
  resultado: 'apto',
  data_realizacao: '',
  data_vencimento: '',
  medico_responsavel: '',
  crm_medico: '',
  observacoes: '',
};

const fieldClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60';

const labelClassName =
  'mb-1.5 block text-sm font-medium text-[var(--ds-color-text-secondary)]';

function getResultTone(resultado: string): StatusTone {
  switch (resultado) {
    case 'inapto':
      return 'danger';
    case 'apto_com_restricoes':
      return 'warning';
    default:
      return 'success';
  }
}

export default function MedicalExamsPage() {
  const [exams, setExams] = useState<MedicalExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);
  const [summary, setSummary] = useState<MedicalExamExpirySummary>({
    total: 0,
    expired: 0,
    expiringSoon: 0,
    valid: 0,
  });
  const [filterTipo, setFilterTipo] = useState('');
  const [filterResultado, setFilterResultado] = useState('');
  const [users, setUsers] = useState<MedicalExamLookupUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MedicalExam | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const usersRequestRef = useRef(0);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(() =>
    selectedTenantStore.get()?.companyId || sessionStore.get()?.companyId || null,
  );

  useEffect(() => {
    const syncActiveCompanyId = () => {
      setActiveCompanyId(
        selectedTenantStore.get()?.companyId ||
        sessionStore.get()?.companyId ||
        null,
      );
    };

    syncActiveCompanyId();
    const unsubscribe = selectedTenantStore.subscribe(syncActiveCompanyId);
    return () => {
      unsubscribe();
    };
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      if (!activeCompanyId) {
        setExams([]);
        setTotal(0);
        setLastPage(1);
        return;
      }

      const paged = await medicalExamsService.findPaginated({
        page,
        limit,
        tipo_exame: filterTipo || undefined,
        resultado: filterResultado || undefined,
        companyId: activeCompanyId,
      });

      setExams(paged.data);
      setTotal(paged.total);
      setLastPage(paged.lastPage);
    } catch (error) {
      logger.error('Erro ao carregar exames medicos:', error);
      setLoadError('Nao foi possivel carregar o monitor de exames medicos.');
      toast.error('Erro ao carregar exames medicos.');
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, page, limit, filterTipo, filterResultado]);

  const loadSummary = useCallback(async () => {
    try {
      if (!activeCompanyId) {
        setSummary({
          total: 0,
          expired: 0,
          expiringSoon: 0,
          valid: 0,
        });
        return;
      }

      const sum = await medicalExamsService.getExpirySummary(activeCompanyId);
      setSummary(sum);
    } catch (error) {
      logger.error('Erro ao carregar resumo de exames medicos:', error);
    }
  }, [activeCompanyId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (!showModal) {
      return;
    }

    if (!activeCompanyId) {
      setUsers([]);
      setUsersLoading(false);
      return;
    }

    const requestId = ++usersRequestRef.current;
    setUsersLoading(true);

    void medicalExamsService
      .findAllLookupUsers(undefined, activeCompanyId)
      .then((data) => {
        if (requestId !== usersRequestRef.current) {
          return;
        }
        setUsers(data);
      })
      .catch((error) => {
        if (requestId !== usersRequestRef.current) {
          return;
        }
        logger.error('Erro ao carregar colaboradores para exames medicos:', error);
        toast.error('Nao foi possivel carregar a lista de colaboradores.');
      })
      .finally(() => {
        if (requestId === usersRequestRef.current) {
          setUsersLoading(false);
        }
      });
  }, [activeCompanyId, showModal]);

  const openCreate = () => {
    if (!activeCompanyId) {
      toast.error('Selecione uma empresa antes de registrar um exame.');
      return;
    }
    setEditId(null);
    setForm(INITIAL_FORM);
    setShowModal(true);
  };

  const openEdit = (exam: MedicalExam) => {
    if (!activeCompanyId) {
      toast.error('Selecione uma empresa antes de editar um exame.');
      return;
    }
    setEditId(exam.id);
    setForm({
      user_id: exam.user_id,
      tipo_exame: exam.tipo_exame,
      resultado: exam.resultado,
      data_realizacao: toMedicalExamInputDateValue(exam.data_realizacao),
      data_vencimento: toMedicalExamInputDateValue(exam.data_vencimento),
      medico_responsavel: exam.medico_responsavel ?? '',
      crm_medico: exam.crm_medico ?? '',
      observacoes: exam.observacoes ?? '',
    });
    setShowModal(true);
  };

  const closeModal = () => {
    if (saving) return;
    setShowModal(false);
  };

  const handleSave = async () => {
    if (!activeCompanyId) {
      toast.error('Selecione uma empresa antes de salvar um exame.');
      return;
    }
    if (!form.user_id || !form.data_realizacao) {
      toast.error('Funcionario e data de realizacao sao obrigatorios.');
      return;
    }

    setSaving(true);

    try {
      const payload = {
        ...form,
        data_vencimento: form.data_vencimento || undefined,
        medico_responsavel: form.medico_responsavel || undefined,
        crm_medico: form.crm_medico || undefined,
        observacoes: form.observacoes || undefined,
      };

      if (editId) {
        await medicalExamsService.update(editId, payload, activeCompanyId);
        toast.success('Exame atualizado com sucesso.');
      } else {
        await medicalExamsService.create(payload, activeCompanyId);
        toast.success('Exame registrado com sucesso.');
      }

      setShowModal(false);
      await loadData();
      void loadSummary();
    } catch (error) {
      logger.error('Erro ao salvar exame medico:', error);
      toast.error('Erro ao salvar exame.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!activeCompanyId || !deleteTarget) return;
    try {
      setDeleting(true);
      await medicalExamsService.delete(deleteTarget.id, activeCompanyId);
      toast.success('Exame excluido.');
      setDeleteTarget(null);
      await loadData();
      void loadSummary();
    } catch (error) {
      logger.error('Erro ao excluir exame medico:', error);
      toast.error('Erro ao excluir exame.');
    } finally {
      setDeleting(false);
    }
  };

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar exames medicos"
        description={loadError}
        action={
          <Button type="button" onClick={loadData}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ListPageLayout
        eyebrow="Saude ocupacional"
        title="Exames Medicos (PCMSO)"
        description="Controle de ASOs conforme NR-7, com visao de vencimentos e status ocupacional."
        icon={<Stethoscope className="h-5 w-5" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              data-offline-action="read"
              size="sm"
              leftIcon={<FileSpreadsheet className="h-4 w-4 text-[var(--ds-color-success)]" />}
              onClick={() => downloadExcel('/medical-exams/export/excel', 'exames-medicos.xlsx')}
            >
              Exportar Excel
            </Button>
            <Button
              type="button"
              size="sm"
              data-offline-action="write"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={openCreate}
            >
              Registrar exame
            </Button>
          </div>
        }
        metrics={
          loading && exams.length === 0
            ? []
            : [
              {
                label: 'Total monitorado',
                value: summary.total,
                note: 'ASOs registrados no recorte atual.',
              },
              {
                label: 'ASOs vencidos',
                value: summary.expired,
                note: 'Colaboradores fora de conformidade ocupacional.',
                tone: 'danger',
              },
              {
                label: 'Vencendo em 30 dias',
                value: summary.expiringSoon,
                note: 'Prioridade de agenda para evitar bloqueios.',
                tone: 'warning',
              },
              {
                label: 'Exames validos',
                value: summary.valid,
                note: 'Populacao liberada dentro do PCMSO.',
                tone: 'success',
              },
            ]
        }
        toolbarTitle="Exames registrados"
        toolbarDescription={`${total} registro(s) monitorados com filtros por tipo e resultado.`}
        toolbarContent={
          <div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-end">
            <select
              value={filterTipo}
              onChange={(event) => {
                setFilterTipo(event.target.value);
                setPage(1);
              }}
              className={cn(fieldClassName, 'w-full md:w-auto md:min-w-[220px]')}
            >
              <option value="">Todos os tipos</option>
              {Object.entries(TIPO_EXAME_LABEL).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <select
              value={filterResultado}
              onChange={(event) => {
                setFilterResultado(event.target.value);
                setPage(1);
              }}
              className={cn(fieldClassName, 'w-full md:w-auto md:min-w-[220px]')}
            >
              <option value="">Todos os resultados</option>
              {Object.entries(RESULTADO_LABEL).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        }
        footer={
          exams.length > 0 ? (
            <PaginationControls
              page={page}
              lastPage={lastPage}
              total={total}
              onPrev={handlePrevPage}
              onNext={handleNextPage}
            />
          ) : null
        }
      >
        {loading && exams.length === 0 ? (
          <div className="p-6">
            <InlineLoadingState label="Carregando monitor de exames médicos..." />
          </div>
        ) : null}

        <div className="space-y-4">
          {!loading && summary.expired > 0 ? (
            <InlineCallout
              tone="danger"
              icon={<ShieldAlert className="h-4 w-4" />}
              title="Acao recomendada"
              description={`Existem ${summary.expired} exame(s) vencido(s). Priorize a regularizacao para evitar bloqueio ocupacional e nao conformidades no PCMSO.`}
            />
          ) : null}

          {exams.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="Nenhum exame medico encontrado"
                description="Ainda nao existem ASOs registrados para este tenant com os filtros atuais."
                action={
                  <Button type="button" leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
                    Registrar exame
                  </Button>
                }
              />
            </div>
          ) : (
            <ResponsiveDataList
              items={exams}
              getKey={(exam) => exam.id}
              mobileClassName="space-y-3 p-3"
              mobile={(exam) => {
                const expiry = getMedicalExamExpiryTone(exam.data_vencimento);
                return <article className="ds-mobile-card">
                  <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold">{exam.user?.nome ?? 'Colaborador'}</h3><p className="text-sm text-[var(--ds-color-text-secondary)]">{TIPO_EXAME_LABEL[exam.tipo_exame] ?? exam.tipo_exame}</p></div><StatusPill tone={getResultTone(exam.resultado)}>{RESULTADO_LABEL[exam.resultado] ?? exam.resultado}</StatusPill></div>
                  <dl className="ds-mobile-detail-grid mt-3 grid grid-cols-1 gap-3 text-sm min-[360px]:grid-cols-2"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Realização</dt><dd>{formatMedicalExamDateOnly(exam.data_realizacao)}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Vencimento</dt><dd>{exam.data_vencimento ? formatMedicalExamDateOnly(exam.data_vencimento) : 'Sem vencimento'}<span className="block text-xs text-[var(--ds-color-text-muted)]">{expiry.label}</span></dd></div><div className="col-span-2"><dt className="text-xs text-[var(--ds-color-text-muted)]">Médico</dt><dd>{exam.medico_responsavel ?? '-'}</dd></div></dl>
                  <div className="ds-mobile-card__actions mt-4 grid grid-cols-1 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3 min-[360px]:grid-cols-2"><Button variant="outline" size="sm" data-offline-action="write" onClick={() => openEdit(exam)} leftIcon={<Pencil className="h-4 w-4" />}>Editar</Button><Button variant="danger" size="sm" data-offline-action="write" onClick={() => setDeleteTarget(exam)} leftIcon={<Trash2 className="h-4 w-4" />}>Excluir</Button></div>
                </article>;
              }}
              desktop={() => (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Funcionario</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Resultado</TableHead>
                      <TableHead>Data realizacao</TableHead>
                      <TableHead>Vencimento</TableHead>
                      <TableHead>Medico responsavel</TableHead>
                      <TableHead className="text-right">Acoes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exams.map((exam) => {
                      const expiryTone = getMedicalExamExpiryTone(exam.data_vencimento);

                      return (
                        <TableRow key={exam.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--ds-color-action-primary)]/12 text-[var(--ds-color-action-primary)]">
                                <User className="h-4 w-4" />
                              </div>
                              <div>
                                <div className="font-medium text-[var(--ds-color-text-primary)]">
                                  {exam.user?.nome ?? 'Colaborador'}
                                </div>
                                <div className="text-xs text-[var(--ds-color-text-muted)]">
                                  {exam.user?.cpf ? maskCpf(exam.user.cpf) : `ID ${exam.user_id.slice(0, 8)}`}
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            {TIPO_EXAME_LABEL[exam.tipo_exame] ?? exam.tipo_exame}
                          </TableCell>
                          <TableCell>
                            <StatusPill tone={getResultTone(exam.resultado)}>
                              {RESULTADO_LABEL[exam.resultado] ?? exam.resultado}
                            </StatusPill>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 text-[var(--ds-color-text-secondary)]">
                              <Calendar className="h-4 w-4" />
                              <span>
                                {formatMedicalExamDateOnly(exam.data_realizacao)}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {exam.data_vencimento ? (
                              <div className="flex flex-col gap-1">
                                <StatusPill tone={expiryTone.tone}>
                                  {formatMedicalExamDateOnly(exam.data_vencimento)}
                                  {expiryTone.tone === 'warning' && <ShieldAlert className="ml-1.5 h-3.5 w-3.5 inline" />}
                                </StatusPill>
                                <span className="text-xs text-[var(--ds-color-text-muted)]">
                                  {expiryTone.label}
                                </span>
                              </div>
                            ) : (
                              <span className="text-xs text-[var(--ds-color-text-muted)]">
                                Sem vencimento
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-[var(--ds-color-text-secondary)]">
                            {exam.medico_responsavel ?? '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                data-offline-action="write"
                                onClick={() => openEdit(exam)}
                                title="Editar exame"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                data-offline-action="write"
                                onClick={() => setDeleteTarget(exam)}
                                title="Excluir exame"
                                className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            />
          )}
        </div>
      </ListPageLayout>

      <ModalFrame isOpen={showModal} onClose={closeModal} shellClassName="max-w-5xl">
        <form
          data-offline-action="write"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <ModalHeader
            title={editId ? 'Editar exame médico' : 'Registrar exame médico'}
            description="Preencha os dados clínicos e de validade do ASO ocupacional."
            onClose={closeModal}
          />

          <ModalBody className="flex-1 min-h-0 space-y-6">
            <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-subtle)]/60 px-4 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-muted)]">
                    Estrutura do exame
                  </p>
                  <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                    Organize o ASO por colaborador, datas e responsável clínico.
                  </p>
                </div>
                <div className="inline-flex items-center rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-1 text-xs font-medium text-[var(--ds-color-text-secondary)]">
                  Campos com * são obrigatórios
                </div>
              </div>
            </div>

            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  Identificação
                </h3>
                <p className="text-sm text-[var(--ds-color-text-secondary)]">
                  Vincule o registro ao colaborador e classifique o exame.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label htmlFor="medical-exam-user-id" className={labelClassName}>
                    Funcionário *
                  </label>
                  <select
                    id="medical-exam-user-id"
                    value={form.user_id}
                    onChange={(event) => setForm({ ...form, user_id: event.target.value })}
                    aria-label="Funcionario do exame medico"
                    className={fieldClassName}
                    disabled={saving || usersLoading}
                  >
                    <option value="">Selecione...</option>
                    {usersLoading ? (
                      <option value="" disabled>Carregando colaboradores...</option>
                    ) : (
                      [...users].sort((a, b) => a.nome.localeCompare(b.nome)).map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.nome}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div>
                  <label htmlFor="medical-exam-tipo" className={labelClassName}>
                    Tipo de exame *
                  </label>
                  <select
                    id="medical-exam-tipo"
                    value={form.tipo_exame}
                    onChange={(event) => setForm({ ...form, tipo_exame: event.target.value })}
                    aria-label="Tipo de exame"
                    className={fieldClassName}
                    disabled={saving}
                  >
                    {Object.entries(TIPO_EXAME_LABEL).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="medical-exam-resultado" className={labelClassName}>
                    Resultado *
                  </label>
                  <select
                    id="medical-exam-resultado"
                    value={form.resultado}
                    onChange={(event) => setForm({ ...form, resultado: event.target.value })}
                    aria-label="Resultado do exame"
                    className={fieldClassName}
                    disabled={saving}
                  >
                    {Object.entries(RESULTADO_LABEL).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            <div className="h-px bg-[var(--ds-color-border-subtle)]" />

            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  Datas e validade
                </h3>
                <p className="text-sm text-[var(--ds-color-text-secondary)]">
                  Ajuste a realização e a expiração para manter a conformidade ocupacional.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="medical-exam-data-realizacao" className={labelClassName}>
                    Data de realização *
                  </label>
                  <input
                    id="medical-exam-data-realizacao"
                    type="date"
                    value={form.data_realizacao}
                    onChange={(event) => setForm({ ...form, data_realizacao: event.target.value })}
                    aria-label="Data de realizacao do exame"
                    className={fieldClassName}
                    disabled={saving}
                  />
                </div>

                <div>
                  <label htmlFor="medical-exam-data-vencimento" className={labelClassName}>
                    Data de vencimento
                  </label>
                  <input
                    id="medical-exam-data-vencimento"
                    type="date"
                    value={form.data_vencimento}
                    onChange={(event) => setForm({ ...form, data_vencimento: event.target.value })}
                    aria-label="Data de vencimento do exame"
                    className={fieldClassName}
                    disabled={saving}
                  />
                </div>
              </div>
            </section>

            <div className="h-px bg-[var(--ds-color-border-subtle)]" />

            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  Responsável clínico
                </h3>
                <p className="text-sm text-[var(--ds-color-text-secondary)]">
                  Informe o médico e o CRM para rastreabilidade do documento.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="medical-exam-medico" className={labelClassName}>
                    Médico responsável
                  </label>
                  <input
                    id="medical-exam-medico"
                    type="text"
                    value={form.medico_responsavel}
                    onChange={(event) => setForm({ ...form, medico_responsavel: event.target.value })}
                    placeholder="Dr. Nome"
                    className={fieldClassName}
                    disabled={saving}
                  />
                </div>

                <div>
                  <label htmlFor="medical-exam-crm" className={labelClassName}>
                    CRM
                  </label>
                  <input
                    id="medical-exam-crm"
                    type="text"
                    value={form.crm_medico}
                    onChange={(event) => setForm({ ...form, crm_medico: event.target.value })}
                    aria-label="CRM do medico"
                    placeholder="CRM/SP 123456"
                    className={fieldClassName}
                    disabled={saving}
                  />
                </div>
              </div>
            </section>

            <div className="h-px bg-[var(--ds-color-border-subtle)]" />

            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  Observações clínicas
                </h3>
                <p className="text-sm text-[var(--ds-color-text-secondary)]">
                  Use este campo para restrições, observações e contexto relevante do ASO.
                </p>
              </div>

              <div>
                <label htmlFor="medical-exam-observacoes" className={labelClassName}>
                  Observações
                </label>
                <textarea
                  id="medical-exam-observacoes"
                  value={form.observacoes}
                  onChange={(event) => setForm({ ...form, observacoes: event.target.value })}
                  aria-label="Observacoes do exame medico"
                  rows={5}
                  className={cn(fieldClassName, 'min-h-[9rem] resize-y')}
                  disabled={saving}
                />
              </div>
            </section>
          </ModalBody>

          <ModalFooter>
            <Button type="button" variant="outline" onClick={closeModal} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" loading={saving}>
              {editId ? 'Salvar alterações' : 'Registrar exame'}
            </Button>
          </ModalFooter>
        </form>
      </ModalFrame>
      <ConfirmModal open={Boolean(deleteTarget)} onClose={() => !deleting && setDeleteTarget(null)} onConfirm={() => void confirmDelete()} title="Excluir exame médico" description={`Tem certeza que deseja excluir o exame de ${deleteTarget?.user?.nome || 'este colaborador'}? Esta ação não pode ser desfeita.`} confirmLabel="Excluir" loading={deleting} />
    </>
  );
}
