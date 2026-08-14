"use client";
import { logger } from "@/lib/logger";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  FileText,
  ClipboardCheck,
  ListChecks,
  MessageSquareText,
  Sparkles,
  Wand2,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
} from "lucide-react";
import { isAiEnabled } from "@/lib/featureFlags";
import {
  sophieService,
  SophieResponse,
  SophieDraftResponse,
  CreateChecklistAutomationResponse,
  CreateDdsAutomationResponse,
  CreateNonConformityAutomationResponse,
  GeneratePtDraftAutomationResponse,
  QueueMonthlyReportAutomationResponse,
} from "@/services/sophieService";
import { useAuth } from "@/context/AuthContext";
import { Permission } from "@/lib/permissions";
import { sitesService, Site } from "@/services/sitesService";
import { selectedTenantStore } from "@/lib/selectedTenantStore";
import { sessionStore } from "@/lib/sessionStore";
import { safeInternalHref } from "@/lib/security/safe-internal-href";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  storeSophieAprDraft,
  storeSophieNcPreview,
  storeSophiePtDraft,
} from "@/lib/sophie-draft-storage";
import { safeToLocaleDateString } from "@/lib/date/safeFormat";

type PendingContext = {
  active: boolean;
  module: string;
  category: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  responsible: string;
  siteName: string;
  siteId: string;
  dueDate: string;
  href: string;
};

function buildPendingContextPrompt(context: PendingContext) {
  return [
    "Analise a seguinte pendência do sistema SST e proponha um plano de atuação técnico e objetivo.",
    `Módulo: ${context.module || "Não informado"}`,
    `Categoria: ${context.category || "Não informada"}`,
    `Título: ${context.title || "Não informado"}`,
    `Descrição: ${context.description || "Não informada"}`,
    `Prioridade: ${context.priority || "Não informada"}`,
    `Status: ${context.status || "Não informado"}`,
    `Responsável atual: ${context.responsible || "Não definido"}`,
    `Obra/site: ${context.siteName || "Não informado"}`,
    `Prazo: ${context.dueDate || "Não informado"}`,
    "",
    "Responda em português com:",
    "1. diagnóstico resumido da pendência",
    "2. risco operacional e urgência",
    "3. próximos passos imediatos dentro da hierarquia de controle",
    "4. documento, fluxo ou evidência que deve ser priorizado no sistema",
    "5. necessidade ou não de revisão humana",
  ].join("\n");
}

function resolvePendingContextTitle(context: PendingContext) {
  if (context.category === "health") {
    return "Pendência de saúde ocupacional trazida da fila central";
  }

  if (context.module === "Ação") {
    return "Ação corretiva trazida da fila central";
  }

  return "Pendência operacional trazida da fila central";
}

