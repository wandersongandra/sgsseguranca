"use client";

import dynamic from "next/dynamic";
import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Plus } from "lucide-react";
import { downloadExcel } from "@/lib/download-excel";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAprs } from "./hooks/useAprs";
import { AprAdvancedFiltersDrawer } from "./components/AprAdvancedFiltersDrawer";
import { AprActionModal } from "./components/AprActionModal";
import { AprCard } from "./components/AprCard";
import { AprListingPagination } from "./components/AprListingPagination";
import { AprListingTable } from "./components/AprListingTable";
import { AprListingToolbar } from "./components/AprListingToolbar";
import {
  AprDueFilter,
  AprListingDensity,
  AprListingRecord,
  AprSortOption,
  getAprResponsibleMeta,
} from "./components/aprListingUtils";
import { aprsService } from "@/services/aprsService";
import { signaturesService } from "@/services/signaturesService";
import { useAuth } from "@/context/AuthContext";
import { Permission } from '@/lib/permissions';
import { Button, buttonVariants } from "@/components/ui/button";
import {
  EmptyState,
  ErrorState,
  InlineLoadingState,
} from "@/components/ui/state";
import { ListPageLayout } from "@/components/layout";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const SendMailModal = dynamic(
  () =>
    import("@/components/SendMailModal").then((module) => module.SendMailModal),
  { ssr: false },
);
const SignatureModal = dynamic(
  () =>
    import("@/components/SignatureModal").then((module) => module.SignatureModal),
  { ssr: false },
);
const SignaturesPanel = dynamic(
  () =>
    import("@/components/SignaturesPanel").then((module) => module.SignaturesPanel),
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

export default function AprsPage() {
  const { user, hasPermission } = useAuth();
  const canCreate = hasPermission(Permission.CAN_CREATE_APR);
  const [signatureTarget, setSignatureTarget] = useState<AprListingRecord | null>(null);
  const [signaturesTarget, setSignaturesTarget] = useState<AprListingRecord | null>(null);

  const handleSignSave = useCallback(
    async (signatureData: string, type: string) => {
      if (!signatureTarget) return;

      try {
        await signaturesService.create({
          document_id: signatureTarget.id,
          document_type: "APR",
          signature_data: signatureData,
          type,
          user_id: user?.id,
          company_id: signatureTarget.company_id,
        });
        toast.success("Assinatura registrada com sucesso.");
        setSignatureTarget(null);
      } catch {
        toast.error("Erro ao registrar assinatura.");
      }
    },
    [signatureTarget, user?.id],
  );
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialListingState = useMemo(() => {
    const getSort = (): AprSortOption => {
      const value = searchParams.get("sort");
      return value === "updated-desc" ||
        value === "deadline-asc" ||
        value === "title-asc" ||
        value === "priority"
        ? value
        : "priority";
    };

    const getDueFilter = (): AprDueFilter => {
      const value = searchParams.get("due");
      return value === "today" ||
        value === "next-7-days" ||
        value === "expired" ||
        value === "upcoming" ||
        value === "no-deadline"
        ? value
        : "";
    };

    const parsedPage = Number(searchParams.get("page") || "1");

    return {
      initialSearchTerm: searchParams.get("q") || "",
      initialStatusFilter: searchParams.get("status") || "",
      initialSiteFilter: searchParams.get("site") || "",
      initialResponsibleFilter: searchParams.get("responsible") || "",
      initialDueFilter: getDueFilter(),
      initialSortBy: getSort(),
      initialPage: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    };
  }, [searchParams]);
  const {
    loading,
    refetching,
    loadError,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    siteFilter,
    setSiteFilter,
    responsibleFilter,
    setResponsibleFilter,
    dueFilter,
    setDueFilter,
    sortBy,
    setSortBy,
    page,
    setPage,
    limit,
    total,
    lastPage,
    isMailModalOpen,
    setIsMailModalOpen,
    selectedDoc,
    setSelectedDoc,
    pendingActionById,
    actionModal,
    closeActionModal,
    confirmActionModal,
    filteredAprs,
    handleDelete,
    handleDownloadPdf,
    handlePrint,
    handleSendEmail,
    handleApprove,
    handleFinalize,
    handleReject,
    handleCreateNewVersion,
    loadAprs,
    overviewMetrics,
  } = useAprs(initialListingState);
  const [density, setDensity] = useState<AprListingDensity>(() => {
    const value = searchParams.get("density");
    return value === "compact" ? "compact" : "comfortable";
  });
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);

  const actionModalConfig = useMemo(() => {
    if (!actionModal) return null;

    if (actionModal.action === "delete") {
      return {
        title: "Excluir APR",
        description: "Esta ação remove o documento da fila operacional.",
        impact: "A exclusão é permanente e remove histórico operacional da APR.",
        confirmLabel: "Excluir APR",
      };
    }

    if (actionModal.action === "approve") {
      return {
        title: "Aprovar APR",
        description: "A APR será movida para o fluxo de emissão do PDF final.",
        impact: "Após a aprovação, a edição direta fica bloqueada.",
        confirmLabel: "Aprovar",
      };
    }

    if (actionModal.action === "reject") {
      return {
        title: "Reprovar APR",
        description: "A APR será marcada como reprovada com justificativa.",
        impact: "A justificativa será registrada no histórico da APR.",
        confirmLabel: "Reprovar",
        requireReason: true,
      };
    }

    if (actionModal.action === "finalize") {
      return {
        title: "Encerrar APR",
        description: "A APR será encerrada no fluxo oficial.",
        impact: "Após o encerramento, o documento não volta para edição.",
        confirmLabel: "Encerrar",
      };
    }

    return {
      title: "Criar nova versão",
      description: "Uma nova revisão será criada com base na APR atual.",
      impact: "A nova versão passa a ser o documento ativo para ajustes.",
      confirmLabel: "Criar versão",
    };
  }, [actionModal]);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);

  const pageAprs = useMemo(
    () =>
      Array.isArray(filteredAprs) ? (filteredAprs as AprListingRecord[]) : [],
    [filteredAprs],
  );

  const companyOptions = useMemo(
    () =>
      Array.from(
        new Map(
          pageAprs.flatMap((item) =>
            item.company_id
              ? [[item.company_id, item.company?.razao_social || item.company_id]]
              : [],
          ),
        ).entries(),
      ).map(([id, name]) => ({ id, name })),
    [pageAprs],
  );

  const siteOptions = useMemo(
    () =>
      Array.from(
        new Map(
          pageAprs.flatMap((item) =>
            item.site_id ? [[item.site_id, item.site?.nome || item.site_id]] : [],
          ),
        ).entries(),
      )
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label, "pt-BR")),
    [pageAprs],
  );

  const responsibleOptions = useMemo(
    () =>
      Array.from(
        new Map(
          pageAprs
            .map((item) => {
              const meta = getAprResponsibleMeta(item);
              const id =
                (item.status === "Aprovada" || item.status === "Encerrada") &&
                item.aprovado_por?.id
                  ? item.aprovado_por.id
                  : item.auditado_por?.id || item.elaborador?.id;

              if (!id || !meta.name || meta.name === "Não definido") {
                return null;
              }

              return [id, meta.name] as const;
            })
            .filter((value): value is readonly [string, string] => Boolean(value)),
        ).entries(),
      )
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label, "pt-BR")),
    [pageAprs],
  );

  const activeFilters = [
    ...(searchTerm ? [{ key: "search", label: `Busca: ${searchTerm}` }] : []),
    ...(statusFilter
      ? [{ key: "status", label: `Status: ${statusFilter}` }]
      : []),
    ...(siteFilter
      ? [
          {
            key: "site",
            label: `Obra: ${
              siteOptions.find((option) => option.value === siteFilter)?.label ||
              siteFilter
            }`,
          },
        ]
      : []),
    ...(responsibleFilter
      ? [
          {
            key: "responsavel",
            label: `Responsável: ${
              responsibleOptions.find((option) => option.value === responsibleFilter)
                ?.label || responsibleFilter
            }`,
          },
        ]
      : []),
    ...(dueFilter
      ? [
          {
            key: "vencimento",
            label:
              dueFilter === "today"
                ? "Vence hoje"
                : dueFilter === "next-7-days"
                  ? "Vence em 7 dias"
                  : dueFilter === "expired"
                    ? "Atrasadas"
                    : dueFilter === "upcoming"
                      ? "Futuras"
                      : "Sem prazo",
          },
        ]
      : []),
  ];

  const totalLabel = `${total} ${total === 1 ? "APR encontrada" : "APRs encontradas"}`;
  const hasAnyFilter = activeFilters.length > 0;
  const aprMetrics = useMemo(
    () =>
      loading && pageAprs.length === 0
        ? []
        : [
      {
        label: "APRs",
        value: overviewMetrics?.totalAprs ?? total,
        note: "base operacional",
        tone: "primary" as const,
      },
      {
        label: "Pendentes",
        value: overviewMetrics?.pendentes ?? 0,
        note: "exigem decisão",
        tone:
          (overviewMetrics?.pendentes ?? 0) > 0
            ? ("warning" as const)
            : ("neutral" as const),
      },
      {
        label: "Aprovadas",
        value: overviewMetrics?.aprovadas ?? 0,
        note: "fluxo validado",
        tone: "success" as const,
      },
      {
        label: "Riscos críticos",
        value: overviewMetrics?.riscosCriticos ?? 0,
        note: "prioridade SST",
        tone:
          (overviewMetrics?.riscosCriticos ?? 0) > 0
            ? ("danger" as const)
            : ("neutral" as const),
      },
      {
        label: "Score médio (GRH)",
        value:
          overviewMetrics?.mediaScoreRisco !== undefined
            ? overviewMetrics.mediaScoreRisco
            : "—",
        note: (
          <abbr title="Grau de Risco Hierarquizado (GRH) = Probabilidade × Severidade. Escala 1–25.">
            Prob × Sev (1–25)
          </abbr>
        ),
        tone: "neutral" as const,
      },
      ],
    [loading, overviewMetrics, pageAprs.length, total],
  );

  const clearAllFilters = () => {
    setSearchTerm("");
    setStatusFilter("");
    setSiteFilter("");
    setResponsibleFilter("");
    setDueFilter("");
    setSortBy("priority");
    setPage(1);
  };

  useEffect(() => {
    const params = new URLSearchParams();

    if (searchTerm) params.set("q", searchTerm);
    if (statusFilter) params.set("status", statusFilter);
    if (siteFilter) params.set("site", siteFilter);
    if (responsibleFilter) params.set("responsible", responsibleFilter);
    if (dueFilter) params.set("due", dueFilter);
    if (sortBy !== "priority") params.set("sort", sortBy);
    if (page > 1) params.set("page", String(page));
    if (density !== "comfortable") params.set("density", density);

    const nextQuery = params.toString();
    const currentQuery = searchParams.toString();

    if (nextQuery === currentQuery) {
      return;
    }

    startTransition(() => {
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
        scroll: false,
      });
    });
  }, [
    density,
    dueFilter,
    page,
    pathname,
    responsibleFilter,
    router,
    searchParams,
    searchTerm,
    siteFilter,
    sortBy,
    statusFilter,
  ]);

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar APRs"
        description={loadError}
        action={
          <Button type="button" onClick={loadAprs}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ListPageLayout
        eyebrow="Fila operacional"
        title="Análises Preliminares de Risco"
        description="Crie, gerencie e emita APRs com fluxo de aprovação e rastreabilidade documental."
        icon={<FileText className="h-5 w-5" />}
        metrics={aprMetrics}
        actions={
          canCreate ? (
            <Link
              href="/dashboard/aprs/new"
              className={cn(buttonVariants(), "inline-flex items-center")}
            >
              <Plus className="mr-2 h-4 w-4" />
              Nova APR
            </Link>
          ) : null
        }
        toolbarContent={
          <AprListingToolbar
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            siteFilter={siteFilter}
            onSiteChange={setSiteFilter}
            responsibleFilter={responsibleFilter}
            onResponsibleChange={setResponsibleFilter}
            dueFilter={dueFilter}
            onDueChange={setDueFilter}
            sortBy={sortBy}
            onSortChange={setSortBy}
            density={density}
            onDensityChange={setDensity}
            totalLabel={totalLabel}
            siteOptions={siteOptions}
            responsibleOptions={responsibleOptions}
            activeFilters={activeFilters}
            onClearFilters={clearAllFilters}
            onExport={() => downloadExcel("/aprs/export/excel", "aprs.xlsx")}
            onOpenAdvancedFilters={() => setAdvancedFiltersOpen(true)}
          />
        }
        footer={
          total > 0 ? (
            <AprListingPagination
              page={page}
              limit={limit}
              lastPage={lastPage}
              total={total}
              onPrev={handlePrevPage}
              onNext={handleNextPage}
            />
          ) : null
        }
      >
        {loading && pageAprs.length === 0 ? (
          <div className="p-5">
            <InlineLoadingState label="Carregando APRs..." />
          </div>
        ) : pageAprs.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="Nenhuma APR encontrada"
              description={
                hasAnyFilter
                  ? "Nenhum resultado corresponde aos filtros aplicados."
                  : "Ainda não existem APRs registradas para este tenant."
              }
              action={
                !hasAnyFilter && canCreate ? (
                  <Link
                    href="/dashboard/aprs/new"
                    className={cn(buttonVariants(), "inline-flex items-center")}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Nova APR
                  </Link>
                ) : (
                  <Button type="button" variant="outline" onClick={clearAllFilters}>
                    Limpar filtros
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <div>
            <div className="hidden lg:block">
              <AprListingTable
                aprs={pageAprs}
                density={density}
                isFiltered={hasAnyFilter}
                onDelete={handleDelete}
                onPrint={handlePrint}
                onSendEmail={handleSendEmail}
                onDownloadPdf={handleDownloadPdf}
                onApprove={handleApprove}
                onFinalize={handleFinalize}
                onReject={handleReject}
                onCreateNewVersion={handleCreateNewVersion}
                pendingActionById={pendingActionById}
                onClearFilters={clearAllFilters}
                refetching={refetching}
              />
            </div>

            <div className="grid grid-cols-1 gap-5 p-5 lg:hidden">
              {pageAprs.map((apr) => (
                <AprCard
                  key={apr.id}
                  apr={apr}
                  onDelete={handleDelete}
                  onPrint={handlePrint}
                  onSendEmail={handleSendEmail}
                  onDownloadPdf={handleDownloadPdf}
                  onApprove={handleApprove}
                  onFinalize={handleFinalize}
                  onReject={handleReject}
                  onCreateNewVersion={handleCreateNewVersion}
                  onOpenSignature={setSignatureTarget}
                  onOpenSignatures={setSignaturesTarget}
                />
              ))}
            </div>

            <SignatureModal
              isOpen={Boolean(signatureTarget)}
              onClose={() => setSignatureTarget(null)}
              onSave={handleSignSave}
              userName={user?.nome ?? "Usuário"}
            />

            <SignaturesPanel
              isOpen={Boolean(signaturesTarget)}
              onClose={() => setSignaturesTarget(null)}
              documentId={signaturesTarget?.id ?? ""}
              documentType="APR"
            />
          </div>
        )}
      </ListPageLayout>

      <AprAdvancedFiltersDrawer
        isOpen={advancedFiltersOpen}
        onClose={() => setAdvancedFiltersOpen(false)}
        searchTerm={searchTerm}
        statusFilter={statusFilter}
        siteFilter={siteFilter}
        responsibleFilter={responsibleFilter}
        dueFilter={dueFilter}
        sortBy={sortBy}
        density={density}
        siteOptions={siteOptions}
        responsibleOptions={responsibleOptions}
        onApply={(payload) => {
          setSearchTerm(payload.searchTerm);
          setStatusFilter(payload.statusFilter);
          setSiteFilter(payload.siteFilter);
          setResponsibleFilter(payload.responsibleFilter);
          setDueFilter(payload.dueFilter);
          setSortBy(payload.sortBy);
          setDensity(payload.density);
          setPage(1);
        }}
        onClear={() => {
          clearAllFilters();
          setDensity("comfortable");
        }}
      />

      <StoredFilesPanel
        title="Arquivos APR (Storage)"
        description="PDFs salvos automaticamente por empresa, ano e semana."
        listStoredFiles={aprsService.listStoredFiles}
        getPdfAccess={aprsService.getPdfAccess}
        downloadWeeklyBundle={aprsService.downloadWeeklyBundle}
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

      {actionModal && actionModalConfig ? (
        <AprActionModal
          isOpen={actionModal.isOpen}
          onClose={closeActionModal}
          onConfirm={confirmActionModal}
          loading={actionModal.loading}
          title={actionModalConfig.title}
          description={actionModalConfig.description}
          impact={actionModalConfig.impact}
          confirmLabel={actionModalConfig.confirmLabel}
          requireReason={actionModalConfig.requireReason}
          aprSummary={actionModal.aprSummary}
        />
      ) : null}
    </>
  );
}


