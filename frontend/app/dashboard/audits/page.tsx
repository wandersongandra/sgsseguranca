"use client";
import { logger } from "@/lib/logger";

import dynamic from "next/dynamic";
import {
  useState,
  useEffect,
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
} from "react";
import { auditsService, Audit } from "@/services/auditsService";
import {
  AlertTriangle,
  ClipboardCheck,
  Download,
  Edit,
  Mail,
  Plus,
  Printer,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { PaginationControls } from "@/components/PaginationControls";
import Link from "next/link";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { base64ToPdfBlob, base64ToPdfFile } from "@/lib/pdf/pdfFile";
import { buildPdfFilename } from "@/lib/pdf-system/core/format";
import { correctiveActionsService } from "@/services/correctiveActionsService";
import { companiesService } from "@/services/companiesService";
import { openPdfForPrint, openUrlInNewTab } from "@/lib/print-utils";
import { selectedTenantStore } from "@/lib/selectedTenantStore";
import { runWithMutationLock } from "@/lib/mutation-lock";
import { useConfirmAction } from "@/components/ui/confirm-action-provider";
import { sessionStore } from "@/lib/sessionStore";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  EmptyState,
  ErrorState,
  InlineLoadingState,
} from "@/components/ui/state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { safeFormatDate } from "@/lib/date/safeFormat";
import { ResponsiveDataList } from "@/components/ui/responsive-data-list";
import {
  CatalogMobileCard,
  catalogMobileActionClassName,
} from "../components/CatalogMobileCard";

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
  "w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]";

const loadAuditPdfGenerator = async () => import("@/lib/pdf/auditGenerator");
const revokeObjectUrlLater = (objectUrl: string) => {
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  return objectUrl;
};