function SuggestedResourceGroup({
  title,
  items,
}: {
  title: string;
  items?: Array<{ id: string; label: string }>;
}) {
  if (!items?.length) return null;

  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ds-color-text-primary)]">
        {title}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.slice(0, 5).map((item) => (
          <span
            key={item.id}
            className="rounded-full border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-2.5 py-1 text-xs font-medium text-[var(--ds-color-text-primary)]"
          >
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function SuggestedTextGroup({
  title,
  items,
  tone = "neutral",
}: {
  title: string;
  items?: Array<string | { label: string; reason?: string; source?: string }>;
  tone?: "neutral" | "warning";
}) {
  if (!items?.length) return null;

  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ds-color-text-primary)]">
        {title}
      </p>
      <div className="mt-2 space-y-1.5">
        {items.slice(0, 5).map((item, index) => {
          const label = typeof item === "string" ? item : item.label;
          const reason = typeof item === "string" ? "" : item.reason || "";
          const source = typeof item === "string" ? "" : item.source || "";
          const sourceLabel =
            source === "pt-group" ? "Grupo PT" : source === "template" ? "Template" : source;
          return (
            <div
              key={`${label}-${index}`}
              className={`rounded-lg border px-3 py-2 text-xs ${
                tone === "warning"
                  ? "border-[var(--ds-color-warning)]/20 bg-[var(--ds-color-warning)]/8"
                  : "border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)]"
              }`}
            >
              <p className="font-semibold text-[var(--ds-color-text-primary)]">{label}</p>
              {reason ? <p className="mt-1 text-[var(--ds-color-text-primary)]">{reason}</p> : null}
              {sourceLabel ? (
                <p className="mt-1 text-xs uppercase tracking-[0.08em] text-[var(--ds-color-text-primary)]">
                  {sourceLabel}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function SstAgentPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const aiEnabled = isAiEnabled();
  const { user, loading: authLoading, hasPermission } = useAuth();
  const [sites, setSites] = useState<Site[]>([]);
  const [activeCompanyId, setActiveCompanyId] = useState(
    () =>
      selectedTenantStore.get()?.companyId ||
      sessionStore.get()?.companyId ||
      user?.company_id ||
      "",
  );
  const [loadingSites, setLoadingSites] = useState(false);
  const [aprSiteId, setAprSiteId] = useState("");
  const [aprTitle, setAprTitle] = useState("");
  const [aprDescription, setAprDescription] = useState("");
  const [aprActivity, setAprActivity] = useState("");
  const [aprProcess, setAprProcess] = useState("");
  const [aprEquipment, setAprEquipment] = useState("");
  const [aprMachine, setAprMachine] = useState("");
  const [ptSiteId, setPtSiteId] = useState("");
  const [ptTitle, setPtTitle] = useState("");
  const [ptDescription, setPtDescription] = useState("");
  const [ptTrabalhoAltura, setPtTrabalhoAltura] = useState(false);
  const [ptEspacoConfinado, setPtEspacoConfinado] = useState(false);
  const [ptTrabalhoQuente, setPtTrabalhoQuente] = useState(false);
  const [ptEletricidade, setPtEletricidade] = useState(false);
  const [ptEscavacao, setPtEscavacao] = useState(false);
  const [checklistSiteId, setChecklistSiteId] = useState("");
  const [ddsSiteId, setDdsSiteId] = useState("");
  const [checklistTitle, setChecklistTitle] = useState("");
  const [checklistDescription, setChecklistDescription] = useState("");
  const [checklistEquipment, setChecklistEquipment] = useState("");
  const [checklistMachine, setChecklistMachine] = useState("");
  const [ddsTheme, setDdsTheme] = useState("");
  const [ddsContext, setDdsContext] = useState("");
  const [ncSiteId, setNcSiteId] = useState("");
  const [ncTitle, setNcTitle] = useState("");
  const [ncDescription, setNcDescription] = useState("");
  const [ncSourceType, setNcSourceType] = useState<"manual" | "image" | "checklist">("manual");
  const [ncSourceReference, setNcSourceReference] = useState("");
  const [ncSourceContext, setNcSourceContext] = useState("");
  const [ncImageFile, setNcImageFile] = useState<File | null>(null);
  const [reportMonth, setReportMonth] = useState(
    String(new Date().getMonth() + 1).padStart(2, "0"),
  );
  const [reportYear, setReportYear] = useState(String(new Date().getFullYear()));
  const [creatingAprDraft, setCreatingAprDraft] = useState(false);
  const [creatingPtDraft, setCreatingPtDraft] = useState(false);
  const [creatingChecklist, setCreatingChecklist] = useState(false);
  const [creatingDds, setCreatingDds] = useState(false);
  const [creatingNc, setCreatingNc] = useState(false);
  const [queueingReport, setQueueingReport] = useState(false);
  const [createdAprDraft, setCreatedAprDraft] = useState<SophieDraftResponse | null>(null);
  const [createdPtDraft, setCreatedPtDraft] = useState<GeneratePtDraftAutomationResponse | null>(
    null,
  );
  const [createdChecklist, setCreatedChecklist] =
    useState<CreateChecklistAutomationResponse | null>(null);
  const [createdDds, setCreatedDds] = useState<CreateDdsAutomationResponse | null>(null);
  const [createdNc, setCreatedNc] = useState<CreateNonConformityAutomationResponse | null>(null);
  const [queuedReport, setQueuedReport] = useState<QueueMonthlyReportAutomationResponse | null>(
    null,
  );
  const [analyzingPendingContext, setAnalyzingPendingContext] = useState(false);
  const [pendingContextAnalysis, setPendingContextAnalysis] = useState<SophieResponse | null>(null);
  const canUseAi = hasPermission(Permission.CAN_USE_AI);
  const prefilledDocumentType = searchParams.get("documentType") || "";
  const prefilledTitle = searchParams.get("title") || "";
  const prefilledDescription = searchParams.get("description") || "";
  const prefilledSiteId = searchParams.get("site_id") || "";
  const prefilledResponsibleId =
    searchParams.get("elaborador_id") ||
    searchParams.get("responsavel_id") ||
    searchParams.get("user_id") ||
    "";
  const prefilledSourceType =
    (searchParams.get("source_type") as "manual" | "image" | "checklist" | null) || null;
  const prefilledSourceReference = searchParams.get("source_reference") || "";
  const prefilledSourceContext = searchParams.get("source_context") || "";
  const pendingContext = useMemo<PendingContext>(
    () => ({
      active: searchParams.get("pendingContext") === "true",
      module: searchParams.get("module") || "",
      category: searchParams.get("category") || "",
      title: searchParams.get("title") || "",
      description: searchParams.get("description") || "",
      priority: searchParams.get("priority") || "",
      status: searchParams.get("status") || "",
      responsible: searchParams.get("responsible") || "",
      siteName: searchParams.get("site_name") || "",
      siteId: searchParams.get("site_id") || "",
      dueDate: searchParams.get("dueDate") || "",
      href: searchParams.get("href") || "",
    }),
    [searchParams],
  );

  useEffect(() => {
    const unsubscribe = selectedTenantStore.subscribe((tenant) => {
      setActiveCompanyId(
        tenant?.companyId || sessionStore.get()?.companyId || user?.company_id || "",
      );
    });
    return () => {
      unsubscribe();
    };
  }, [user?.company_id]);

  useEffect(() => {
    let active = true;

    async function loadSites() {
      if (!aiEnabled || authLoading || !canUseAi) return;
      try {
        setLoadingSites(true);
        const sitesPage = activeCompanyId
          ? await sitesService.findPaginated({
              page: 1,
              limit: 100,
              companyId: activeCompanyId,
            })
          : { data: [], total: 0, page: 1, lastPage: 1 };
        if (!active) return;
        setSites(sitesPage.data);

        if (sitesPage.lastPage > 1) {
          toast.warning("A lista de sites foi limitada aos primeiros 100 registros.");
        }

        const preferredSiteId = user?.site_id || sitesPage.data[0]?.id || "";

        setAprSiteId((current) => current || preferredSiteId);
        setPtSiteId((current) => current || preferredSiteId);
        setChecklistSiteId((current) => current || preferredSiteId);
        setDdsSiteId((current) => current || preferredSiteId);
        setNcSiteId((current) => current || preferredSiteId);
      } catch (error) {
        logger.error("Erro ao carregar sites para SOPHIE:", error);
        if (active) setSites([]);
      } finally {
        if (active) setLoadingSites(false);
      }
    }

    void loadSites();
    return () => {
      active = false;
    };
  }, [activeCompanyId, aiEnabled, authLoading, canUseAi, user?.site_id]);

  useEffect(() => {
    if (!prefilledSiteId && !prefilledTitle && !prefilledDescription) {
      if (prefilledSourceType) {
        setNcSourceType(prefilledSourceType);
      }
      if (prefilledSourceReference) {
        setNcSourceReference((current) => current || prefilledSourceReference);
      }
      if (prefilledSourceContext) {
        setNcSourceContext((current) => current || prefilledSourceContext);
      }
      return;
    }

    if (prefilledSiteId) {
      setAprSiteId((current) => current || prefilledSiteId);
      setPtSiteId((current) => current || prefilledSiteId);
      setChecklistSiteId((current) => current || prefilledSiteId);
      setDdsSiteId((current) => current || prefilledSiteId);
      setNcSiteId((current) => current || prefilledSiteId);
    }

    if (prefilledDocumentType === "apr") {
      setAprTitle((current) => current || prefilledTitle);
      setAprDescription((current) => current || prefilledDescription);
      setAprActivity((current) => current || prefilledTitle);
    }

    if (prefilledDocumentType === "pt") {
      setPtTitle((current) => current || prefilledTitle);
      setPtDescription((current) => current || prefilledDescription);
    }

    if (prefilledDocumentType === "checklist") {
      setChecklistTitle((current) => current || prefilledTitle);
      setChecklistDescription((current) => current || prefilledDescription);
    }

    if (prefilledDocumentType === "dds") {
      setDdsTheme((current) => current || prefilledTitle);
      setDdsContext((current) => current || prefilledDescription);
    }

    if (prefilledDocumentType === "nc") {
      setNcTitle((current) => current || prefilledTitle);
      setNcDescription((current) => current || prefilledDescription);
    }

    if (prefilledSourceType) {
      setNcSourceType(prefilledSourceType);
    }
    if (prefilledSourceReference) {
      setNcSourceReference((current) => current || prefilledSourceReference);
    }
    if (prefilledSourceContext) {
      setNcSourceContext((current) => current || prefilledSourceContext);
    }
  }, [
    prefilledDescription,
    prefilledDocumentType,
    prefilledSourceContext,
    prefilledSourceReference,
    prefilledSourceType,
    prefilledSiteId,
    prefilledTitle,
  ]);

  useEffect(() => {
    setPendingContextAnalysis(null);
  }, [
    pendingContext.active,
    pendingContext.module,
    pendingContext.title,
    pendingContext.description,
    pendingContext.priority,
    pendingContext.status,
    pendingContext.siteName,
  ]);

  const currentUserId = user?.id || "";
  const automationResponsibleId = prefilledResponsibleId || currentUserId;
  const canRunAutomation = aiEnabled && canUseAi && Boolean(currentUserId);
  const hasSites = sites.length > 0;
  const automationPrefillLabel =
    {
      apr: "APR",
      pt: "PT",
      checklist: "Checklist",
      dds: "DDS",
      nc: "Não Conformidade",
    }[prefilledDocumentType] || null;

  function resolveCompanyIdForSite(siteId: string) {
    return sites.find((site) => site.id === siteId)?.company_id || user?.company_id || "";
  }

  async function handleGenerateAprDraft() {
    const elaboradorId = automationResponsibleId || currentUserId;
    if (!elaboradorId) {
      toast.error("Usuário responsável não identificado para gerar APR assistida.");
      return;
    }
    if (!aprSiteId) {
      toast.error("Selecione um site para a APR assistida.");
      return;
    }

    try {
      setCreatingAprDraft(true);
      const response = await sophieService.generateAprDraft({
        title: aprTitle || undefined,
        description: aprDescription || undefined,
        activity: aprActivity || undefined,
        process: aprProcess || undefined,
        equipment: aprEquipment || undefined,
        machine: aprMachine || undefined,
        site_id: aprSiteId,
        company_id: resolveCompanyIdForSite(aprSiteId) || undefined,
        elaborador_id: elaboradorId,
        site_name: sites.find((site) => site.id === aprSiteId)?.nome || undefined,
        company_name: user?.company?.razao_social || undefined,
      });
      setCreatedAprDraft(response);
      storeSophieAprDraft(user?.company_id, response.draft, {
        suggestedRisks: response.suggestedRisks,
        mandatoryChecklists: response.mandatoryChecklists,
      });
      toast.success("APR assistida gerada. Abrindo o formulário para revisão.");

      const params = new URLSearchParams();
      if (response.draft.values.company_id) {
        params.set("company_id", String(response.draft.values.company_id));
      }
      params.set("site_id", aprSiteId);
      params.set("elaborador_id", elaboradorId);
      params.set("apr_draft", "sophie");
      router.push(`/dashboard/aprs/new?${params.toString()}`);
    } catch (error) {
      logger.error("Erro ao gerar APR assistida:", error);
      toast.error("Não foi possível gerar a APR assistida agora.");
    } finally {
      setCreatingAprDraft(false);
    }
  }

  async function handleGeneratePtDraft() {
    const responsavelId = automationResponsibleId || currentUserId;
    if (!responsavelId) {
      toast.error("Usuário responsável não identificado para gerar PT assistida.");
      return;
    }
    if (!ptSiteId) {
      toast.error("Selecione um site para a PT assistida.");
      return;
    }

    try {
      setCreatingPtDraft(true);
      const response = await sophieService.generatePtDraft({
        title: ptTitle || undefined,
        description: ptDescription || undefined,
        site_id: ptSiteId,
        company_id: resolveCompanyIdForSite(ptSiteId) || undefined,
        responsavel_id: responsavelId,
        site_name: sites.find((site) => site.id === ptSiteId)?.nome || undefined,
        company_name: user?.company?.razao_social || undefined,
        trabalho_altura: ptTrabalhoAltura,
        espaco_confinado: ptEspacoConfinado,
        trabalho_quente: ptTrabalhoQuente,
        eletricidade: ptEletricidade,
        escavacao: ptEscavacao,
      });
      setCreatedPtDraft(response);
      storeSophiePtDraft(user?.company_id, response.draft, {
        riskLevel: response.riskLevel,
        suggestedRisks: response.suggestedRisks,
        mandatoryChecklists: response.mandatoryChecklists,
      });
      toast.success("PT assistida gerada. Abrindo o formulário para revisão.");

      const params = new URLSearchParams();
      if (response.draft.values.company_id) {
        params.set("company_id", String(response.draft.values.company_id));
      }
      params.set("site_id", ptSiteId);
      params.set("responsavel_id", responsavelId);
      if (response.draft.values.titulo) {
        params.set("title", String(response.draft.values.titulo));
      }
      if (response.draft.values.descricao) {
        params.set("description", String(response.draft.values.descricao));
      }
      router.push(`/dashboard/pts/new?${params.toString()}`);
    } catch (error) {
      logger.error("Erro ao gerar PT assistida:", error);
      toast.error("Não foi possível gerar a PT assistida agora.");
    } finally {
      setCreatingPtDraft(false);
    }
  }

  async function handleCreateChecklist() {
    if (!currentUserId) {
      toast.error("Usuário atual não identificado para criar checklist assistido.");
      return;
    }
    if (!checklistSiteId) {
      toast.error("Selecione um site para o checklist assistido.");
      return;
    }

    try {
      setCreatingChecklist(true);
      const response = await sophieService.createChecklist({
        titulo: checklistTitle || undefined,
        descricao: checklistDescription || undefined,
        equipamento: checklistEquipment || undefined,
        maquina: checklistMachine || undefined,
        site_id: checklistSiteId,
        inspetor_id: currentUserId,
      });
      setCreatedChecklist(response);
      toast.success("Checklist criado pela SOPHIE com sucesso.");
    } catch (error) {
      logger.error("Erro ao criar checklist assistido:", error);
      toast.error("Não foi possível criar o checklist assistido agora.");
    } finally {
      setCreatingChecklist(false);
    }
  }

  async function handleCreateDds() {
    if (!currentUserId) {
      toast.error("Usuário atual não identificado para criar DDS assistido.");
      return;
    }
    if (!ddsSiteId) {
      toast.error("Selecione um site para o DDS assistido.");
      return;
    }

    try {
      setCreatingDds(true);
      const response = await sophieService.createDds({
        tema: ddsTheme || undefined,
        contexto: ddsContext || undefined,
        site_id: ddsSiteId,
        facilitador_id: currentUserId,
      });
      setCreatedDds(response);
      toast.success("DDS criado pela SOPHIE com sucesso.");
    } catch (error) {
      logger.error("Erro ao criar DDS assistido:", error);
      toast.error("Não foi possível criar o DDS assistido agora.");
    } finally {
      setCreatingDds(false);
    }
  }

  async function handleCreateNc() {
    if (!ncSiteId && (ncSourceType === "manual" || ncSourceType === "image")) {
      toast.error("Selecione um site para a não conformidade assistida.");
      return;
    }
    if (ncSourceType === "checklist" && !ncSourceReference.trim()) {
      toast.error("Informe a referência do checklist para abrir a NC assistida.");
      return;
    }
    if (ncSourceType === "image" && !ncImageFile) {
      toast.error("Anexe uma imagem para abrir a NC a partir da análise visual.");
      return;
    }

    try {
      setCreatingNc(true);
      const selectedSiteName = sites.find((site) => site.id === ncSiteId)?.nome;
      const imageAnalysis =
        ncSourceType === "image" && ncImageFile
          ? await sophieService.analyzeImageRisk(
              ncImageFile,
              [ncTitle, ncDescription, selectedSiteName].filter(Boolean).join(" | "),
            )
          : null;
      const response = await sophieService.createNonConformity({
        title: ncTitle || undefined,
        description: ncDescription || undefined,
        site_id: ncSiteId || undefined,
        local_setor_area: selectedSiteName || undefined,
        responsavel_area: user?.nome || undefined,
        source_type: ncSourceType,
        source_reference: ncSourceReference.trim() || undefined,
        checklist_id:
          ncSourceType === "checklist" ? ncSourceReference.trim() || undefined : undefined,
        source_context: ncSourceContext.trim() || undefined,
        image_analysis_summary: imageAnalysis?.summary,
        image_risks: imageAnalysis?.imminentRisks,
        image_actions: imageAnalysis?.immediateActions,
        image_notes: imageAnalysis?.notes,
      });
      setCreatedNc(response);
      storeSophieNcPreview({
        id: String(response.nonConformity.id),
        riskLevel: response.generation.riskLevel,
        sourceType: response.generation.sourceType,
        actionPlan: response.generation.actionPlan,
        evidenceAttachments: response.generation.evidenceAttachments,
        notes: response.generation.notes,
      });
      toast.success("Não conformidade criada pela SOPHIE. Abrindo a tela para revisão.");
      router.push(`/dashboard/nonconformities/edit/${response.nonConformity.id}?assistant=sophie`);
    } catch (error) {
      logger.error("Erro ao criar NC assistida:", error);
      toast.error("Não foi possível criar a não conformidade assistida agora.");
    } finally {
      setCreatingNc(false);
    }
  }

  async function handleQueueMonthlyReport() {
    const month = Number.parseInt(reportMonth, 10);
    const year = Number.parseInt(reportYear, 10);

    if (!Number.isFinite(month) || month < 1 || month > 12) {
      toast.error("Informe um mês válido para o relatório mensal.");
      return;
    }

    if (!Number.isFinite(year) || year < 2000) {
      toast.error("Informe um ano válido para o relatório mensal.");
      return;
    }

    try {
      setQueueingReport(true);
      const response = await sophieService.queueMonthlyReport({
        mes: month,
        ano: year,
      });
      setQueuedReport(response);
      toast.success("Relatório mensal enfileirado pela SOPHIE.");
    } catch (error) {
      logger.error("Erro ao enfileirar relatório mensal:", error);
      toast.error("Não foi possível enfileirar o relatório mensal agora.");
    } finally {
      setQueueingReport(false);
    }
  }

  async function handleAnalyzePendingContext() {
    if (!pendingContext.active) {
      return;
    }

    try {
      setAnalyzingPendingContext(true);
      const response = await sophieService.chat(buildPendingContextPrompt(pendingContext));
      setPendingContextAnalysis(response);
      toast.success("SOPHIE analisou a pendência selecionada.");
    } catch (error) {
      logger.error("Erro ao analisar pendência com a SOPHIE:", error);
      toast.error("Não foi possível analisar a pendência com a SOPHIE agora.");
    } finally {
      setAnalyzingPendingContext(false);
    }
  }

  const pendingContextHref = safeInternalHref(pendingContext.href);

  return (
    <div className="space-y-5">
      <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-elevated)] p-6 shadow-[var(--ds-shadow-sm)]">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--ds-color-action-primary)] text-white shadow-[var(--ds-shadow-sm)]">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[var(--ds-color-text-primary)]">
              Workspace assistido da SOPHIE
            </h1>
            <p className="mt-1 text-sm text-[var(--ds-color-text-primary)]">
              Use este workspace quando precisar montar documentos assistidos, revisar contexto
              operacional e disparar automações com apoio da SOPHIE. Para ajuda rápida e ideias do
              dia a dia, prefira o chat flutuante.
            </p>
            <div className="ds-inline-link-list mt-4">
              <Link href="/dashboard/documentos/importar" className="ds-inline-link-list__item">
                Importar PDF com IA
              </Link>
              <Link href="/dashboard" className="ds-inline-link-list__item">
                Voltar ao dashboard
              </Link>
            </div>
          </div>
        </div>
      </section>

      {automationPrefillLabel ? (
        <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-info)]/20 bg-[var(--ds-color-info-subtle)] p-4 shadow-[var(--ds-shadow-sm)]">
          <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
            Fluxo iniciado pelo hub documental para {automationPrefillLabel}.
          </p>
          <p className="mt-1 text-sm text-[var(--ds-color-text-primary)]">
            O contexto foi pré-carregado. Revise os campos abaixo e execute a ação assistida quando
            estiver pronto.
          </p>
        </section>
      ) : null}

      {pendingContext.active ? (
        <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] p-5 shadow-[var(--ds-shadow-sm)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                {resolvePendingContextTitle(pendingContext)}
              </p>
              <p className="mt-1 text-sm text-[var(--ds-color-text-primary)]">
                O workspace recebeu o contexto da fila central para acelerar a análise e orientar a
                próxima ação.
              </p>
            </div>
            <div className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-color-warning-border)] bg-[color:var(--ds-color-surface-overlay)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-warning)]">
              prioridade {pendingContext.priority || "operacional"}
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-[var(--ds-color-warning-border)]/40 bg-[color:var(--ds-color-surface-overlay)] p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-primary)]">
                Módulo
              </p>
              <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                {pendingContext.module || "Não informado"}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--ds-color-warning-border)]/40 bg-[color:var(--ds-color-surface-overlay)] p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-primary)]">
                Status
              </p>
              <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                {pendingContext.status || "Não informado"}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--ds-color-warning-border)]/40 bg-[color:var(--ds-color-surface-overlay)] p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-primary)]">
                Obra/site
              </p>
              <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                {pendingContext.siteName || "Não informado"}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--ds-color-warning-border)]/40 bg-[color:var(--ds-color-surface-overlay)] p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-primary)]">
                Prazo
              </p>
              <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                {pendingContext.dueDate
                  ? safeToLocaleDateString(
                      pendingContext.dueDate,
                      "pt-BR",
                      undefined,
                      "Não informado",
                    )
                  : "Não informado"}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-[var(--ds-color-warning-border)]/40 bg-[color:var(--ds-color-surface-overlay)] p-4">
            <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
              {pendingContext.title || "Pendência sem título"}
            </p>
            <p className="mt-2 text-sm text-[var(--ds-color-text-primary)]">
              {pendingContext.description || "Sem descrição complementar."}
            </p>
            <p className="mt-2 text-xs text-[var(--ds-color-text-primary)]">
              Responsável atual: {pendingContext.responsible || "Não definido"}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={handleAnalyzePendingContext}
              loading={analyzingPendingContext}
              disabled={!canRunAutomation}
              variant="warning"
              leftIcon={<Wand2 className="h-4 w-4" />}
            >
              Analisar contexto da pendência
            </Button>
            {pendingContextHref ? (
              <Link
                href={pendingContextHref}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-overlay)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-action-primary)] motion-safe:transition-colors hover:border-[var(--ds-color-action-primary)]/35"
              >
                Abrir item original
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : null}
          </div>

          {pendingContextAnalysis ? (
            <div className="mt-4 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-color-primary-subtle)] px-2.5 py-1 text-xs font-semibold text-[var(--ds-color-action-primary)]">
                  <Sparkles className="h-3.5 w-3.5" />
                  análise contextual
                </span>
                <span className="text-xs text-[var(--ds-color-text-primary)]">
                  Confiança: {pendingContextAnalysis.confidence}
                </span>
                {pendingContextAnalysis.needsHumanReview ? (
                  <span className="text-xs font-semibold text-[var(--ds-color-warning)]">
                    revisão humana recomendada
                  </span>
                ) : null}
              </div>

              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-[var(--ds-color-text-primary)]">
                {pendingContextAnalysis.answer}
              </p>

              {pendingContextAnalysis.warnings?.length ? (
                <div className="mt-3 rounded-xl border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-warning)]">
                    Pontos de atenção
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-[var(--ds-color-text-primary)]">
                    {pendingContextAnalysis.warnings.map((warning) => (
                      <li key={warning}>• {warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {pendingContextAnalysis.suggestedActions?.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {pendingContextAnalysis.suggestedActions.map((action) => {
                    const actionHref = safeInternalHref(action.href);
                    return actionHref ? (
                      <Link
                        key={`${action.label}-${action.href}`}
                        href={actionHref}
                        className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-color-border-default)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-action-primary)] motion-safe:transition-colors hover:border-[var(--ds-color-action-primary)]/35 hover:bg-[var(--ds-color-primary-subtle)]"
                      >
                        {action.label}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    ) : (
                      <span
                        key={action.label}
                        className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/35 px-3 py-1.5 text-xs font-semibold text-[var(--ds-color-text-primary)]"
                      >
                        {action.label}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {aiEnabled ? (
        <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-elevated)] p-5 shadow-[var(--ds-shadow-sm)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-[var(--ds-color-text-primary)]">
                Documentos assistidos e análises
              </h2>
              <p className="mt-1 text-sm text-[var(--ds-color-text-primary)]">
                Use os formulários abaixo para pedir rascunhos, abrir fluxos assistidos e analisar
                contextos mais complexos com a SOPHIE.
              </p>
            </div>
            <div className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-color-border-default)] bg-[var(--ds-color-primary-subtle)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-action-primary)]">
              <Wand2 className="h-3.5 w-3.5" />
              automação assistida
            </div>
          </div>

          {authLoading ? (
            <div className="mt-4 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4 text-sm text-[var(--ds-color-text-primary)]">
              Validando permissões e contexto operacional para liberar os fluxos assistidos...
            </div>
          ) : !canUseAi ? (
            <div className="mt-4 rounded-xl border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] p-4">
              <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                Seu perfil ainda não possui a permissão <code>can_use_ai</code>.
              </p>
              <p className="mt-1 text-sm text-[var(--ds-color-text-primary)]">
                Os fluxos assistidos de documentos e análises mais profundas exigem liberação no
                backend.
              </p>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
              <div className="rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4">
                <div className="flex items-center gap-2">
                  <FileText className="h-4.5 w-4.5 text-[var(--ds-color-action-primary)]" />
                  <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    Gerar APR Assistida
                  </h3>
                </div>
                <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                  A SOPHIE monta o rascunho completo da APR e abre o wizard com contexto de empresa,
                  site, elaborador e riscos sugeridos.
                </p>
                <div className="mt-3 space-y-2.5">
                  <input
                    value={aprTitle}
                    onChange={(event) => setAprTitle(event.target.value)}
                    placeholder="Título da APR"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <textarea
                    value={aprDescription}
                    onChange={(event) => setAprDescription(event.target.value)}
                    placeholder="Escopo, frente de serviço ou cenário operacional"
                    rows={3}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <input
                      value={aprActivity}
                      onChange={(event) => setAprActivity(event.target.value)}
                      placeholder="Atividade"
                      className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                    />
                    <input
                      value={aprProcess}
                      onChange={(event) => setAprProcess(event.target.value)}
                      placeholder="Processo"
                      className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                    />
                    <input
                      value={aprEquipment}
                      onChange={(event) => setAprEquipment(event.target.value)}
                      placeholder="Equipamento"
                      className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                    />
                    <input
                      value={aprMachine}
                      onChange={(event) => setAprMachine(event.target.value)}
                      placeholder="Máquina"
                      className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                    />
                  </div>
                  <select
                    value={aprSiteId}
                    onChange={(event) => setAprSiteId(event.target.value)}
                    disabled={loadingSites || !hasSites}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  >
                    <option value="">
                      {loadingSites ? "Carregando sites..." : "Selecione um site"}
                    </option>
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.nome}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={handleGenerateAprDraft}
                    loading={creatingAprDraft}
                    disabled={!canRunAutomation || !hasSites}
                    className="w-full"
                    leftIcon={<Wand2 className="h-4 w-4" />}
                  >
                    Gerar APR completa pela SOPHIE
                  </Button>
                  {createdAprDraft ? (
                    <div className="rounded-xl border border-[var(--ds-color-success)]/20 bg-[var(--ds-color-success-subtle)] p-3">
                      <p className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        <CheckCircle2 className="h-4 w-4 text-[var(--ds-color-success)]" />
                        {createdAprDraft.summary}
                      </p>
                      {createdAprDraft.suggestedActions.length ? (
                        <ul className="mt-2 space-y-1 text-xs text-[var(--ds-color-text-primary)]">
                          {createdAprDraft.suggestedActions.slice(0, 3).map((item) => (
                            <li key={item}>• {item}</li>
                          ))}
                        </ul>
                      ) : null}
                      <SuggestedResourceGroup
                        title="Atividades sugeridas"
                        items={createdAprDraft.suggestedResources?.activities}
                      />
                      <SuggestedResourceGroup
                        title="Participantes sugeridos"
                        items={createdAprDraft.suggestedResources?.participants}
                      />
                      <SuggestedResourceGroup
                        title="Ferramentas sugeridas"
                        items={createdAprDraft.suggestedResources?.tools}
                      />
                      <SuggestedResourceGroup
                        title="Máquinas sugeridas"
                        items={createdAprDraft.suggestedResources?.machines}
                      />
                      <SuggestedTextGroup
                        title="Riscos sugeridos"
                        items={createdAprDraft.suggestedRisks}
                      />
                      <SuggestedTextGroup
                        title="Checklists de apoio"
                        items={createdAprDraft.mandatoryChecklists}
                        tone="warning"
                      />
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4">
                <div className="flex items-center gap-2">
                  <ClipboardCheck className="h-4.5 w-4.5 text-[var(--ds-color-accent)]" />
                  <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    Gerar PT Assistida
                  </h3>
                </div>
                <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                  A SOPHIE estrutura a PT, define criticidade inicial, destaca controles e abre o
                  formulário com os campos-chave preenchidos.
                </p>
                <div className="mt-3 space-y-2.5">
                  <input
                    value={ptTitle}
                    onChange={(event) => setPtTitle(event.target.value)}
                    placeholder="Título da PT"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <textarea
                    value={ptDescription}
                    onChange={(event) => setPtDescription(event.target.value)}
                    placeholder="Escopo, tarefa e condições da liberação"
                    rows={3}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <select
                    value={ptSiteId}
                    onChange={(event) => setPtSiteId(event.target.value)}
                    disabled={loadingSites || !hasSites}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  >
                    <option value="">
                      {loadingSites ? "Carregando sites..." : "Selecione um site"}
                    </option>
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.nome}
                      </option>
                    ))}
                  </select>
                  <div className="grid gap-2 sm:grid-cols-2 text-xs text-[var(--ds-color-text-primary)]">
                    {[
                      {
                        label: "trabalho em altura",
                        value: ptTrabalhoAltura,
                        setter: setPtTrabalhoAltura,
                      },
                      {
                        label: "espaço confinado",
                        value: ptEspacoConfinado,
                        setter: setPtEspacoConfinado,
                      },
                      {
                        label: "trabalho a quente",
                        value: ptTrabalhoQuente,
                        setter: setPtTrabalhoQuente,
                      },
                      { label: "eletricidade", value: ptEletricidade, setter: setPtEletricidade },
                      { label: "escavação", value: ptEscavacao, setter: setPtEscavacao },
                    ].map((item) => (
                      <label
                        key={item.label}
                        className="flex items-center gap-2 rounded-xl border border-[var(--ds-color-border-default)] px-3 py-2"
                      >
                        <input
                          type="checkbox"
                          checked={item.value}
                          onChange={(event) => item.setter(event.target.checked)}
                          className="h-4 w-4 rounded border-[var(--ds-color-border-default)]"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>
                  <Button
                    onClick={handleGeneratePtDraft}
                    loading={creatingPtDraft}
                    disabled={!canRunAutomation || !hasSites}
                    variant="success"
                    className="w-full"
                    leftIcon={<ClipboardCheck className="h-4 w-4" />}
                  >
                    Gerar PT completa pela SOPHIE
                  </Button>
                  {createdPtDraft ? (
                    <div className="rounded-xl border border-[var(--ds-color-success)]/20 bg-[var(--ds-color-success-subtle)] p-3">
                      <p className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        <CheckCircle2 className="h-4 w-4 text-[var(--ds-color-success)]" />
                        {createdPtDraft.summary}
                      </p>
                      <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                        Nível de risco sugerido: {createdPtDraft.riskLevel}
                      </p>
                      {createdPtDraft.suggestedActions.length ? (
                        <ul className="mt-2 space-y-1 text-xs text-[var(--ds-color-text-primary)]">
                          {createdPtDraft.suggestedActions.slice(0, 3).map((item) => (
                            <li key={item}>• {item}</li>
                          ))}
                        </ul>
                      ) : null}
                      <SuggestedResourceGroup
                        title="Executantes sugeridos"
                        items={createdPtDraft.suggestedResources?.participants}
                      />
                      <SuggestedResourceGroup
                        title="Ferramentas sugeridas"
                        items={createdPtDraft.suggestedResources?.tools}
                      />
                      <SuggestedResourceGroup
                        title="Máquinas sugeridas"
                        items={createdPtDraft.suggestedResources?.machines}
                      />
                      <SuggestedTextGroup
                        title="Riscos sugeridos"
                        items={createdPtDraft.suggestedRisks}
                      />
                      <SuggestedTextGroup
                        title="Checklists mandatórios"
                        items={createdPtDraft.mandatoryChecklists}
                        tone="warning"
                      />
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4">
                <div className="flex items-center gap-2">
                  <ListChecks className="h-4.5 w-4.5 text-[var(--ds-color-action-primary)]" />
                  <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    Criar Checklist
                  </h3>
                </div>
                <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                  Gere e salve checklist técnico com itens iniciais de SST.
                </p>
                <div className="mt-3 space-y-2.5">
                  <input
                    value={checklistTitle}
                    onChange={(event) => setChecklistTitle(event.target.value)}
                    placeholder="Título opcional"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <textarea
                    value={checklistDescription}
                    onChange={(event) => setChecklistDescription(event.target.value)}
                    placeholder="Descreva a atividade ou frente de serviço"
                    rows={3}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <input
                    value={checklistEquipment}
                    onChange={(event) => setChecklistEquipment(event.target.value)}
                    placeholder="Equipamento opcional"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <input
                    value={checklistMachine}
                    onChange={(event) => setChecklistMachine(event.target.value)}
                    placeholder="Máquina opcional"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <select
                    value={checklistSiteId}
                    onChange={(event) => setChecklistSiteId(event.target.value)}
                    disabled={loadingSites || !hasSites}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  >
                    <option value="">
                      {loadingSites ? "Carregando sites..." : "Selecione um site"}
                    </option>
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.nome}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={handleCreateChecklist}
                    loading={creatingChecklist}
                    disabled={!canRunAutomation || !hasSites}
                    className="w-full"
                    leftIcon={<Wand2 className="h-4 w-4" />}
                  >
                    Criar checklist pela SOPHIE
                  </Button>
                  {createdChecklist ? (
                    <div className="rounded-xl border border-[var(--ds-color-success)]/20 bg-[var(--ds-color-success-subtle)] p-3">
                      <p className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        <CheckCircle2 className="h-4 w-4 text-[var(--ds-color-success)]" />
                        {createdChecklist.generation.titulo}
                      </p>
                      <Link
                        href={`/dashboard/checklists/edit/${createdChecklist.checklist.id}`}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--ds-color-action-primary)] hover:underline"
                      >
                        Abrir checklist <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4">
                <div className="flex items-center gap-2">
                  <MessageSquareText className="h-4.5 w-4.5 text-[var(--ds-color-accent)]" />
                  <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    Criar DDS
                  </h3>
                </div>
                <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                  Gere e salve um DDS prático para condução em campo.
                </p>
                <div className="mt-3 space-y-2.5">
                  <input
                    value={ddsTheme}
                    onChange={(event) => setDdsTheme(event.target.value)}
                    placeholder="Tema do DDS"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <textarea
                    value={ddsContext}
                    onChange={(event) => setDdsContext(event.target.value)}
                    placeholder="Contexto operacional, tarefa ou risco dominante"
                    rows={4}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <select
                    value={ddsSiteId}
                    onChange={(event) => setDdsSiteId(event.target.value)}
                    disabled={loadingSites || !hasSites}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  >
                    <option value="">
                      {loadingSites ? "Carregando sites..." : "Selecione um site"}
                    </option>
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.nome}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={handleCreateDds}
                    loading={creatingDds}
                    disabled={!canRunAutomation || !hasSites}
                    variant="success"
                    className="w-full"
                    leftIcon={<MessageSquareText className="h-4 w-4" />}
                  >
                    Criar DDS pela SOPHIE
                  </Button>
                  {createdDds ? (
                    <div className="rounded-xl border border-[var(--ds-color-success)]/20 bg-[var(--ds-color-success-subtle)] p-3">
                      <p className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        <CheckCircle2 className="h-4 w-4 text-[var(--ds-color-success)]" />
                        {createdDds.generation.tema}
                      </p>
                      <Link
                        href={`/dashboard/dds/edit/${createdDds.dds.id}`}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--ds-color-action-primary)] hover:underline"
                      >
                        Abrir DDS <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4.5 w-4.5 text-[var(--ds-color-warning)]" />
                  <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    Criar NC
                  </h3>
                </div>
                <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                  Gere uma não conformidade inicial com desvio, risco e ações para revisão humana.
                </p>
                <div className="mt-3 space-y-2.5">
                  <select
                    value={ncSourceType}
                    onChange={(event) =>
                      setNcSourceType(event.target.value as "manual" | "image" | "checklist")
                    }
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  >
                    <option value="manual">Origem manual</option>
                    <option value="image">Abrir NC a partir de imagem</option>
                    <option value="checklist">Abrir NC a partir de checklist</option>
                  </select>
                  <input
                    value={ncTitle}
                    onChange={(event) => setNcTitle(event.target.value)}
                    placeholder="Título do desvio ou achado"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <textarea
                    value={ncDescription}
                    onChange={(event) => setNcDescription(event.target.value)}
                    placeholder="Descreva a evidência observada, condição insegura ou desvio identificado"
                    rows={4}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  {ncSourceType === "image" ? (
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => setNcImageFile(event.target.files?.[0] || null)}
                      className="block w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--ds-color-primary-subtle)] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-[var(--ds-color-action-primary)]"
                    />
                  ) : null}
                  {ncSourceType === "checklist" ? (
                    <input
                      value={ncSourceReference}
                      onChange={(event) => setNcSourceReference(event.target.value)}
                      placeholder={"ID do checklist de origem"}
                      className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                    />
                  ) : null}
                  {ncSourceType === "image" || ncSourceType === "checklist" ? (
                    <textarea
                      value={ncSourceContext}
                      onChange={(event) => setNcSourceContext(event.target.value)}
                      placeholder="Contexto adicional da origem, observações ou vínculo com a operação"
                      rows={2}
                      className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                    />
                  ) : null}
                  <select
                    value={ncSiteId}
                    onChange={(event) => setNcSiteId(event.target.value)}
                    disabled={loadingSites || !hasSites}
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  >
                    <option value="">
                      {loadingSites
                        ? "Carregando sites..."
                        : "Selecione um site (ou deixe a origem definir)"}
                    </option>
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.nome}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={handleCreateNc}
                    loading={creatingNc}
                    disabled={!aiEnabled || !canUseAi || !hasSites}
                    variant="warning"
                    className="w-full"
                    leftIcon={<AlertTriangle className="h-4 w-4" />}
                  >
                    Criar NC pela SOPHIE
                  </Button>
                  {createdNc ? (
                    <div className="rounded-xl border border-[var(--ds-color-success)]/20 bg-[var(--ds-color-success-subtle)] p-3">
                      <p className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        <CheckCircle2 className="h-4 w-4 text-[var(--ds-color-success)]" />
                        {createdNc.nonConformity.codigo_nc || createdNc.generation.title}
                      </p>
                      <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                        Nível de risco sugerido: {createdNc.generation.riskLevel} • origem{" "}
                        {createdNc.generation.sourceType}
                      </p>
                      {createdNc.generation.evidenceCount ? (
                        <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                          Evidências importadas automaticamente:{" "}
                          {createdNc.generation.evidenceCount}
                        </p>
                      ) : null}
                      {createdNc.generation.actionPlan?.length ? (
                        <ul className="mt-2 space-y-1 text-xs text-[var(--ds-color-text-primary)]">
                          {createdNc.generation.actionPlan.slice(0, 3).map((item) => (
                            <li key={`${item.type}-${item.title}`}>
                              • {item.title} ({item.owner} • {item.timeline})
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <Link
                        href={`/dashboard/nonconformities/edit/${createdNc.nonConformity.id}`}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--ds-color-action-primary)] hover:underline"
                      >
                        Abrir NC <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4.5 w-4.5 text-[var(--ds-color-warning)]" />
                  <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    Relatório Mensal
                  </h3>
                </div>
                <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                  Enfileire o relatório mensal consolidado do tenant atual pela SOPHIE.
                </p>
                <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
                  <input
                    value={reportMonth}
                    onChange={(event) => setReportMonth(event.target.value)}
                    placeholder="Mês"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                  <input
                    value={reportYear}
                    onChange={(event) => setReportYear(event.target.value)}
                    placeholder="Ano"
                    className="w-full rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/25 px-3 py-2 text-sm text-[var(--ds-color-text-primary)] outline-none focus:border-[var(--ds-color-action-primary)]"
                  />
                </div>
                <div className="mt-3">
                  <Button
                    onClick={handleQueueMonthlyReport}
                    loading={queueingReport}
                    disabled={!canRunAutomation}
                    variant="warning"
                    className="w-full"
                    leftIcon={<CalendarDays className="h-4 w-4" />}
                  >
                    Enfileirar relatório mensal
                  </Button>
                </div>
                {queuedReport ? (
                  <div className="mt-3 rounded-xl border border-[var(--ds-color-success)]/20 bg-[var(--ds-color-success-subtle)] p-3">
                    <p className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                      <CheckCircle2 className="h-4 w-4 text-[var(--ds-color-success)]" />
                      Relatório {String(queuedReport.month).padStart(2, "0")}/{queuedReport.year} na
                      fila
                    </p>
                    <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                      Job ID: {String(queuedReport.jobId || "n/a")}
                    </p>
                    <Link
                      href="/dashboard/relatorios/rdos"
                      className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--ds-color-action-primary)] hover:underline"
                    >
                      Abrir relatórios <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </section>
      ) : null}

      {!aiEnabled ? (
        <section className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] p-5 text-[var(--ds-color-warning)] shadow-[var(--ds-shadow-sm)]">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-4.5 w-4.5" />
            <div>
              <p className="text-sm font-semibold">SOPHIE está desativada neste ambiente.</p>
              <p className="mt-1 text-xs text-[var(--ds-color-text-primary)]">
                Defina <code>NEXT_PUBLIC_FEATURE_AI_ENABLED=true</code> no frontend para habilitar a
                experiência completa.
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
