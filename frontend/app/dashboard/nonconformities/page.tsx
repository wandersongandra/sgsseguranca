"use client";
import { logger } from "@/lib/logger";

import dynamic from "next/dynamic";
import {
  useEffect,
  useState,
  useCallback,
  useDeferredValue,
} from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Edit,
  FileSpreadsheet,
  Mail,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { downloadExcel } from "@/lib/download-excel";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import {
  nonConformitiesService,
  NonConformity,
  NcStatus,
  NC_ALLOWED_TRANSITIONS,
  NC_STATUS_LABEL,
} from "@/services/nonConformitiesService";
import { correctiveActionsService } from "@/services/correctiveActionsService";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  EmptyState,
  ErrorState,
  InlineLoadingState,
} from "@/components/ui/state";
import { InlineCallout } from "@/components/ui/inline-callout";
import { PaginationControls } from "@/components/PaginationControls";
import { ResponsiveDataList } from "@/components/ui/responsive-data-list";
import { ListPageLayout } from "@/components/layout";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { Permission } from "@/lib/permissions";
import { safeFormatDate } from "@/lib/date/safeFormat";
import {
  StatusPill,
  StatusSelect,
  type StatusTone,
} from "@/components/ui/status-pill";
import {
  assertNonConformityActionAvailable,
  type NonConformityOfflineAction,
} from "@/lib/offline-capabilities";

const SendMailModal = dynamic(
  () =>
    import("@/components/SendMailModal").then((module) => module.SendMailModal),
  { ssr: false },
);
const StoredFilesPanel = dynamic(
  () =>
    import("@/components/StoredFilesPanel").then(
      (module) => module.StoredFilesPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="mt-6 h-40 motion-safe:animate-pulse rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/60" />
    ),
  },
);

const inputClassName =
  "min-h-11 w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]";
function getNcStatusTone(status: NcStatus): StatusTone {
  switch (status) {
    case NcStatus.ABERTA:
      return "danger";
    case NcStatus.EM_ANDAMENTO:
      return "warning";
    case NcStatus.AGUARDANDO_VALIDACAO:
      return "info";
    case NcStatus.ENCERRADA:
      return "success";
    default:
      return "neutral";
  }
}

function ncActionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error &&
    "code" in error &&
    error.code === "ERR_OFFLINE_ACTION_UNAVAILABLE"
    ? error.message
    : fallback;
}

