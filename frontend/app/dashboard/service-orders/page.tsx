'use client';
import { logger } from '@/lib/logger';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  serviceOrdersService,
  ServiceOrder,
  OS_STATUS_LABEL,
  OS_ALLOWED_TRANSITIONS,
} from '@/services/serviceOrdersService';
import { usersService } from '@/services/usersService';
import { sitesService } from '@/services/sitesService';
import { downloadExcel } from '@/lib/download-excel';
import {
  ClipboardList,
  FileSpreadsheet,
  Pencil,
  Plus,
  Trash2,
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
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState, ErrorState, InlineLoadingState } from '@/components/ui/state';
import { ListPageLayout } from '@/components/layout';
import { cn } from '@/lib/utils';
import { safeToLocaleDateString } from '@/lib/date/safeFormat';
import { isUserVisibleForSite } from '@/lib/site-scoped-user-visibility';
import { runWithMutationLock } from '@/lib/mutation-lock';
import { useConfirmAction } from '@/components/ui/confirm-action-provider';
import {
  ModalBody,
  ModalFooter,
  ModalFrame,
  ModalHeader,
} from '@/components/ui/modal-frame';
import {
  StatusPill,
  StatusSelect,
  type StatusTone,
} from '@/components/ui/status-pill';

const inputClassName =
  'min-h-11 w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]';

const labelClassName =
  'mb-1.5 block text-sm font-medium text-[var(--ds-color-text-secondary)]';

type User = {
  id: string;
  nome: string;
  company_id?: string;
  site_id?: string;
  site_ids?: string[];
  site?: { id?: string };
  sites?: Array<{ id?: string }>;
  profile?: { nome?: string | null };
};
type Site = { id: string; nome: string };

type FormState = {
  titulo: string;
  descricao_atividades: string;
  responsabilidades: string;
  site_id: string;
  responsavel_id: string;
  data_emissao: string;
  data_inicio: string;
  data_fim_previsto: string;
  riscos_json: string;
  epis_json: string;
};

const INITIAL_FORM: FormState = {
  titulo: '',
  descricao_atividades: '',
  responsabilidades: '',
  site_id: '',
  responsavel_id: '',
  data_emissao: new Date().toISOString().slice(0, 10),
  data_inicio: '',
  data_fim_previsto: '',
  riscos_json: '[]',
  epis_json: '[]',
};