export default function AuditsPage() {
  const { confirmAction } = useConfirmAction();
  const [audits, setAudits] = useState<Audit[]>([]);
const timerRef = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [companyOptions, setCompanyOptions] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(() =>
    selectedTenantStore.get()?.companyId || sessionStore.get()?.companyId || null,
  );
  const deleteMutationLock = useRef(false);

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
  const generatedPdfCacheRef = useRef<
    Map<
      string,
      {
        filename: string;
        base64: string;
      }
    >
  >(new Map());

  useEffect(() => {

    const timer = timerRef.current;


    return () => {

      if (timer) {

        clearTimeout(timer);

      }

    };

  }, []);

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

  const buildAuditFilename = (audit: Audit) =>
    buildPdfFilename(
      "AUDITORIA",
      audit.titulo || "auditoria",
      audit.data_auditoria,
    );

  const getGovernedPdfAccess = async (auditId: string) =>
    auditsService.getPdfAccess(auditId, activeCompanyId || undefined);

  const getCachedGeneratedPdf = (auditId: string) =>
    generatedPdfCacheRef.current.get(auditId);

  const setCachedGeneratedPdf = (
    auditId: string,
    payload: {
      filename: string;
      base64: string;
    },
  ) => {
    generatedPdfCacheRef.current.set(auditId, payload);
    return payload;
  };

  const generateAuditPdfPayload = async (audit: Audit) => {
    const cached = getCachedGeneratedPdf(audit.id);
    if (cached) {
      return cached;
    }

    const fullAudit = await auditsService.findOne(
      audit.id,
      activeCompanyId || undefined,
    );
    const { generateAuditPdf } = await loadAuditPdfGenerator();
    const result = (await generateAuditPdf(fullAudit, {
      save: false,
      output: "base64",
      draftWatermark: false,
    })) as { filename: string; base64: string } | undefined;

    if (!result?.base64) {
      throw new Error("Falha ao gerar o PDF oficial da auditoria.");
    }

    return setCachedGeneratedPdf(audit.id, {
      filename: result.filename || buildAuditFilename(fullAudit),
      base64: result.base64,
    });
  };

  const ensureGovernedPdf = async (
    audit: Audit,
    options?: { needLocalPayload?: boolean },
  ) => {
    let access = await getGovernedPdfAccess(audit.id);
    let payload = getCachedGeneratedPdf(audit.id);

    if (!access.hasFinalPdf) {
      payload = payload || (await generateAuditPdfPayload(audit));
      const file = base64ToPdfFile(payload.base64, payload.filename);
      await auditsService.attachFile(
        audit.id,
        file,
        activeCompanyId || undefined,
      );
      await fetchAudits();
      toast.success("PDF final da auditoria emitido e registrado com sucesso.");
      access = await auditsService.getPdfAccess(
        audit.id,
        activeCompanyId || undefined,
      );
    }

    if (options?.needLocalPayload && !payload) {
      payload = await generateAuditPdfPayload(audit);
    }

    return { access, payload };
  };

  const fetchAudits = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      if (!activeCompanyId) {
        setAudits([]);
        setTotal(0);
        setLastPage(1);
        return;
      }
      const response = await auditsService.findPaginated({
        page,
        search: deferredSearchTerm || undefined,
        companyId: activeCompanyId,
      });
      setAudits(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      logger.error("Erro ao carregar auditorias:", error);
      setLoadError("Nao foi possivel carregar os relatorios de auditoria.");
      toast.error("Erro ao carregar auditorias");
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, deferredSearchTerm, page]);

  useEffect(() => {
    setPage(1);
  }, [deferredSearchTerm]);

  useEffect(() => {
    fetchAudits();
  }, [fetchAudits]);

  useEffect(() => {
    let cancelled = false;

    const fetchCompanies = async () => {
      try {
        const companies = await companiesService.findAll();
        if (cancelled) {
          return;
        }
        setCompanyOptions(
          companies.map((company) => ({
            id: company.id,
            name: company.razao_social,
          })),
        );
      } catch (error) {
        logger.error("Erro ao carregar empresas para arquivos salvos:", error);
      }
    };

    void fetchCompanies();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDelete = async (id: string) => {
    const confirmed = await confirmAction({
      title: "Excluir auditoria",
      description: "Tem certeza que deseja excluir esta auditoria? Esta ação não pode ser desfeita.",
      confirmLabel: "Excluir auditoria",
    });
    if (!confirmed) {
      return;
    }

    await runWithMutationLock(deleteMutationLock, async () => {
      try {
        await auditsService.delete(id, activeCompanyId || undefined);
        toast.success("Auditoria excluida com sucesso");
        await fetchAudits();
      } catch (error) {
        logger.error("Erro ao excluir auditoria:", error);
        toast.error("Erro ao excluir auditoria");
      }
    });
  };

  const handleDownloadPdf = async (audit: Audit) => {
    const toastId = `audit-download-${audit.id}`;
    try {
      toast.loading("Preparando download do PDF...", { id: toastId });
      const { access, payload } = await ensureGovernedPdf(audit, {
        needLocalPayload: true,
      });
      if (access.url) {
        openUrlInNewTab(access.url);
        toast.success("PDF final aberto para download.", { id: toastId });
        return;
      }

      if (!payload?.base64) {
        throw new Error("Falha ao preparar o PDF oficial da auditoria.");
      }

      const fileUrl = revokeObjectUrlLater(
        URL.createObjectURL(base64ToPdfBlob(payload.base64)),
      );
      openUrlInNewTab(fileUrl);
      toast.warning(
        access.message ||
          "PDF final emitido, mas a URL segura não está disponível no momento. Abrimos a cópia oficial local.",
        { id: toastId },
      );
    } catch (error) {
      logger.error("Erro ao gerar PDF:", error);
      toast.error("Erro ao gerar PDF da auditoria.", { id: toastId });
    }
  };

  const handlePrint = async (audit: Audit) => {
    const toastId = `audit-print-${audit.id}`;
    try {
      toast.loading("Preparando impressao...", { id: toastId });
      const { access, payload } = await ensureGovernedPdf(audit, {
        needLocalPayload: true,
      });
      if (access.url) {
        openPdfForPrint(access.url, () => {
          toast.info(
            "Pop-up bloqueado. Abrimos o PDF final na mesma aba para impressao.",
          );
        });
        toast.success("PDF final pronto para impressao.", { id: toastId });
        return;
      }

      if (!payload?.base64) {
        throw new Error("Falha ao preparar o PDF oficial da auditoria.");
      }

      const fileURL = revokeObjectUrlLater(
        URL.createObjectURL(base64ToPdfBlob(payload.base64)),
      );
      openPdfForPrint(fileURL, () => {
        toast.info(
          "Pop-up bloqueado. Abrimos o PDF na mesma aba para impressao.",
        );
      });
      toast.warning(
        access.message ||
          "PDF final emitido, mas a URL segura não está disponível no momento. Abrimos a cópia oficial local.",
        { id: toastId },
      );
    } catch (error) {
      logger.error("Erro ao imprimir:", error);
      toast.error("Erro ao preparar impressao da auditoria.", { id: toastId });
    }
  };

  const handleSendEmail = async (audit: Audit) => {
    const toastId = `audit-mail-${audit.id}`;
    try {
      toast.loading("Preparando documento para envio...", { id: toastId });
      const { access, payload } = await ensureGovernedPdf(audit, {
        needLocalPayload: true,
      });
      if (access.hasFinalPdf) {
        if (access.availability !== "ready" && access.message) {
          toast.info(
            `${access.message} O envio oficial continuará usando o PDF final governado da auditoria.`,
          );
        }
        setSelectedDoc({
          name: audit.titulo,
          filename: access.originalName || buildAuditFilename(audit),
          storedDocument: {
            documentId: audit.id,
            documentType: "AUDIT",
          },
        });
        setIsMailModalOpen(true);
        toast.success("Documento pronto para envio.", { id: toastId });
        return;
      }

      if (payload?.base64) {
        setSelectedDoc({
          name: audit.titulo,
          filename: payload.filename,
          base64: payload.base64,
        });
        setIsMailModalOpen(true);
        toast.success("Documento pronto para envio.", { id: toastId });
      }
    } catch (error) {
      logger.error("Erro ao preparar e-mail:", error);
      toast.error("Erro ao preparar o documento para envio.", {
        id: toastId,
      });
    }
  };

  const handleOpenGovernedPdf = async (audit: Audit) => {
    try {
      toast.info(
        audit.pdf_file_key
          ? "Abrindo PDF final governado..."
          : "Emitindo PDF final governado...",
      );
      const { access, payload } = await ensureGovernedPdf(audit, {
        needLocalPayload: true,
      });
      if (!access.url) {
        if (payload?.base64) {
          openUrlInNewTab(
            revokeObjectUrlLater(URL.createObjectURL(base64ToPdfBlob(payload.base64))),
          );
        }
        toast.warning(
          access.message ||
            "PDF final emitido, mas a URL segura não está disponível no momento.",
        );
        return;
      }
      openUrlInNewTab(access.url);
    } catch (error) {
      logger.error("Erro ao emitir/abrir PDF final da auditoria:", error);
      toast.error("Nao foi possivel emitir ou abrir o PDF final da auditoria.");
    }
  };

  const handleCreateCapa = async (audit: Audit) => {
    try {
      await correctiveActionsService.createFromAudit(audit.id);
      toast.success("CAPA criada a partir da auditoria");
    } catch (error) {
      logger.error("Erro ao criar CAPA da auditoria:", error);
      toast.error("Nao foi possivel criar CAPA.");
    }
  };

  const summary = useMemo(() => {
    const typeCount = new Set(
      audits.map((item) => item.tipo_auditoria).filter(Boolean),
    ).size;
    const siteCount = new Set(
      audits.map((item) => item.site?.id).filter(Boolean),
    ).size;
    const nonConformityCount = audits.reduce(
      (totalItems, item) =>
        totalItems + (item.resultados_nao_conformidades?.length || 0),
      0,
    );
    const withActionPlan = audits.filter(
      (item) => (item.plano_acao?.length || 0) > 0,
    ).length;

    return {
      total,
      tipos: typeCount,
      sites: siteCount,
      naoConformidades: nonConformityCount,
      comPlano: withActionPlan,
    };
  }, [audits, total]);

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar auditorias"
        description={loadError}
        action={
          <Button type="button" onClick={fetchAudits}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card tone="elevated" padding="lg">
        <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-lg)] bg-[color:var(--ds-color-action-primary)]/12 text-[var(--ds-color-action-primary)]">
              <ClipboardCheck className="h-5 w-5" />
            </div>
            <div className="space-y-2">
              <CardTitle className="text-2xl">Auditorias HSE</CardTitle>
              <CardDescription>
                Gerencie relatorios de auditoria, conformidades, CAPAs e
                evidencias por unidade.
              </CardDescription>
            </div>
          </div>
          <Link
            href="/dashboard/audits/new"
            className={cn(buttonVariants(), "inline-flex items-center")}
          >
            <Plus className="mr-2 h-4 w-4" />
            Novo relatorio
          </Link>
        </CardHeader>
      </Card>

      {loading && audits.length === 0 ? (
        <InlineLoadingState label="Carregando auditorias..." />
      ) : null}

      {!loading || audits.length > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card interactive padding="md">
              <CardHeader>
                <CardDescription>Total de auditorias</CardDescription>
                <CardTitle className="text-3xl">{summary.total}</CardTitle>
              </CardHeader>
            </Card>
            <Card interactive padding="md">
              <CardHeader>
                <CardDescription>Tipos presentes</CardDescription>
                <CardTitle className="text-3xl text-[var(--ds-color-action-primary)]">
                  {summary.tipos}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card interactive padding="md">
              <CardHeader>
                <CardDescription>Auditorias com plano de acao</CardDescription>
                <CardTitle className="text-3xl text-[var(--ds-color-warning)]">
                  {summary.comPlano}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card interactive padding="md">
              <CardHeader>
                <CardDescription>Sites no recorte</CardDescription>
                <CardTitle className="text-3xl text-[var(--ds-color-success)]">
                  {summary.sites}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          {summary.naoConformidades > 0 ? (
            <Card
              tone="muted"
              padding="md"
              className="border-[color:var(--ds-color-warning)]/25 bg-[color:var(--ds-color-warning)]/10"
            >
              <CardHeader className="gap-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-[var(--ds-color-warning)]" />
                  <CardTitle className="text-base">Atencao operacional</CardTitle>
                </div>
                <CardDescription>
                  Esta pagina concentra {summary.naoConformidades} nao
                  conformidade(s) registradas. Priorize CAPAs e acompanhe os
                  auditores responsaveis.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <Card
              tone="muted"
              padding="md"
              className="border-[color:var(--ds-color-success)]/20 bg-[color:var(--ds-color-success)]/10"
            >
              <CardHeader className="gap-2">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-[var(--ds-color-success)]" />
                  <CardTitle className="text-base">
                    Base sem nao conformidades na pagina
                  </CardTitle>
                </div>
                <CardDescription>
                  Nenhuma nao conformidade foi identificada no recorte atual
                  desta listagem.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </>
      ) : null}

      <Card tone="default" padding="none">
        <CardHeader className="gap-4 border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/18 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <CardTitle>Base de auditorias</CardTitle>
            <CardDescription>
              {total} relatorio(s) encontrados com busca por titulo ou tipo de
              auditoria.
            </CardDescription>
          </div>
          <div className="relative w-full md:w-[360px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
            <input
              type="text"
              placeholder="Buscar por titulo ou tipo"
              aria-label="Buscar auditorias por título ou tipo"
              className={cn(inputClassName, "pl-10")}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
        </CardHeader>

        <CardContent className="mt-0">
          {loading && audits.length === 0 ? (
            <div className="py-6">
              <InlineLoadingState label="Carregando base de auditorias..." />
            </div>
          ) : audits.length === 0 ? (
            <EmptyState
              title="Nenhuma auditoria encontrada"
              description={
                deferredSearchTerm
                  ? "Nenhum resultado corresponde ao filtro aplicado."
                  : "Ainda nao existem auditorias registradas para este tenant."
              }
              action={
                !deferredSearchTerm ? (
                  <Link
                    href="/dashboard/audits/new"
                    className={cn(buttonVariants(), "inline-flex items-center")}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Novo relatorio
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <>
              <ResponsiveDataList
                items={audits}
                getKey={(audit) => audit.id}
                mobileClassName="grid min-w-0 gap-3 py-3"
                desktop={() => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Titulo / Tipo</TableHead>
                    <TableHead>Site / Unidade</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead>Auditor</TableHead>
                    <TableHead className="text-right">Acoes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audits.map((audit) => (
                    <TableRow key={audit.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--ds-radius-md)] bg-[color:var(--ds-color-action-primary)]/10 text-[var(--ds-color-action-primary)]">
                            <ClipboardCheck className="h-4 w-4" />
                          </div>
                          <div className="space-y-1">
                            <p className="font-medium text-[var(--ds-color-text-primary)]">
                              {audit.titulo}
                            </p>
                            <span className="inline-flex rounded-full bg-[color:var(--ds-color-action-primary)]/12 px-2.5 py-1 text-xs font-semibold text-[var(--ds-color-action-primary)]">
                              {audit.tipo_auditoria}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {audit.site?.nome || "—"}
                      </TableCell>
                      <TableCell>
                        {safeFormatDate(audit.data_auditoria, "dd/MM/yyyy", {
                          locale: ptBR,
                        })}
                      </TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {audit.auditor?.nome || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleCreateCapa(audit)}
                            title="Gerar CAPA"
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleOpenGovernedPdf(audit)}
                            title={
                              audit.pdf_file_key
                                ? "Abrir PDF final governado"
                                : "Emitir PDF final governado"
                            }
                          >
                            <ShieldCheck className="h-4 w-4 text-[var(--ds-color-success)]" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handlePrint(audit)}
                            title="Imprimir"
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleSendEmail(audit)}
                            title="Enviar por e-mail"
                          >
                            <Mail className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleDownloadPdf(audit)}
                            title="Baixar PDF"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Link
                            href={`/dashboard/audits/edit/${audit.id}`}
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
                            onClick={() => handleDelete(audit.id)}
                            title="Excluir"
                            className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
                )}
                mobile={(audit) => (
                  <CatalogMobileCard
                    title={audit.titulo}
                    description={audit.tipo_auditoria}
                    fields={[
                      { label: "Site / Unidade", value: audit.site?.nome || "—" },
                      { label: "Data", value: safeFormatDate(audit.data_auditoria, "dd/MM/yyyy", { locale: ptBR }) },
                      { label: "Auditor", value: audit.auditor?.nome || "—" },
                    ]}
                    actionsLabel={`Ações da auditoria ${audit.titulo}`}
                    actions={
                      <>
                        <Button type="button" size="sm" variant="outline" onClick={() => handleCreateCapa(audit)} className={cn(catalogMobileActionClassName, "min-h-11")}>
                          <Plus className="h-4 w-4" /> Gerar CAPA
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => handleOpenGovernedPdf(audit)} className={cn(catalogMobileActionClassName, "min-h-11")}>
                          <ShieldCheck className="h-4 w-4 text-[var(--ds-color-success)]" /> {audit.pdf_file_key ? "Abrir PDF final" : "Emitir PDF final"}
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => handlePrint(audit)} className={cn(catalogMobileActionClassName, "min-h-11")}>
                          <Printer className="h-4 w-4" /> Imprimir
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => handleSendEmail(audit)} className={cn(catalogMobileActionClassName, "min-h-11")}>
                          <Mail className="h-4 w-4" /> Enviar
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => handleDownloadPdf(audit)} className={cn(catalogMobileActionClassName, "min-h-11")}>
                          <Download className="h-4 w-4" /> Baixar
                        </Button>
                        <Link href={`/dashboard/audits/edit/${audit.id}`} className={cn(buttonVariants({ size: "sm", variant: "outline" }), catalogMobileActionClassName, "min-h-11")}>
                          <Edit className="h-4 w-4" /> Editar
                        </Link>
                        <Button type="button" size="sm" variant="outline" onClick={() => handleDelete(audit.id)} className={cn(catalogMobileActionClassName, "min-h-11 text-[var(--ds-color-danger)]")}>
                          <Trash2 className="h-4 w-4" /> Excluir
                        </Button>
                      </>
                    }
                  />
                )}
              />

              <PaginationControls
                page={page}
                lastPage={lastPage}
                total={total}
                onPrev={handlePrevPage}
                onNext={handleNextPage}
              />
            </>
          )}
        </CardContent>
      </Card>

      <StoredFilesPanel
        title="Arquivos Auditoria (Storage)"
        description="PDFs salvos automaticamente por empresa/ano/semana."
        listStoredFiles={auditsService.listStoredFiles}
        getPdfAccess={auditsService.getPdfAccess}
        downloadWeeklyBundle={auditsService.downloadWeeklyBundle}
        companyOptions={companyOptions}
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
    </div>
  );
}