export default function NonConformitiesPage() {
  const { hasPermission } = useAuth();
  const canViewNc = hasPermission(Permission.CAN_VIEW_NC);
  const canManageNc = hasPermission(Permission.CAN_MANAGE_NC);
  const [items, setItems] = useState<NonConformity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [statusFilter, setStatusFilter] = useState<NcStatus | "">("");
  const [siteFilter, setSiteFilter] = useState("");
  const [tipoFilter, setTipoFilter] = useState("");
  const [causaFilter, setCausaFilter] = useState("");
  const [nrFilter, setNrFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [availableSites, setAvailableSites] = useState<{ id: string; nome: string }[]>([]);
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [availableCauses, setAvailableCauses] = useState<string[]>([]);
  const [availableNrs, setAvailableNrs] = useState<string[]>([]);
  const [availableRisks, setAvailableRisks] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const updateOnlineStatus = () => setOnline(navigator.onLine);
    updateOnlineStatus();
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  const requireNcAction = (action: NonConformityOfflineAction): boolean => {
    try {
      assertNonConformityActionAvailable(action, online);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Esta ação exige conexão.");
      return false;
    }
  };

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);
  const [isMailModalOpen, setIsMailModalOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{
    name: string;
    filename: string;
    base64?: string;
    storedDocument?: {
      documentId: string;
      documentType: string;
    };
  } | null>(null);
  const [summary, setSummary] = useState({
    totalNonConformities: 0,
    abertas: 0,
    emAndamento: 0,
    aguardandoValidacao: 0,
    encerradas: 0,
  });

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const pageResult = await nonConformitiesService.findPaginated({
        page,
        limit: 10,
        search: deferredSearchTerm || undefined,
        status: statusFilter || undefined,
        site_id: siteFilter || undefined,
        tipo_categoria: tipoFilter || undefined,
        causa_categoria: causaFilter || undefined,
        requisito_nr_categoria: nrFilter || undefined,
        risco_categoria: riskFilter || undefined,
      });

      setItems(pageResult.data);
      setTotal(pageResult.total);
      setLastPage(pageResult.lastPage);
    } catch (error) {
      logger.error("Erro ao carregar nao conformidades:", error);
      setLoadError("Nao foi possivel carregar a lista de nao conformidades.");
      toast.error("Erro ao carregar nao conformidades");
    } finally {
      setLoading(false);
    }
  }, [
    page,
    deferredSearchTerm,
    statusFilter,
    siteFilter,
    tipoFilter,
    causaFilter,
    nrFilter,
    riskFilter,
  ]);

  const loadSummary = useCallback(async () => {
    try {
      const overview = await nonConformitiesService.getAnalyticsOverview();
      setSummary(overview);
    } catch (error) {
      logger.error("Erro ao carregar resumo de nao conformidades:", error);
    }
  }, []);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const handleDelete = (id: string) => {
    if (!canManageNc) {
      toast.error("Você não tem permissão para excluir não conformidades.");
      return;
    }
    if (!requireNcAction("remove")) return;
    setDeleteTarget(id);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await nonConformitiesService.remove(deleteTarget);
      toast.success("Não conformidade excluída com sucesso");
      if (items.length === 1 && page > 1) {
        void loadSummary();
        setPage((current) => current - 1);
        setDeleteTarget(null);
        return;
      }
      await fetchItems();
      void loadSummary();
    } catch (error) {
      logger.error("Erro ao excluir nao conformidade:", error);
      toast.error(ncActionErrorMessage(error, "Erro ao excluir não conformidade"));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleSendEmail = async (item: NonConformity) => {
    if (!canManageNc) {
      toast.error(
        "Você não tem permissão para enviar esta não conformidade por e-mail.",
      );
      return;
    }
    if (!requireNcAction("email")) return;
    try {
      toast.info("Preparando documento...");
      const pdfAccess = await nonConformitiesService.getPdfAccess(item.id);

      if (pdfAccess.hasFinalPdf) {
        setSelectedDoc({
          name: `NC ${item.codigo_nc}`,
          filename: pdfAccess.originalName ?? `${item.codigo_nc}.pdf`,
          storedDocument: {
            documentId: item.id,
            documentType: "NONCONFORMITY",
          },
        });
        if (pdfAccess.message) {
          toast.warning(
            `${pdfAccess.message} O envio usará o PDF final oficial anexado no backend.`,
          );
        }
        setIsMailModalOpen(true);
        return;
      }

      toast.warning(
        "Emita o PDF final governado antes de enviar esta não conformidade por e-mail.",
      );
    } catch (error) {
      logger.error("Erro ao preparar e-mail:", error);
      toast.error("Erro ao preparar o documento para envio.");
    }
  };

  const handleCreateCapa = async (item: NonConformity) => {
    if (!canManageNc) {
      toast.error(
        "Você não tem permissão para gerar CAPA a partir desta não conformidade.",
      );
      return;
    }
    if (!requireNcAction("capa")) return;
    try {
      await correctiveActionsService.createFromNonConformity(item.id);
      toast.success("CAPA criada a partir da nao conformidade.");
    } catch (error) {
      logger.error("Erro ao criar CAPA:", error);
      toast.error(ncActionErrorMessage(error, "Nao foi possivel criar CAPA."));
    }
  };

  const handleStatusChange = async (id: string, newStatus: NcStatus) => {
    if (!canManageNc) {
      toast.error(
        "Você não tem permissão para alterar o status da não conformidade.",
      );
      return;
    }
    if (!requireNcAction("update-status")) return;
    try {
      const updated = await nonConformitiesService.updateStatus(id, newStatus);
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: updated.status } : item,
        ),
      );
      toast.success(`Status atualizado para "${NC_STATUS_LABEL[newStatus]}"`);
      void loadSummary();
    } catch (error) {
      logger.error("Erro ao atualizar status da nao conformidade:", error);
      toast.error(
        ncActionErrorMessage(error, "Erro ao atualizar status da nao conformidade"),
      );
    }
  };

  if (!canViewNc && !canManageNc) {
    return (
      <ErrorState
        title="Acesso restrito"
        description="Você não possui permissão para visualizar não conformidades."
      />
    );
  }

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar nao conformidades"
        description={loadError}
        action={
          <Button type="button" onClick={fetchItems}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ListPageLayout
        eyebrow="Desvios e tratativas"
        title="Nao Conformidades"
        description="Registre, acompanhe e encerre desvios operacionais com trilha documental e acao corretiva."
        icon={<AlertTriangle className="h-5 w-5" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManageNc ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  leftIcon={
                    <FileSpreadsheet className="h-4 w-4 text-[var(--ds-color-success)]" />
                  }
                  onClick={() => {
                    if (!requireNcAction("export")) return;
                    void downloadExcel(
                      "/nonconformities/export/excel",
                      "nao-conformidades.xlsx",
                    );
                  }}
                >
                  Exportar Excel
                </Button>
                <Link
                  href="/dashboard/nonconformities/new"
                  className={cn(
                    buttonVariants({ size: "sm" }),
                    "inline-flex items-center",
                  )}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Nova nao conformidade
                </Link>
              </>
            ) : null}
          </div>
        }
        metrics={
          loading && items.length === 0
            ? []
            : [
          {
            label: "Total monitorado",
            value: summary.totalNonConformities,
            note: "Nao conformidades monitoradas no tenant atual.",
          },
          {
            label: "Abertas",
            value: summary.abertas,
            note: "Desvios ainda sem tratativa concluida.",
            tone: "danger",
          },
          {
            label: "Em andamento",
            value: summary.emAndamento + summary.aguardandoValidacao,
            note: "Itens em execucao ou aguardando validacao.",
            tone: "warning",
          },
          {
            label: "Encerradas",
            value: summary.encerradas,
            note: "Desvios finalizados no recorte atual.",
            tone: "success",
          },
            ]
        }
        toolbarTitle="Não conformidades"
        toolbarDescription={`${total} registro(s) encontrados com busca por código, local, tipo e status.`}
        toolbarContent={
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <div className="ds-list-search ds-list-search--wide md:col-span-2 xl:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
              <input
                type="text"
                placeholder="Buscar por código, local, tipo ou status..."
                className={cn(inputClassName, "pl-10")}
                value={searchTerm}
                onChange={(event) => {
                  setSearchTerm(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <select
              value={statusFilter}
              aria-label="Filtrar por status"
              onChange={(event) => {
                setStatusFilter(event.target.value as NcStatus | "");
                setPage(1);
              }}
              className={cn(inputClassName, "min-w-[11rem]")}
            >
              <option value="">Todos os status</option>
              <option value={NcStatus.ABERTA}>{NC_STATUS_LABEL[NcStatus.ABERTA]}</option>
              <option value={NcStatus.EM_ANDAMENTO}>{NC_STATUS_LABEL[NcStatus.EM_ANDAMENTO]}</option>
              <option value={NcStatus.AGUARDANDO_VALIDACAO}>{NC_STATUS_LABEL[NcStatus.AGUARDANDO_VALIDACAO]}</option>
              <option value={NcStatus.ENCERRADA}>{NC_STATUS_LABEL[NcStatus.ENCERRADA]}</option>
            </select>
            <select value={siteFilter} onChange={(event) => { setSiteFilter(event.target.value); setPage(1); }} className={inputClassName} aria-label="Filtrar por obra/site">
              <option value="">Todas as obras</option>
              {availableSites.map((site) => <option key={site.id} value={site.id}>{site.nome}</option>)}
            </select>
            <select value={tipoFilter} onChange={(event) => { setTipoFilter(event.target.value); setPage(1); }} className={inputClassName} aria-label="Filtrar por tipo">
              <option value="">Todos os tipos</option>
              {availableTypes.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
            </select>
            <select value={causaFilter} onChange={(event) => { setCausaFilter(event.target.value); setPage(1); }} className={inputClassName} aria-label="Filtrar por causa">
              <option value="">Todas as causas</option>
              {availableCauses.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
            </select>
            <select value={nrFilter} onChange={(event) => { setNrFilter(event.target.value); setPage(1); }} className={inputClassName} aria-label="Filtrar por NR">
              <option value="">Todas as NRs</option>
              {availableNrs.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
            </select>
            <select value={riskFilter} onChange={(event) => { setRiskFilter(event.target.value); setPage(1); }} className={inputClassName} aria-label="Filtrar por risco">
              <option value="">Todos os riscos</option>
              {availableRisks.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
            </select>
            <button
              type="button"
              onClick={() => {
                setSearchTerm("");
                setStatusFilter("");
                setSiteFilter("");
                setTipoFilter("");
                setCausaFilter("");
                setNrFilter("");
                setRiskFilter("");
                setPage(1);
              }}
              className={cn(inputClassName, "font-semibold text-[var(--ds-color-text-secondary)]")}
            >
              Limpar filtros
            </button>
          </div>
        }
        footer={
          !loading && total > 0 ? (
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
        <div className="space-y-4">
          {!online ? (
            <InlineCallout
              tone="warning"
              icon={<AlertTriangle className="h-4 w-4" />}
              title="NC offline: suporte parcial"
              description="Criar e editar continuam disponíveis e entram na fila de sincronização. Alterar status, excluir, gerar CAPA, enviar e-mail e exportar exigem conexão e não entram na fila."
            />
          ) : null}
        {loading && items.length === 0 ? (
          <div className="p-6">
            <InlineLoadingState label="Carregando nao conformidades..." />
          </div>
        ) : summary.abertas > 0 ||
          summary.emAndamento > 0 ||
          summary.aguardandoValidacao > 0 ? (
          <InlineCallout
              tone="danger"
              icon={<ShieldAlert className="h-4 w-4" />}
              title="Atencao de tratativa"
              description={`Existem ${summary.abertas + summary.emAndamento + summary.aguardandoValidacao} nao conformidade(s) ainda sem encerramento no tenant atual. Priorize CAPA e validacao para reduzir reincidencia.`}
            />
          ) : null}

          {items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="Nenhuma nao conformidade encontrada"
                description={
                  deferredSearchTerm
                    ? "Nenhum resultado corresponde ao filtro aplicado."
                    : "Ainda nao existem registros de nao conformidade para este tenant."
                }
                action={
                  !deferredSearchTerm && canManageNc ? (
                    <Link
                      href="/dashboard/nonconformities/new"
                      className={cn(
                        buttonVariants(),
                        "inline-flex items-center",
                      )}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Nova nao conformidade
                    </Link>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <ResponsiveDataList
              items={items}
              getKey={(item) => item.id}
              mobileClassName="space-y-3 p-3"
              mobile={(item) => (
                <article className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{item.codigo_nc}</h3><p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">{item.tipo}</p></div><StatusPill tone={getNcStatusTone(item.status as NcStatus)}>{NC_STATUS_LABEL[item.status as NcStatus] ?? item.status}</StatusPill></div>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Local / setor</dt><dd>{item.local_setor_area}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Data</dt><dd>{safeFormatDate(item.data_identificacao, "dd/MM/yyyy", { locale: ptBR })}</dd></div><div className="col-span-2"><dt className="text-xs text-[var(--ds-color-text-muted)]">Responsável</dt><dd>{item.responsavel_area}</dd></div></dl>
                  {canManageNc ? <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3">
                    {NC_ALLOWED_TRANSITIONS[item.status as NcStatus]?.length > 0 ? <StatusSelect title="Mover status" className="col-span-2 min-h-11 w-full" value="" onChange={(event) => { if (event.target.value) void handleStatusChange(item.id, event.target.value as NcStatus); }}><option value="">Mover status...</option>{NC_ALLOWED_TRANSITIONS[item.status as NcStatus].map((status) => <option key={status} value={status}>{NC_STATUS_LABEL[status]}</option>)}</StatusSelect> : null}
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => handleCreateCapa(item)}><Plus className="mr-2 h-4 w-4" />CAPA</Button><Button type="button" variant="outline" className="min-h-11" onClick={() => handleSendEmail(item)}><Mail className="mr-2 h-4 w-4" />E-mail</Button>
                    <Link href={`/dashboard/nonconformities/edit/${item.id}`} className={cn(buttonVariants({ variant: "outline" }), "min-h-11 justify-center")}><Edit className="mr-2 h-4 w-4" />Editar</Link><Button type="button" variant="outline" className="min-h-11 text-[var(--ds-color-danger)]" onClick={() => handleDelete(item.id)}><Trash2 className="mr-2 h-4 w-4" />Excluir</Button>
                  </div> : <p className="mt-3 border-t pt-3 text-xs text-[var(--ds-color-text-muted)]">Somente leitura</p>}
                </article>
              )}
              desktop={() => <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Codigo</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Local / Setor</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Responsavel</TableHead>
                  <TableHead className="text-right">Acoes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                      {item.codigo_nc}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone="neutral">{item.tipo}</StatusPill>
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={getNcStatusTone(item.status as NcStatus)}>
                        {NC_STATUS_LABEL[item.status as NcStatus] ?? item.status}
                      </StatusPill>
                    </TableCell>
                    <TableCell>{item.local_setor_area}</TableCell>
                    <TableCell>
                      {safeFormatDate(item.data_identificacao, "dd/MM/yyyy", {
                        locale: ptBR,
                      })}
                    </TableCell>
                    <TableCell>{item.responsavel_area}</TableCell>
                    <TableCell className="text-right">
                      {canManageNc ? (
                        <div className="flex items-center justify-end gap-1">
                          {NC_ALLOWED_TRANSITIONS[item.status as NcStatus]?.length > 0 ? (
                            <StatusSelect
                              title="Mover status"
                              className="h-8 min-w-[9rem]"
                              value=""
                              onChange={(event) => {
                                if (event.target.value) {
                                  void handleStatusChange(
                                    item.id,
                                    event.target.value as NcStatus,
                                  );
                                }
                              }}
                            >
                              <option value="">Mover...</option>
                              {NC_ALLOWED_TRANSITIONS[item.status as NcStatus].map((s) => (
                                <option key={s} value={s}>{NC_STATUS_LABEL[s]}</option>
                              ))}
                            </StatusSelect>
                          ) : null}
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleCreateCapa(item)}
                            title="Gerar CAPA"
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleSendEmail(item)}
                            title="Enviar por e-mail"
                          >
                            <Mail className="h-4 w-4" />
                          </Button>
                          <Link
                            href={`/dashboard/nonconformities/edit/${item.id}`}
                            className={buttonVariants({
                              size: "icon",
                              variant: "ghost",
                            })}
                            title="Editar"
                          >
                            <Edit className="h-4 w-4" />
                          </Link>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleDelete(item.id)}
                            title="Excluir"
                            className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-[var(--ds-color-text-muted)]">
                          Somente leitura
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>}
            />
          )}
        </div>
      </ListPageLayout>

      <StoredFilesPanel
        title="Arquivos Nao Conformidade (Storage)"
        description="PDFs salvos automaticamente por empresa, ano e semana."
        listStoredFiles={nonConformitiesService.listStoredFiles}
        getPdfAccess={nonConformitiesService.getPdfAccess}
        downloadWeeklyBundle={nonConformitiesService.downloadWeeklyBundle}
        companyOptions={[]}
      />

      {selectedDoc ? (
        <SendMailModal
          isOpen={isMailModalOpen}
          onClose={() => {
            setIsMailModalOpen(false);
            setSelectedDoc(null);
          }}
          documentName={selectedDoc.name}
          filename={selectedDoc.filename}
          base64={selectedDoc.base64}
          storedDocument={selectedDoc.storedDocument}
        />
      ) : null}

      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleConfirmDelete()}
        loading={deleting}
        title="Excluir não conformidade"
        description="Tem certeza que deseja excluir esta não conformidade? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        danger
      />
    </>
  );
}