function getOrderStatusTone(status: string): StatusTone {
  switch (status) {
    case 'ativo':
      return 'primary';
    case 'concluido':
      return 'success';
    case 'cancelado':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export default function ServiceOrdersPage() {
  const { confirmAction } = useConfirmAction();
  const [orders, setOrders] = useState<ServiceOrder[]>([]);
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
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSite, setFilterSite] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
  const deleteMutationLock = useRef(false);
  const usersRequestRef = useRef(0);

  const summary = {
    total,
    ativo: orders.filter((o) => o.status === 'ativo').length,
    concluido: orders.filter((o) => o.status === 'concluido').length,
    cancelado: orders.filter((o) => o.status === 'cancelado').length,
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setLoadError(null);
      const paged = await serviceOrdersService.findPaginated({
        page,
        limit,
        status: filterStatus || undefined,
        site_id: filterSite || undefined,
      });
      setOrders(paged.data);
      setTotal(paged.total);
      setLastPage(paged.lastPage);
    } catch (error) {
      logger.error('Erro ao carregar Ordens de Servico:', error);
      setLoadError('Nao foi possivel carregar as Ordens de Servico.');
      toast.error('Erro ao carregar Ordens de Servico.');
    } finally {
      setLoading(false);
    }
  }, [page, limit, filterStatus, filterSite]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    let active = true;

    void sitesService
      .findPaginated({ page: 1, limit: 100 })
      .then((sitesPage) => {
        if (!active) {
          return;
        }
        setSites(dedupeById(sitesPage.data as Site[]));
      })
      .catch(() => {
        if (active) {
          setSites([]);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const requestId = ++usersRequestRef.current;

    const loadUsers = async () => {
      try {
        if (!form.site_id) {
          if (requestId === usersRequestRef.current) {
            setUsers([]);
          }
          return;
        }

        const usersPage = await usersService.findPaginated({
          page: 1,
          limit: 100,
          siteId: form.site_id,
        });

        let nextUsers = usersPage.data as User[];
        if (
          form.responsavel_id &&
          !nextUsers.some((entry) => entry.id === form.responsavel_id)
        ) {
          try {
            const selectedUser = await usersService.findOne(form.responsavel_id);
            nextUsers = dedupeById([selectedUser, ...nextUsers]);
          } catch {
            nextUsers = dedupeById(nextUsers);
          }
        } else {
          nextUsers = dedupeById(nextUsers);
        }

        if (requestId === usersRequestRef.current) {
          setUsers(nextUsers);
        }
      } catch {
        if (requestId === usersRequestRef.current) {
          setUsers([]);
        }
      }
    };

    void loadUsers();
  }, [form.responsavel_id, form.site_id]);

  const openCreate = () => {
    setEditId(null);
    setForm(INITIAL_FORM);
    setShowModal(true);
  };

  const closeModal = () => {
    if (saving) return;
    setShowModal(false);
  };

  const openEdit = (order: ServiceOrder) => {
    setEditId(order.id);
    setForm({
      titulo: order.titulo,
      descricao_atividades: order.descricao_atividades,
      responsabilidades: order.responsabilidades ?? '',
      site_id: order.site_id ?? '',
      responsavel_id: order.responsavel_id ?? '',
      data_emissao: order.data_emissao?.slice(0, 10) ?? '',
      data_inicio: order.data_inicio?.slice(0, 10) ?? '',
      data_fim_previsto: order.data_fim_previsto?.slice(0, 10) ?? '',
      riscos_json: JSON.stringify(order.riscos_identificados ?? [], null, 2),
      epis_json: JSON.stringify(order.epis_necessarios ?? [], null, 2),
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.titulo || !form.descricao_atividades || !form.data_emissao) {
      toast.error('Titulo, descricao e data de emissao sao obrigatorios.');
      return;
    }

    let riscos = null;
    let epis = null;
    try {
      riscos = JSON.parse(form.riscos_json);
      epis = JSON.parse(form.epis_json);
    } catch {
      toast.error('JSON de riscos ou EPIs invalido.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        titulo: form.titulo,
        descricao_atividades: form.descricao_atividades,
        responsabilidades: form.responsabilidades || undefined,
        site_id: form.site_id || undefined,
        responsavel_id: form.responsavel_id || undefined,
        data_emissao: form.data_emissao,
        data_inicio: form.data_inicio || undefined,
        data_fim_previsto: form.data_fim_previsto || undefined,
        riscos_identificados: riscos,
        epis_necessarios: epis,
      };
      if (editId) {
        await serviceOrdersService.update(editId, payload);
        toast.success('OS atualizada com sucesso!');
      } else {
        await serviceOrdersService.create(payload);
        toast.success('OS criada com sucesso!');
      }
      setShowModal(false);
      void loadData();
    } catch {
      toast.error('Erro ao salvar OS.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (order: ServiceOrder, newStatus: string) => {
    setUpdatingStatus(order.id);
    try {
      await serviceOrdersService.updateStatus(order.id, newStatus);
      toast.success(`Status atualizado para ${OS_STATUS_LABEL[newStatus]}.`);
      void loadData();
    } catch {
      toast.error('Erro ao atualizar status.');
    } finally {
      setUpdatingStatus(null);
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await confirmAction({
      title: 'Excluir ordem de serviço',
      description: 'Tem certeza que deseja excluir esta ordem de serviço? Esta ação não pode ser desfeita.',
      confirmLabel: 'Excluir ordem de serviço',
    });
    if (!confirmed) return;
    await runWithMutationLock(deleteMutationLock, async () => {
      try {
        await serviceOrdersService.delete(id);
        toast.success('OS excluida.');
        void loadData();
      } catch {
        toast.error('Erro ao excluir OS.');
      }
    });
  };

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar ordens de serviço"
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
        eyebrow="Execução formalizada"
        title="Ordens de Serviço (NR-1)"
        description="Documentação obrigatória de atividades, riscos, responsáveis e execução planejada."
        icon={<ClipboardList className="h-5 w-5" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<FileSpreadsheet className="h-4 w-4 text-[var(--ds-color-success)]" />}
              onClick={() => downloadExcel('/service-orders/export/excel', 'ordens-servico.xlsx')}
            >
              Exportar Excel
            </Button>
            <Button type="button" size="sm" leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
              Nova OS
            </Button>
          </div>
        }
        metrics={
          loading && orders.length === 0
            ? []
            : [
          {
            label: 'Total',
            value: total,
            note: 'Ordens disponiveis no recorte filtrado.',
          },
          {
            label: 'Ativas',
            value: summary.ativo,
            note: 'Execucoes em andamento com OS aberta.',
            tone: 'primary',
          },
          {
            label: 'Concluidas',
            value: summary.concluido,
            note: 'Atividades finalizadas e registradas.',
            tone: 'success',
          },
          {
            label: 'Canceladas',
            value: summary.cancelado,
            note: 'Ordens encerradas sem execucao.',
            tone: 'danger',
          },
            ]
        }
        toolbarTitle="Base de ordens de serviço"
        toolbarDescription={`${total} registro(s) no recorte atual com filtros por status e obra.`}
        toolbarContent={
          <div className="grid w-full grid-cols-1 gap-3 md:w-auto md:grid-cols-2">
            <select
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
                setPage(1);
              }}
              className={inputClassName}
            >
              <option value="">Todos os status</option>
              {Object.entries(OS_STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <select
              value={filterSite}
              onChange={(e) => {
                setFilterSite(e.target.value);
                setPage(1);
              }}
              className={inputClassName}
            >
              <option value="">Todas as obras</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.nome}</option>
              ))}
            </select>
          </div>
        }
        footer={
          orders.length > 0 ? (
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
        {loading && orders.length === 0 ? (
          <div className="p-6">
            <InlineLoadingState label="Carregando ordens de servico..." />
          </div>
        ) : orders.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="Nenhuma Ordem de Serviço encontrada"
              description="Ainda não existem ordens de serviço registradas para este tenant."
              action={
                <button
                  type="button"
                  onClick={openCreate}
                  className={cn(buttonVariants(), 'inline-flex items-center')}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Nova OS
                </button>
              }
            />
          </div>
        ) : (
          <ResponsiveDataList
            items={orders}
            getKey={(order) => order.id}
            mobileClassName="space-y-3 p-3"
            mobile={(order) => {
              const allowed = OS_ALLOWED_TRANSITIONS[order.status] ?? [];
              return <article className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-mono text-xs text-[var(--ds-color-text-muted)]">{order.numero}</p><h3 className="mt-1 font-semibold">{order.titulo}</h3></div><StatusPill tone={getOrderStatusTone(order.status)}>{OS_STATUS_LABEL[order.status] ?? order.status}</StatusPill></div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Obra</dt><dd>{order.site?.nome ?? '-'}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Emissão</dt><dd>{safeToLocaleDateString(order.data_emissao, 'pt-BR', undefined, '—')}</dd></div><div className="col-span-2"><dt className="text-xs text-[var(--ds-color-text-muted)]">Responsável</dt><dd>{order.responsavel?.nome ?? '-'}</dd></div></dl>
                <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3">{allowed.length > 0 ? <StatusSelect value="" disabled={updatingStatus === order.id} onChange={(event) => { if (event.target.value) void handleStatusChange(order, event.target.value); }} className="col-span-2 min-h-11 w-full"><option value="">Mover para...</option>{allowed.map((status) => <option key={status} value={status}>{OS_STATUS_LABEL[status]}</option>)}</StatusSelect> : null}<Button type="button" variant="outline" className="min-h-11" onClick={() => openEdit(order)}><Pencil className="mr-2 h-4 w-4" />Editar</Button><Button type="button" variant="outline" className="min-h-11 text-[var(--ds-color-danger)]" onClick={() => handleDelete(order.id)}><Trash2 className="mr-2 h-4 w-4" />Excluir</Button></div>
              </article>;
            }}
            desktop={() => <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Numero</TableHead>
                <TableHead>Titulo</TableHead>
                <TableHead>Obra</TableHead>
                <TableHead>Responsavel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Data Emissao</TableHead>
                <TableHead className="text-right">Acoes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => {
                const allowed = OS_ALLOWED_TRANSITIONS[order.status] ?? [];
                return (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-sm font-medium">{order.numero}</TableCell>
                    <TableCell className="max-w-[200px] truncate font-medium text-[var(--ds-color-text-primary)]">
                      {order.titulo}
                    </TableCell>
                    <TableCell className="text-[var(--ds-color-text-secondary)]">{order.site?.nome ?? '-'}</TableCell>
                    <TableCell className="text-[var(--ds-color-text-secondary)]">{order.responsavel?.nome ?? '-'}</TableCell>
                    <TableCell>
                      {allowed.length > 0 ? (
                        <div className="flex flex-col gap-1.5">
                          <StatusPill tone={getOrderStatusTone(order.status)}>
                            {OS_STATUS_LABEL[order.status] ?? order.status}
                          </StatusPill>
                          <StatusSelect
                            value=""
                            disabled={updatingStatus === order.id}
                            onChange={(e) => {
                              if (e.target.value) {
                                void handleStatusChange(order, e.target.value);
                              }
                            }}
                            className="h-8 min-w-[9rem]"
                          >
                            <option value="">Mover para...</option>
                            {allowed.map((s) => (
                              <option key={s} value={s}>{OS_STATUS_LABEL[s]}</option>
                            ))}
                          </StatusSelect>
                        </div>
                      ) : (
                        <StatusPill tone={getOrderStatusTone(order.status)}>
                          {OS_STATUS_LABEL[order.status] ?? order.status}
                        </StatusPill>
                      )}
                    </TableCell>
                    <TableCell>{safeToLocaleDateString(order.data_emissao, 'pt-BR', undefined, '—')}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => openEdit(order)}
                          title="Editar"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDelete(order.id)}
                          title="Excluir"
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
          </Table>}
          />
        )}
      </ListPageLayout>

      <ModalFrame isOpen={showModal} onClose={closeModal} shellClassName="max-w-2xl">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <ModalHeader
            title={editId ? 'Editar ordem de serviço' : 'Nova ordem de serviço'}
            description="Registre a atividade, os responsáveis e os controles planejados da ordem."
            onClose={closeModal}
          />

          <ModalBody className="max-h-[calc(100dvh-9rem)] space-y-4 overflow-y-auto sm:max-h-[70vh]">
              <div>
                <label htmlFor="service-order-titulo" className={labelClassName}>Titulo *</label>
                <input
                  id="service-order-titulo"
                  type="text"
                  value={form.titulo}
                  onChange={(e) => setForm({ ...form, titulo: e.target.value })}
                  aria-label="Titulo da ordem de servico"
                  className={inputClassName}
                />
              </div>
              <div>
                <label htmlFor="service-order-descricao-atividades" className={labelClassName}>Descricao das Atividades *</label>
                <textarea
                  id="service-order-descricao-atividades"
                  value={form.descricao_atividades}
                  onChange={(e) => setForm({ ...form, descricao_atividades: e.target.value })}
                  aria-label="Descricao das atividades da ordem de servico"
                  rows={4}
                  className={inputClassName}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="service-order-site-id" className={labelClassName}>Obra</label>
                  <select
                    id="service-order-site-id"
                    value={form.site_id}
                    onChange={(e) => setForm({ ...form, site_id: e.target.value })}
                    aria-label="Obra da ordem de servico"
                    className={inputClassName}
                  >
                    <option value="">Selecione...</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>{s.nome}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="service-order-responsavel-id" className={labelClassName}>Responsavel</label>
                  <select
                    id="service-order-responsavel-id"
                    value={form.responsavel_id}
                    onChange={(e) => setForm({ ...form, responsavel_id: e.target.value })}
                    aria-label="Responsavel da ordem de servico"
                    className={inputClassName}
                  >
                    <option value="">Selecione...</option>
                    {users
                      .filter((u) =>
                        isUserVisibleForSite(u, u.company_id || '', form.site_id),
                      )
                      .map((u) => (
                      <option key={u.id} value={u.id}>{u.nome}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label htmlFor="service-order-data-emissao" className={labelClassName}>Data Emissao *</label>
                  <input
                    id="service-order-data-emissao"
                    type="date"
                    value={form.data_emissao}
                    onChange={(e) => setForm({ ...form, data_emissao: e.target.value })}
                    aria-label="Data de emissao"
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label htmlFor="service-order-data-inicio" className={labelClassName}>Data Inicio</label>
                  <input
                    id="service-order-data-inicio"
                    type="date"
                    value={form.data_inicio}
                    onChange={(e) => setForm({ ...form, data_inicio: e.target.value })}
                    aria-label="Data de inicio"
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label htmlFor="service-order-data-fim-previsto" className={labelClassName}>Fim Previsto</label>
                  <input
                    id="service-order-data-fim-previsto"
                    type="date"
                    value={form.data_fim_previsto}
                    onChange={(e) => setForm({ ...form, data_fim_previsto: e.target.value })}
                    aria-label="Data de fim previsto"
                    className={inputClassName}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="service-order-responsabilidades" className={labelClassName}>Responsabilidades</label>
                <textarea
                  id="service-order-responsabilidades"
                  value={form.responsabilidades}
                  onChange={(e) => setForm({ ...form, responsabilidades: e.target.value })}
                  aria-label="Responsabilidades da ordem de servico"
                  rows={2}
                  className={inputClassName}
                />
              </div>
              <div>
                <label className={labelClassName}>
                  Riscos Identificados (JSON)
                  <span className="ml-2 text-xs font-normal text-[var(--ds-color-text-secondary)]">
                    {'Ex: [{"risco":"Queda","medida_controle":"Cinto"}]'}
                  </span>
                </label>
                <textarea
                  aria-label="Riscos identificados em JSON"
                  value={form.riscos_json}
                  onChange={(e) => setForm({ ...form, riscos_json: e.target.value })}
                  rows={3}
                  className={cn(inputClassName, 'font-mono text-xs')}
                />
              </div>
              <div>
                <label className={labelClassName}>
                  EPIs Necessarios (JSON)
                  <span className="ml-2 text-xs font-normal text-[var(--ds-color-text-secondary)]">
                    {'Ex: [{"nome":"Capacete","ca":"12345"}]'}
                  </span>
                </label>
                <textarea
                  aria-label="EPIs necessarios em JSON"
                  value={form.epis_json}
                  onChange={(e) => setForm({ ...form, epis_json: e.target.value })}
                  rows={3}
                  className={cn(inputClassName, 'font-mono text-xs')}
                />
              </div>
          </ModalBody>

          <ModalFooter className="grid grid-cols-2 gap-2 sm:flex">
            <Button type="button" variant="outline" className="min-h-11" onClick={closeModal}>
              Cancelar
            </Button>
            <Button type="submit" loading={saving} className="min-h-11">
              {editId ? 'Salvar' : 'Criar OS'}
            </Button>
          </ModalFooter>
        </form>
      </ModalFrame>
    </>
  );
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}


