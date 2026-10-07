"use client";
import { logger } from "@/lib/logger";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import {
  CHECKLIST_GOVERNED_PHOTO_REF_PREFIX,
  checklistsService,
} from "@/services/checklistsService";
import type { Checklist } from "@/services/checklistsService";
import { sitesService } from "@/services/sitesService";
import { usersService } from "@/services/usersService";
import { signaturesService } from "@/services/signaturesService";
import type { Company } from "@/services/companiesService";
import { companiesService } from "@/services/companiesService";
import { aiService } from "@/services/aiService";
import { isAiEnabled } from "@/lib/featureFlags";
import type { Site } from "@/services/sitesService";
import type { User } from "@/services/usersService";
import {
  ChecklistFormData,
  ChecklistItemForm,
  ChecklistTopicForm,
  checklistSchema,
} from "../types";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowLeft,
  Bot,
  Save,
  Plus,
  PenTool,
  CheckCircle,
  Sparkles,
  Printer,
  Send,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { useAuth } from "@/context/AuthContext";
import { Permission } from "@/lib/permissions";
import { useFormSubmit } from "@/hooks/useFormSubmit";
import { Button } from "@/components/ui/button";
import { isUserVisibleForSite } from "@/lib/site-scoped-user-visibility";
import { InlineLoadingState } from "@/components/ui/state";
import { checklistCategoryOptions } from "@/lib/checklist-modules";
import { openPdfForPrint, openUrlInNewTab } from "@/lib/print-utils";
import {
  createChecklistItemId,
  createChecklistTopicId,
  normalizeChecklistHierarchy,
} from "../hierarchy";
import {
  buildChecklistFormHierarchy,
  buildChecklistRequestPayload,
  getChecklistTopicsWithoutItems,
} from "../form-serialization";
import { computeChecklistBarrierSummary } from "../barrier-viva";
import { safeToLocaleString, toInputDateValue } from "@/lib/date/safeFormat";
import { PageHeader } from "@/components/layout";
import { StatusPill } from "@/components/ui/status-pill";
import { ModalFrame, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/modal-frame";
import {
  getSensitiveDraftExpiresAt,
  isSensitiveDraftExpired,
  sanitizeSensitiveDraftValue,
} from "@/lib/sensitive-draft-sanitizer";
import {
  blobsToBoundedDataUrls,
  processMobileImage,
  processMobileImages,
} from "@/lib/images/process-mobile-image";
import { uploadSequentially } from "@/lib/images/sequential-image-upload";

const SignatureModal = dynamic(
  () => import("./SignatureModal").then((module) => module.SignatureModal),
  { ssr: false },
);

const ExecutionItem = dynamic(
  () => import("./ExecutionItem").then((module) => module.ExecutionItem),
);

const TemplateItem = dynamic(
  () => import("./TemplateItem").then((module) => module.TemplateItem),
);

interface ChecklistFormProps {
  id?: string;
  mode?: "checklist" | "template";
}

interface ChecklistSignatureState {
  signatureData: string;
  type: string;
  signedAt: string;
}

type ChecklistStructureMode = "machines_equipment" | "operational";
type ChecklistAssetMode = "tool" | "machine";
type GovernedPhotoAccessState = "loading" | "ready" | "error";
type GovernedPdfAccessState = "idle" | "loading" | "ready" | "error";

const panelClassName =
  "rounded-[var(--ds-radius-xl)] border border-[var(--component-card-border)] bg-[color:var(--component-card-bg)] shadow-[var(--component-card-shadow)]";
const fieldClassName =
  "w-full rounded-[var(--ds-radius-md)] border border-[var(--component-field-border)] bg-[color:var(--component-field-bg)] px-4 py-2 text-sm text-[var(--component-field-text)] shadow-[var(--component-field-shadow)] focus:border-[var(--component-field-border-focus)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]";
const labelClassName =
  "mb-1 block text-sm font-medium text-[var(--color-text-secondary)]";
const conditionalToggleClassName =
  "flex items-center justify-center rounded-[var(--ds-radius-md)] border px-3 py-2 text-sm font-medium focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]";

const isGovernedChecklistPhotoReference = (value?: string | null) =>
  typeof value === "string" &&
  value.startsWith(CHECKLIST_GOVERNED_PHOTO_REF_PREFIX);

export function ChecklistForm({ id, mode = "checklist" }: ChecklistFormProps) {
  const searchParams = useSearchParams();
  const templateIdParam =
    searchParams.get("modelId") || searchParams.get("templateId") || "none";
  const prefillCompanyId = searchParams.get("company_id") || "";
  const prefillSiteId = searchParams.get("site_id") || "";
  const prefillInspectorId =
    searchParams.get("inspetor_id") || searchParams.get("user_id") || "";
  const prefillTitle = searchParams.get("title") || "";
  const prefillDescription = searchParams.get("description") || "";
  const prefillEquipment = searchParams.get("equipamento") || "";
  const prefillMachine = searchParams.get("maquina") || "";
  const prefillCategory = searchParams.get("categoria") || "";
  const isFieldMode = searchParams.get("field") === "1";
  const { user, hasPermission } = useAuth();
  const isTemplateMode = mode === "template";
  const isAdminGeneral = user?.profile?.nome === "Administrador Geral";
  const canManageChecklists = hasPermission(Permission.CAN_MANAGE_CHECKLISTS);
  const canViewChecklists = hasPermission(Permission.CAN_VIEW_CHECKLISTS);
  const canManageSignatures = hasPermission(Permission.CAN_MANAGE_SIGNATURES);
  const canManageNc = hasPermission(Permission.CAN_MANAGE_NC);
  const runtimeTemplateId =
    searchParams.get("modelId") || searchParams.get("templateId");
  const isTemplateFillFlow = Boolean(
    runtimeTemplateId && !id && !isTemplateMode,
  );
  const [fetching, setFetching] = useState(true);
  const [currentChecklistId, setCurrentChecklistId] = useState<
    string | undefined
  >(id);
  const [currentChecklist, setCurrentChecklist] = useState<Checklist | null>(
    null,
  );
  const [isOfflineQueued, setIsOfflineQueued] = useState(false);
  const [finalizingPdf, setFinalizingPdf] = useState(false);
  const [processingEquipmentPhoto, setProcessingEquipmentPhoto] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [checklistMode, setChecklistMode] = useState<ChecklistAssetMode>("tool");
  const [structureMode, setStructureMode] =
    useState<ChecklistStructureMode>("operational");
  const [aiGenerating, setAiGenerating] = useState(false);

  // Estados para email e modal
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const activeChecklistId = currentChecklist?.id || currentChecklistId || id;

  const buildSignatureState = (
    sigs: Array<{
      user_id?: string;
      signature_data?: string;
      type?: string;
      signed_at?: string;
      created_at?: string;
    }>,
  ) => {
    const sigsMap: Record<string, ChecklistSignatureState> = {};
    sigs.forEach((sig) => {
      if (!sig.user_id) return;
      sigsMap[sig.user_id] = {
        signatureData: sig.signature_data || "",
        type: sig.type || "digital",
        signedAt: sig.signed_at || sig.created_at || new Date().toISOString(),
      };
    });
    return sigsMap;
  };

  const refreshChecklistSignatures = async (
    checklistId: string,
    options?: { notifyReset?: boolean; previousCount?: number },
  ) => {
    try {
      const nextSignatures =
        await signaturesService.findByChecklist(checklistId);
      const nextState = buildSignatureState(nextSignatures);
      setSignatures(nextState);

      if (
        options?.notifyReset &&
        (options.previousCount || 0) > 0 &&
        Object.keys(nextState).length === 0
      ) {
        toast.warning(
          "As assinaturas anteriores foram invalidadas porque o checklist sofreu alteração material.",
        );
      }

      return nextState;
    } catch (error) {
      logger.error("Erro ao atualizar assinaturas do checklist:", error);
      if (options?.notifyReset && (options.previousCount || 0) > 0) {
        setSignatures({});
        toast.warning(
          "As assinaturas anteriores podem ter sido invalidadas após a alteração do checklist. Recarregue a tela para confirmar.",
        );
      }
      return {};
    }
  };

  const storeInlineEquipmentPhoto = async (file: File) => {
    const formValues = getValues();
    const existingDataUrls = (formValues.itens || [])
      .flatMap((item) => item.fotos || [])
      .filter((photo) => photo.startsWith("data:"));
    const { values } = await blobsToBoundedDataUrls([file], {
      existingDataUrls,
    });
    const boundedDataUrl = values[0];
    if (!boundedDataUrl) {
      throw new Error("A foto do equipamento excede a quota offline agregada.");
    }
    setValue("foto_equipamento", boundedDataUrl, {
      shouldDirty: true,
      shouldTouch: true,
    });
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      setProcessingEquipmentPhoto(true);
      const processed = await processMobileImage(file);
      if (activeChecklistId && !isOfflineQueued && canManageChecklists) {
        const previousSignatureCount = Object.keys(signatures).length;
        const result = await checklistsService.attachEquipmentPhoto(
          activeChecklistId,
          processed.file,
        );
        setValue("foto_equipamento", result.photoReference, {
          shouldDirty: true,
          shouldTouch: true,
        });
        setCurrentChecklist((prev) =>
          prev ? { ...prev, foto_equipamento: result.photoReference } : prev,
        );
        setResolvedGovernedPhotoUrls((prev) => {
          const next = { ...prev };
          delete next.equipment;
          return next;
        });
        setResolvedGovernedPhotoStates((prev) => {
          const next = { ...prev };
          delete next.equipment;
          return next;
        });
        if (result.signaturesReset) {
          await refreshChecklistSignatures(activeChecklistId, {
            notifyReset: true,
            previousCount: previousSignatureCount,
          });
        }
        toast.success(
          "Foto do equipamento enviada para o armazenamento governado.",
        );
      } else {
        await storeInlineEquipmentPhoto(processed.file);
        toast.info(
          activeChecklistId
            ? "Foto mantida localmente porque o checklist não pode usar upload governado neste momento."
            : "Foto mantida localmente até o checklist ser salvo. Depois disso você pode usar o upload governado.",
        );
      }
    } catch (error) {
      logger.error("Erro ao anexar foto do equipamento:", error);
      toast.error("Não foi possível anexar a foto do equipamento.");
    } finally {
      setProcessingEquipmentPhoto(false);
      e.target.value = "";
    }
  };

  // Estados para assinaturas
  const [isSignatureModalOpen, setIsSignatureModalOpen] = useState(false);
  const [currentSigningUser, setCurrentSigningUser] = useState<User | null>(
    null,
  );
  const [signatures, setSignatures] = useState<
    Record<string, ChecklistSignatureState>
  >({});
  const [resolvedGovernedPhotoUrls, setResolvedGovernedPhotoUrls] = useState<
    Record<string, string>
  >({});
  const [resolvedGovernedPhotoStates, setResolvedGovernedPhotoStates] =
    useState<Record<string, GovernedPhotoAccessState>>({});
  const [resolvedPdfAccessState, setResolvedPdfAccessState] =
    useState<GovernedPdfAccessState>("idle");
  const [resolvedPdfAccessUrl, setResolvedPdfAccessUrl] = useState<
    string | null
  >(null);
  const [resolvedPdfAccessMessage, setResolvedPdfAccessMessage] = useState<
    string | null
  >(null);
  const [hasFinalPdf, setHasFinalPdf] = useState(false); // derived via access endpoint; survives when pdf_file_key omitted from responses
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [templateLocalVersion, setTemplateLocalVersion] = useState(1);
  const draftBootstrappedRef = useRef(false);
  const draftSaveTimerRef = useRef<number | null>(null);
  const resolvingPhotoKeysRef = useRef<Set<string>>(new Set());

  const draftStorageKey = useMemo(() => {
    if (id) return null;
    return `checklist.form.draft.${mode}.${user?.id || "anon"}.${templateIdParam}`;
  }, [id, mode, user?.id, templateIdParam]);

  const templateVersionStorageKey = useMemo(() => {
    if (!isTemplateMode) return null;
    return `checklist.template.local-version.${currentChecklistId || id || templateIdParam}`;
  }, [isTemplateMode, currentChecklistId, id, templateIdParam]);
  const initialTopicId = useMemo(() => createChecklistTopicId(), []);
  const resetGovernedPhotoAccess = useCallback((cacheKey: string) => {
    resolvingPhotoKeysRef.current.delete(cacheKey);
    setResolvedGovernedPhotoUrls((prev) => {
      const next = { ...prev };
      delete next[cacheKey];
      return next;
    });
    setResolvedGovernedPhotoStates((prev) => {
      const next = { ...prev };
      delete next[cacheKey];
      return next;
    });
  }, []);
  const refreshGovernedPdfAccess = useCallback(
    async (
      checklistId: string,
      options?: { openMode?: "open" | "print" },
    ) => {
      setResolvedPdfAccessState("loading");
      setResolvedPdfAccessMessage(null);

      try {
        const access = await checklistsService.getPdfAccess(checklistId);
        setResolvedPdfAccessUrl(access.url || null);
        setResolvedPdfAccessMessage(access.message || null);
        setHasFinalPdf(access.hasFinalPdf);

        if (!access.url) {
          // hasFinalPdf may be true (degraded case) — keep as finalized for UI lock
          setResolvedPdfAccessState(access.hasFinalPdf ? "ready" : "error");
          if (access.message) {
            toast.warning(access.message);
          }
          return access.hasFinalPdf;
        }

        setResolvedPdfAccessState("ready");

        if (options?.openMode === "print") {
          openPdfForPrint(access.url, () => {
            toast.info(
              "Pop-up bloqueado. Abrimos o PDF final na mesma aba para impressão.",
            );
          });
        } else if (options?.openMode === "open") {
          openUrlInNewTab(access.url);
        }

        return true;
      } catch (error) {
        setResolvedPdfAccessUrl(null);
        setResolvedPdfAccessState("error");
        setResolvedPdfAccessMessage(
          "PDF final registrado, mas a URL assinada não está disponível no momento.",
        );
        setHasFinalPdf(false);
        logger.error("Erro ao resolver PDF final do checklist:", error);
        toast.error("Não foi possível abrir o PDF final deste checklist.");
        return false;
      }
    },
    [],
  );

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    watch,
    getValues,
    formState: { errors },
  } = useForm<ChecklistFormData>({
    resolver: zodResolver(checklistSchema),
    defaultValues: {
      titulo: prefillTitle || (isTemplateMode ? "" : "Checklist operacional"),
      descricao: prefillDescription,
      equipamento: prefillEquipment,
      maquina: prefillMachine,
      foto_equipamento: "",
      data: new Date().toISOString().split("T")[0],
      status: "Pendente",
      company_id: prefillCompanyId || user?.company_id || "",
      site_id: prefillSiteId || user?.site_id || "",
      inspetor_id: prefillInspectorId || user?.id || "",
      categoria: prefillCategory || "SST",
      periodicidade: "Diário",
      nivel_risco_padrao: "Médio",
      ativo: true,
      topicos: [
        {
          id: initialTopicId,
          titulo: "Estrutura principal",
          descricao: "",
          ordem: 1,
        },
      ],
      itens: [
        {
          id: createChecklistItemId(),
          item: "",
          status: "sim",
          tipo_resposta: "sim_nao_na",
          obrigatorio: true,
          peso: 1,
          acao_corretiva_imediata: "",
          observacao: "",
          topico_id: initialTopicId,
          topico_titulo: "Estrutura principal",
          topico_descricao: "",
          ordem_topico: 1,
          ordem_item: 1,
          subitens: [],
        },
      ],
      is_modelo: isTemplateMode,
      auditado_por_id: "",
    },
  });

  const {
    fields: itemFields,
    replace: replaceItems,
  } = useFieldArray({
    control,
    name: "itens",
    keyName: "_formId",
  });

  const selectedCompanyId = watch("company_id");
  const selectedSiteId = watch("site_id");
  const selectedInspectorId = watch("inspetor_id");
  const isFinalized =
    !isTemplateMode && (Boolean(currentChecklist?.pdf_file_key) || hasFinalPdf);
  const hasAnySignature = Object.keys(signatures).length > 0;
  const filteredSites = sites.filter(
    (site) => !selectedCompanyId || site.company_id === selectedCompanyId,
  );
  const filteredInspectors = users.filter(
    (u) => isUserVisibleForSite(u, selectedCompanyId, selectedSiteId || ""),
  );
  const equipamentoValue = watch("equipamento");
  const maquinaValue = watch("maquina");
  const tituloValue = watch("titulo");
  const descricaoValue = watch("descricao");
  const equipmentPhotoValue = watch("foto_equipamento");
  const watchedTopics = watch("topicos");
  const watchedItems = watch("itens");
  const isMachinesEquipmentMode = structureMode === "machines_equipment";
  const isOperationalMode = structureMode === "operational";

  useEffect(() => {
    if (isTemplateMode || !activeChecklistId) {
      setResolvedPdfAccessState("idle");
      setResolvedPdfAccessUrl(null);
      setResolvedPdfAccessMessage(null);
      setHasFinalPdf(false);
      return;
    }

    if (resolvedPdfAccessState !== "idle") {
      return;
    }

    void refreshGovernedPdfAccess(activeChecklistId);
  }, [activeChecklistId, isTemplateMode, refreshGovernedPdfAccess, resolvedPdfAccessState]);

  const inferStructureModeFromChecklist = useCallback(
    (checklist?: Partial<Checklist> | null): ChecklistStructureMode => {
      if (!checklist) {
        return "operational";
      }

      if (checklist.equipamento?.trim() || checklist.maquina?.trim()) {
        return "machines_equipment";
      }

      const hasAdvancedItems = (checklist.itens || []).some(
        (item) =>
          item.criticidade ||
          item.bloqueia_operacao_quando_nc ||
          item.exige_foto_quando_nc ||
          item.exige_observacao_quando_nc ||
          item.acao_corretiva_imediata?.trim(),
      );

      return hasAdvancedItems ? "machines_equipment" : "operational";
    },
    [],
  );

  const normalizeHierarchyState = useMemo(
    () => (topicos: ChecklistFormData["topicos"], itens: ChecklistFormData["itens"]) =>
      normalizeChecklistHierarchy({
        topicos,
        itens,
      }, {
        preserveEmptyItems: true,
        preserveEmptySubitems: true,
      }),
    [],
  );

  const applyHierarchyState = useCallback(
    (
      topicos: ChecklistFormData["topicos"],
      itens: ChecklistFormData["itens"],
      options?: { shouldDirty?: boolean; shouldTouch?: boolean },
    ) => {
      const normalized = normalizeHierarchyState(topicos, itens);
      setValue(
        "topicos",
        normalized.topicos.map((topico, index) => ({
          id: topico.id || createChecklistTopicId(),
          titulo: topico.titulo,
          descricao: topico.descricao || "",
          ordem: index + 1,
          barreira_tipo: topico.barreira_tipo,
          peso_barreira: topico.peso_barreira,
          limite_ruptura: topico.limite_ruptura,
          status_barreira: topico.status_barreira,
          controles_rompidos: topico.controles_rompidos,
          controles_degradados: topico.controles_degradados,
          controles_pendentes: topico.controles_pendentes,
          bloqueia_operacao: topico.bloqueia_operacao,
        })),
        {
          shouldDirty: options?.shouldDirty ?? true,
          shouldTouch: options?.shouldTouch ?? true,
        },
      );
      replaceItems(
        normalized.itens.map((item) => ({
          ...item,
          id: item.id || createChecklistItemId(),
          subitens: item.subitens || [],
        })) as ChecklistFormData["itens"],
      );
    },
    [normalizeHierarchyState, replaceItems, setValue],
  );

  const ensureTopicHasAtLeastOneItem = useCallback(
    (
      topic: Pick<
        ChecklistTopicForm,
        "id" | "titulo" | "descricao" | "barreira_tipo" | "peso_barreira" | "limite_ruptura"
      >,
    ) => {
      const topicId = topic.id || createChecklistTopicId();

      return {
      id: createChecklistItemId(),
      item: "",
      status: "sim" as ChecklistItemForm["status"],
      tipo_resposta: "sim_nao_na" as ChecklistItemForm["tipo_resposta"],
      obrigatorio: true,
      peso: 1,
      criticidade: isMachinesEquipmentMode
        ? ("medio" as ChecklistItemForm["criticidade"])
        : undefined,
      bloqueia_operacao_quando_nc: isMachinesEquipmentMode ? false : undefined,
      exige_foto_quando_nc: isMachinesEquipmentMode ? false : undefined,
      exige_observacao_quando_nc: isMachinesEquipmentMode ? false : undefined,
      acao_corretiva_imediata: isMachinesEquipmentMode ? "" : undefined,
      observacao: "",
      resposta: "",
      fotos: [],
      topico_id: topicId,
      topico_titulo: topic.titulo || "Estrutura principal",
      topico_descricao: topic.descricao || "",
      subitens: [],
      };
    },
    [isMachinesEquipmentMode],
  );

  const handleAddTopic = () => {
    const topicos = getValues("topicos") || [];
    const itens = getValues("itens") || [];
    const nextTopic = {
      id: createChecklistTopicId(),
      titulo: `Novo tópico ${topicos.length + 1}`,
      descricao: "",
      ordem: topicos.length + 1,
    };
    const nextItems = [
      ...itens,
      ensureTopicHasAtLeastOneItem(nextTopic),
    ];
    applyHierarchyState([...topicos, nextTopic], nextItems);
  };

  const handleAddItemToTopic = (topicId: string) => {
    const topicos = getValues("topicos") || [];
    const itens = getValues("itens") || [];
    const topic = topicos.find((current) => current.id === topicId);
    if (!topic) {
      return;
    }

    applyHierarchyState(topicos, [
      ...itens,
      ensureTopicHasAtLeastOneItem({
        id: topic.id || createChecklistTopicId(),
        titulo: topic.titulo,
        descricao: topic.descricao,
        barreira_tipo: topic.barreira_tipo,
        peso_barreira: topic.peso_barreira,
        limite_ruptura: topic.limite_ruptura,
      }),
    ]);
  };

  const handleRemoveTopic = (topicIndex: number) => {
    const topicos = getValues("topicos") || [];
    if (topicos.length <= 1) {
      toast.error("O checklist precisa de pelo menos um tópico principal.");
      return;
    }

    const topic = topicos[topicIndex]!;
    const remainingTopics = topicos.filter((_, index) => index !== topicIndex);
    let remainingItems = (getValues("itens") || []).filter(
      (item) => item.topico_id !== topic.id,
    );

    if (!remainingItems.length && remainingTopics.length) {
      const fallbackTopic = remainingTopics[0]!;
      remainingItems = [
        ensureTopicHasAtLeastOneItem({
          id: fallbackTopic.id || createChecklistTopicId(),
          titulo: fallbackTopic.titulo,
          descricao: fallbackTopic.descricao,
          barreira_tipo: fallbackTopic.barreira_tipo,
          peso_barreira: fallbackTopic.peso_barreira,
          limite_ruptura: fallbackTopic.limite_ruptura,
        }),
      ];
    }

    applyHierarchyState(remainingTopics, remainingItems);
  };

  const handleStructureModeChange = (nextMode: ChecklistStructureMode) => {
    setStructureMode(nextMode);

    if (nextMode === "operational") {
      setValue("equipamento", "");
      setValue("maquina", "");
      setValue("foto_equipamento", "");
      return;
    }

    if (!watch("equipamento") && !watch("maquina")) {
      setChecklistMode("tool");
    }
  };

  const handleRemoveItem = (itemIndex: number) => {
    const itens = getValues("itens") || [];
    if (itens.length <= 1) {
      toast.error("O checklist precisa de pelo menos um item.");
      return;
    }
    const topicos = getValues("topicos") || [];
    const remainingItems = itens.filter((_, index) => index !== itemIndex);
    applyHierarchyState(topicos, remainingItems);
  };

  const handleTopicTitleBlur = (topicIndex: number) => {
    const topicos = getValues("topicos") || [];
    const itens = getValues("itens") || [];
    const topic = topicos[topicIndex];
    if (!topic?.id) {
      return;
    }
    const title = topic.titulo?.trim() || `Tópico ${topicIndex + 1}`;
    const normalizedTopics = topicos.map((current, index) =>
      index === topicIndex ? { ...current, titulo: title } : current,
    );
    const normalizedItems = itens.map((item) =>
      item.topico_id === topic.id
        ? { ...item, topico_titulo: title }
        : item,
    );
    applyHierarchyState(normalizedTopics, normalizedItems, {
      shouldDirty: true,
      shouldTouch: true,
    });
  };

  const groupedItemsByTopic = useMemo(() => {
    const topicos = watchedTopics || [];
    const items = watchedItems || [];
    return topicos.map((topico, topicIndex) => {
      const topicId = topico.id;
      const itemsForTopic = itemFields
        .map((field, index) => ({
          index,
          field,
          item: items[index],
        }))
        .filter((entry) => entry.item?.topico_id === topicId);
      const barrierSummary = computeChecklistBarrierSummary(
        topico,
        itemsForTopic
          .map((entry) => entry.item as ChecklistItemForm | undefined)
          .filter((entry): entry is ChecklistItemForm => Boolean(entry)),
      );

      return {
        topico,
        topicIndex,
        items: itemsForTopic,
        barrierSummary,
      };
    });
  }, [itemFields, watchedItems, watchedTopics]);

  const barrierOverview = useMemo(
    () =>
      groupedItemsByTopic.reduce(
        (accumulator, current) => {
          accumulator.total += 1;
          if (current.barrierSummary.status_barreira === "rompida") {
            accumulator.rompidas += 1;
          } else if (current.barrierSummary.status_barreira === "degradada") {
            accumulator.degradadas += 1;
          } else {
            accumulator.integras += 1;
          }

          if (current.barrierSummary.bloqueia_operacao) {
            accumulator.bloqueios += 1;
          }

          return accumulator;
        },
        {
          total: 0,
          integras: 0,
          degradadas: 0,
          rompidas: 0,
          bloqueios: 0,
        },
      ),
    [groupedItemsByTopic],
  );

  useEffect(() => {
    if (fetching) {
      return;
    }

    if ((watchedTopics || []).length > 0 && (watchedItems || []).length > 0) {
      return;
    }

    const fallbackTopicId = createChecklistTopicId();
    applyHierarchyState(
      [
        {
          id: fallbackTopicId,
          titulo: "Estrutura principal",
          descricao: "",
          ordem: 1,
          barreira_tipo: "procedimental",
          peso_barreira: 1,
          limite_ruptura: 1,
        },
      ],
      [
        ensureTopicHasAtLeastOneItem({
          id: fallbackTopicId,
          titulo: "Estrutura principal",
          descricao: "",
          barreira_tipo: "procedimental",
          peso_barreira: 1,
          limite_ruptura: 1,
        }),
      ],
      {
        shouldDirty: false,
        shouldTouch: false,
      },
    );
  }, [
    applyHierarchyState,
    ensureTopicHasAtLeastOneItem,
    fetching,
    watchedItems,
    watchedTopics,
  ]);

  const openNcWithSophieHref = useMemo(() => {
    if (!activeChecklistId) return null;
    const params = new URLSearchParams();
    params.set("documentType", "nc");
    params.set("source_type", "checklist");
    params.set("source_reference", activeChecklistId);
    params.set("title", tituloValue || "Não conformidade oriunda de checklist");
    params.set("description", descricaoValue || "");
    if (selectedSiteId) {
      params.set("site_id", selectedSiteId);
    }
    params.set(
      "source_context",
      `Checklist ${tituloValue || activeChecklistId} em revisão operacional.`,
    );
    return `/dashboard/sst-agent?${params.toString()}`;
  }, [activeChecklistId, descricaoValue, selectedSiteId, tituloValue]);

  // Load Data
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        const signaturesPromise = id
          ? signaturesService.findByChecklist(id)
          : Promise.resolve([]);
        if (id) {
          void signaturesPromise
            .then((sigs) => {
              if (cancelled) {
                return;
              }
              setSignatures(buildSignatureState(sigs));
            })
            .catch((error) => {
              if (cancelled) {
                return;
              }
              logger.error("Erro ao carregar assinaturas do checklist:", error);
              toast.error(
                "As assinaturas do checklist não puderam ser carregadas agora.",
              );
            });
        }
        const checklistData = id
          ? await checklistsService.findOne(id)
          : null;

        const selectedCompany =
          checklistData?.company_id || user?.company_id || "";

        let companiesData: Company[] = [];
        if (isAdminGeneral) {
          try {
            const companiesPage = await companiesService.findPaginated({
              page: 1,
              limit: 100,
            });
            companiesData = companiesPage.data;
          } catch {
            // sem permissão para listar todas as empresas — seguir com lista vazia
          }
          if (
            selectedCompany &&
            !companiesData.some((company) => company.id === selectedCompany)
          ) {
            try {
              const currentCompany =
                await companiesService.findOne(selectedCompany);
              companiesData = dedupeById([currentCompany, ...companiesData]);
            } catch {
              companiesData = dedupeById(companiesData);
            }
          }
        } else if (selectedCompany) {
          try {
            const currentCompany =
              await companiesService.findOne(selectedCompany);
            companiesData = [currentCompany];
          } catch {
            companiesData = [];
          }
        }

        setCompanies(dedupeById(companiesData));

        if (templateIdParam && templateIdParam !== "none" && !id) {
          try {
            const template = await checklistsService.findOne(templateIdParam);
            if (template) {
              setCurrentChecklist(null);
              setIsOfflineQueued(false);
              setValue("titulo", template.titulo);
              setValue("descricao", template.descricao || "");
              setValue("equipamento", template.equipamento || "");
              setValue("maquina", template.maquina || "");
              setValue("foto_equipamento", template.foto_equipamento || "");
              setValue(
                "company_id",
                template.company_id || user?.company_id || "",
              );
              setValue("site_id", "");
              setValue("inspetor_id", prefillInspectorId || user?.id || "");
              setValue("categoria", template.categoria || "SST");
              setValue("periodicidade", template.periodicidade || "Diário");
              setValue(
                "nivel_risco_padrao",
                template.nivel_risco_padrao || "Médio",
              );

              const normalizedHierarchy = buildChecklistFormHierarchy(
                template.topicos,
                template.itens,
                {
                  resetExecutionState: true,
                },
              );
              setValue(
                "topicos",
                normalizedHierarchy.topicos,
              );
              replaceItems(normalizedHierarchy.itens);

              setStructureMode(inferStructureModeFromChecklist(template));
              if (template.equipamento) {
                setChecklistMode("tool");
              } else if (template.maquina) {
                setChecklistMode("machine");
              }
              // Probe equipment photo from model via access (in case foto_equipamento hidden in template response)
              if (templateIdParam) {
                void checklistsService
                  .getEquipmentPhotoAccess(templateIdParam)
                  .then((acc) => {
                    if (acc && (acc.hasGovernedPhoto || acc.url)) {
                      const marker = `${CHECKLIST_GOVERNED_PHOTO_REF_PREFIX}equipment`;
                      setValue("foto_equipamento", marker, {
                        shouldDirty: false,
                        shouldTouch: false,
                      });
                    }
                  })
                  .catch(() => {});
              }
              toast.success("Modelo carregado! Preencha os dados da verificação.");
            }
          } catch (error) {
            logger.error("Erro ao carregar modelo:", error);
            toast.error("Erro ao carregar modelo.");
          }
        }

        if (checklistData) {
          const checklist = checklistData;
          setCurrentChecklist(checklist);
          setCurrentChecklistId(checklist.id);
          setIsOfflineQueued(false);
          const normalizedHierarchy = buildChecklistFormHierarchy(
            checklist.topicos,
            checklist.itens,
          );
          reset({
            titulo: checklist.titulo,
            descricao: checklist.descricao || "",
            equipamento: checklist.equipamento || "",
            maquina: checklist.maquina || "",
            foto_equipamento: checklist.foto_equipamento || "",
            data: toInputDateValue(checklist.data, toInputDateValue(new Date())),
            status: checklist.status,
            company_id: checklist.company_id,
            site_id: checklist.site_id,
            inspetor_id: checklist.inspetor_id,
            topicos: normalizedHierarchy.topicos,
            itens: normalizedHierarchy.itens,
            is_modelo: checklist.is_modelo,
            categoria: checklist.categoria,
            periodicidade: checklist.periodicidade,
            nivel_risco_padrao: checklist.nivel_risco_padrao,
            ativo: checklist.ativo,
            auditado_por_id: checklist.auditado_por_id || "",
            data_auditoria: checklist.data_auditoria,
            resultado_auditoria: checklist.resultado_auditoria,
            notas_auditoria: checklist.notas_auditoria,
          });

          setStructureMode(inferStructureModeFromChecklist(checklist));
          if (checklist.equipamento) {
            setChecklistMode("tool");
          } else if (checklist.maquina) {
            setChecklistMode("machine");
          }

          // Probe equipment photo via governed access (supports when foto_equipamento omitted from server response)
          if (checklist.id) {
            void checklistsService
              .getEquipmentPhotoAccess(checklist.id)
              .then((acc) => {
                if (acc && (acc.hasGovernedPhoto || acc.url)) {
                  const marker = `${CHECKLIST_GOVERNED_PHOTO_REF_PREFIX}equipment`;
                  setValue("foto_equipamento", marker, {
                    shouldDirty: false,
                    shouldTouch: false,
                  });
                  setCurrentChecklist((prev) =>
                    prev ? { ...prev, foto_equipamento: marker } : prev,
                  );
                }
              })
              .catch(() => {
                /* silent; photo resolve will handle error state if needed */
              });
          }
        }
      } catch (error) {
        logger.error("Erro ao carregar dados:", error);
        toast.error("Erro ao carregar dados do formulário.");
      } finally {
        if (cancelled) {
          return;
        }
        setFetching(false);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, [
    id,
    isAdminGeneral,
    prefillInspectorId,
    replaceItems,
    reset,
    setValue,
    templateIdParam,
    inferStructureModeFromChecklist,
    user?.company_id,
    user?.id,
  ]);

  useEffect(() => {
    if (!activeChecklistId) {
      return;
    }

    const photoTargets: Array<{
      cacheKey: string;
      load: () => Promise<{ url: string | null; message?: string | null }>;
    }> = [];

    if (isGovernedChecklistPhotoReference(equipmentPhotoValue)) {
      photoTargets.push({
        cacheKey: "equipment",
        load: () =>
          checklistsService.getEquipmentPhotoAccess(activeChecklistId),
      });
    }

    (watchedItems || []).forEach((item, itemIndex) => {
      (item.fotos || []).forEach((photo, photoIndex) => {
        if (!isGovernedChecklistPhotoReference(photo)) {
          return;
        }
        photoTargets.push({
          cacheKey: `item-${itemIndex}-${photoIndex}`,
          load: () =>
            checklistsService.getItemPhotoAccess(
              activeChecklistId,
              itemIndex,
              photoIndex,
            ),
        });
      });
    });

    photoTargets.forEach(({ cacheKey, load }) => {
      if (
        resolvedGovernedPhotoUrls[cacheKey] !== undefined ||
        resolvingPhotoKeysRef.current.has(cacheKey)
      ) {
        return;
      }

      resolvingPhotoKeysRef.current.add(cacheKey);
      setResolvedGovernedPhotoStates((prev) => ({
        ...prev,
        [cacheKey]: "loading",
      }));
      void load()
        .then((access) => {
          if (!access.url && access.message) {
            toast.warning(access.message);
          }
          setResolvedGovernedPhotoUrls((prev) => ({
            ...prev,
            [cacheKey]: access.url || "",
          }));
          setResolvedGovernedPhotoStates((prev) => ({
            ...prev,
            [cacheKey]: access.url ? "ready" : "error",
          }));
        })
        .catch((error) => {
          logger.error("Erro ao resolver foto governada do checklist:", error);
          setResolvedGovernedPhotoUrls((prev) => ({
            ...prev,
            [cacheKey]: "",
          }));
          setResolvedGovernedPhotoStates((prev) => ({
            ...prev,
            [cacheKey]: "error",
          }));
        })
        .finally(() => {
          resolvingPhotoKeysRef.current.delete(cacheKey);
        });
    });
  }, [
    activeChecklistId,
    equipmentPhotoValue,
    resolvedGovernedPhotoUrls,
    watchedItems,
  ]);

  useEffect(() => {
    async function loadTenantSites() {
      if (!selectedCompanyId) {
        setSites([]);
        return;
      }

      try {
        const sitesPage = await sitesService.findPaginated({
          page: 1,
          limit: 100,
          companyId: selectedCompanyId,
        });

        let nextSites = sitesPage.data;
        if (
          selectedSiteId &&
          !nextSites.some((site) => site.id === selectedSiteId)
        ) {
          try {
            const currentSite = await sitesService.findOne(selectedSiteId);
            nextSites = dedupeById([currentSite, ...nextSites]);
          } catch {
            nextSites = dedupeById(nextSites);
          }
        } else {
          nextSites = dedupeById(nextSites);
        }

        setSites(nextSites);
      } catch (error) {
        logger.error("Erro ao carregar obras do checklist:", error);
        setSites([]);
      }
    }

    void loadTenantSites();
  }, [selectedCompanyId, selectedSiteId]);

  useEffect(() => {
    async function loadTenantUsers() {
      if (!selectedCompanyId) {
        setUsers([]);
        return;
      }

      try {
        const usersPage = await usersService.findPaginated({
          page: 1,
          limit: 100,
          companyId: selectedCompanyId,
          siteId: selectedSiteId || undefined,
        });

        let nextUsers = usersPage.data;
        if (
          selectedInspectorId &&
          !nextUsers.some((entry) => entry.id === selectedInspectorId)
        ) {
          try {
            const currentInspector =
              await usersService.findOne(selectedInspectorId);
            nextUsers = dedupeById([currentInspector, ...nextUsers]);
          } catch {
            nextUsers = dedupeById(nextUsers);
          }
        } else {
          nextUsers = dedupeById(nextUsers);
        }

        setUsers(nextUsers);
      } catch (error) {
        logger.error("Erro ao carregar usuários do checklist:", error);
        setUsers([]);
      }
    }

    void loadTenantUsers();
  }, [selectedCompanyId, selectedInspectorId, selectedSiteId]);

  // Set default company
  useEffect(() => {
    if (id || selectedCompanyId || isAdminGeneral) return;
    const companyId = user?.company_id || null;
    if (!companyId) return;
    setValue("company_id", companyId);
  }, [id, selectedCompanyId, setValue, user?.company_id, isAdminGeneral]);

  // Sync Equipment/Machine with Title (only in regular mode creation)
  useEffect(() => {
    if (isTemplateMode || id || !isMachinesEquipmentMode) return;
    const base = checklistMode === "machine" ? maquinaValue : equipamentoValue;
    if (!base) return;
    if (!tituloValue || tituloValue.startsWith("Checklist -")) {
      setValue("titulo", `Checklist - ${base}`);
    }
  }, [
    equipamentoValue,
    maquinaValue,
    checklistMode,
    isMachinesEquipmentMode,
    isTemplateMode,
    setValue,
    tituloValue,
    id,
  ]);

  useEffect(() => {
    if (!templateVersionStorageKey || typeof window === "undefined") return;
    const raw = window.localStorage.getItem(templateVersionStorageKey);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      setTemplateLocalVersion(parsed);
    } else {
      setTemplateLocalVersion(1);
    }
  }, [templateVersionStorageKey]);

  useEffect(() => {
    if (!draftStorageKey || fetching || draftBootstrappedRef.current) return;
    draftBootstrappedRef.current = true;
    if (typeof window === "undefined") return;

    const rawDraft = window.localStorage.getItem(draftStorageKey);
    if (!rawDraft) return;

    try {
      const parsed = JSON.parse(rawDraft) as {
        savedAt?: number;
        expiresAt?: number;
        checklistMode?: "tool" | "machine";
        structureMode?: ChecklistStructureMode;
        values?: ChecklistFormData;
      };
      if (!parsed.values) return;
      if (
        isSensitiveDraftExpired({
          savedAt: parsed.savedAt,
          expiresAt: parsed.expiresAt,
        })
      ) {
        window.localStorage.removeItem(draftStorageKey);
        return;
      }
      const normalized = buildChecklistFormHierarchy(
        parsed.values.topicos as Checklist["topicos"],
        parsed.values.itens as Checklist["itens"],
      );
      reset({
        ...parsed.values,
        topicos: normalized.topicos,
        itens: normalized.itens,
      });
      if (parsed.checklistMode) {
        setChecklistMode(parsed.checklistMode);
      }
      if (parsed.structureMode) {
        setStructureMode(parsed.structureMode);
      }
      if (parsed.savedAt) {
        setDraftSavedAt(parsed.savedAt);
      }
      toast.info("Rascunho restaurado automaticamente.");
    } catch (error) {
      logger.error("Erro ao restaurar rascunho de checklist:", error);
    }
  }, [draftStorageKey, fetching, normalizeHierarchyState, reset]);

  useEffect(() => {
    if (!draftStorageKey || fetching) return;
    if (typeof window === "undefined") return;

    const subscription = watch(() => {
      if (!draftBootstrappedRef.current) return;

      if (draftSaveTimerRef.current) {
        window.clearTimeout(draftSaveTimerRef.current);
      }

      draftSaveTimerRef.current = window.setTimeout(() => {
        const formValues = getValues();
        const snapshot: ChecklistFormData = {
          ...formValues,
          foto_equipamento: "",
          itens: formValues.itens.map((item) => ({
            ...item,
            fotos: [],
          })),
        };
        const now = Date.now();
        window.localStorage.setItem(
          draftStorageKey,
          JSON.stringify({
            savedAt: now,
            expiresAt: getSensitiveDraftExpiresAt(now),
            checklistMode,
            structureMode,
            values: sanitizeSensitiveDraftValue(snapshot),
          }),
        );
        setDraftSavedAt(now);
      }, 800);
    });

    return () => {
      subscription.unsubscribe();
      if (draftSaveTimerRef.current) {
        window.clearTimeout(draftSaveTimerRef.current);
      }
    };
  }, [draftStorageKey, fetching, watch, getValues, checklistMode, structureMode]);

  const handleAiGenerate = async () => {
    if (!isAiEnabled()) {
      toast.error("IA desativada neste ambiente.");
      return;
    }
    if (!isMachinesEquipmentMode) {
      toast.error("A geração por IA está disponível apenas para Máquinas e Equipamentos.");
      return;
    }
    const base = checklistMode === "machine" ? maquinaValue : equipamentoValue;
    if (!base) {
      toast.error("Selecione um equipamento ou máquina primeiro.");
      return;
    }

    if (!user?.site_id && !watch("site_id")) {
      toast.error("Selecione uma obra/setor para gerar o checklist.");
      return;
    }

    try {
      setAiGenerating(true);
      toast.info("A IA está gerando o checklist...");

      const generated = await aiService.generateChecklist({
        site_id: watch("site_id") || user?.site_id || "",
        inspetor_id: user?.id || "",
        equipamento: checklistMode === "tool" ? base : undefined,
        maquina: checklistMode === "machine" ? base : undefined,
        titulo: `Checklist - ${base}`,
        is_modelo: isTemplateMode,
      });

      if (generated && generated.itens) {
        const topicos = getValues("topicos");
        const primaryTopic =
          topicos[0] ||
          ({
            id: createChecklistTopicId(),
            titulo: "Estrutura principal",
            descricao: "",
            ordem: 1,
          } as ChecklistTopicForm);
        const generatedItems = generated.itens.map((item: { item: string }) => ({
          id: createChecklistItemId(),
          item: item.item,
          status: "sim" as ChecklistItemForm["status"],
          tipo_resposta: "sim_nao_na" as ChecklistItemForm["tipo_resposta"],
          obrigatorio: true,
          peso: 1,
          criticidade: "medio" as ChecklistItemForm["criticidade"],
          bloqueia_operacao_quando_nc: false,
          exige_foto_quando_nc: false,
          exige_observacao_quando_nc: false,
          acao_corretiva_imediata: "",
          observacao: "",
          resposta: "",
          fotos: [],
          topico_id: primaryTopic.id || createChecklistTopicId(),
          topico_titulo: primaryTopic.titulo,
          topico_descricao: primaryTopic.descricao || "",
          ordem_topico: 1,
          ordem_item: 1,
          subitens: [],
        }));
        applyHierarchyState([primaryTopic], generatedItems);
        toast.success("Checklist gerado com sucesso!");
      }
    } catch (error) {
      logger.error("Erro IA:", error);
      toast.error("Erro ao gerar checklist com IA.");
    } finally {
      setAiGenerating(false);
    }
  };

  const { handleSubmit: onSubmit, loading } = useFormSubmit(
    async (data: ChecklistFormData) => {
      if (isTemplateMode && !canManageChecklists) {
        throw new Error(
          "Você não possui permissão para criar ou editar modelos de checklist.",
        );
      }

      if (
        !isTemplateMode &&
        !activeChecklistId &&
        !isTemplateFillFlow &&
        !canManageChecklists
      ) {
        throw new Error(
          "Você não possui permissão para criar checklists diretamente.",
        );
      }

      if (activeChecklistId && !canManageChecklists) {
        throw new Error(
          "Você não possui permissão para editar este checklist.",
        );
      }

      if (isTemplateFillFlow && !canViewChecklists) {
        throw new Error(
          "Você não possui permissão para preencher checklists a partir de modelos.",
        );
      }

      if (
        isMachinesEquipmentMode &&
        checklistMode === "tool" &&
        !data.equipamento?.trim()
      ) {
        throw new Error("Informe o equipamento para continuar.");
      }
      if (
        isMachinesEquipmentMode &&
        checklistMode === "machine" &&
        !data.maquina?.trim()
      ) {
        throw new Error("Informe a máquina para continuar.");
      }

      const topicsWithoutItems = getChecklistTopicsWithoutItems(
        data.topicos || [],
        data.itens || [],
      );
      if (topicsWithoutItems.length > 0) {
        throw new Error(
          `Todo tópico precisa ter ao menos um item. Revise: ${topicsWithoutItems
            .map((topico) => topico.titulo)
            .join(", ")}.`,
        );
      }

      if (isTemplateFillFlow) {
        if (!data.site_id) {
          throw new Error("Selecione a obra/setor antes de salvar o checklist.");
        }
        if (!data.inspetor_id) {
          throw new Error("Selecione o inspetor responsável antes de salvar o checklist.");
        }
      }

      const payload = buildChecklistRequestPayload(data, {
        checklistMode,
        structureMode,
        isTemplateMode,
      });

      const hasMissingNcObservation = payload.itens.some((item) => {
        const negativeItem = item.status === "nok" || item.status === "nao";
        if (!negativeItem) {
          return false;
        }

        if (item.exige_observacao_quando_nc) {
          return !item.observacao?.trim();
        }

        return !item.observacao?.trim();
      });

      if (hasMissingNcObservation) {
        throw new Error(
          'Itens marcados como "Não Conforme" ou "Não" exigem uma observação.',
        );
      }

      const hasMissingNcPhoto = payload.itens.some((item) => {
        const negativeItem = item.status === "nok" || item.status === "nao";
        if (!negativeItem || !item.exige_foto_quando_nc) {
          return false;
        }

        return !Array.isArray(item.fotos) || item.fotos.length === 0;
      });

      if (hasMissingNcPhoto) {
        throw new Error(
          "Há controles marcados para exigir foto quando houver não conformidade.",
        );
      }

      const activeId = currentChecklistId || id;

      let saved: Checklist;
      if (activeId) {
        saved = await checklistsService.update(
          activeId,
          payload,
          selectedCompanyId || undefined,
        );
      } else if (isTemplateFillFlow && runtimeTemplateId) {
        saved = await checklistsService.fillFromModel(
          runtimeTemplateId,
          payload,
          selectedCompanyId || undefined,
        );
      } else {
        saved = await checklistsService.create(
          payload,
          selectedCompanyId || undefined,
        );
      }

      if ((saved as Checklist & { offlineQueued?: boolean }).offlineQueued) {
        toast.info(
          "Checklist salvo na fila offline. A sincronização será retomada quando a conexão voltar.",
        );
      }

      if (saved?.id) {
        setCurrentChecklistId(saved.id);
      }
      setCurrentChecklist(saved);
      setIsOfflineQueued(
        Boolean(
          (saved as Checklist & { offlineQueued?: boolean }).offlineQueued,
        ),
      );
      if (
        saved?.id &&
        !(saved as Checklist & { offlineQueued?: boolean }).offlineQueued &&
        !isTemplateMode
      ) {
        void refreshChecklistSignatures(saved.id, {
          notifyReset: true,
          previousCount: Object.keys(signatures).length,
        });
      }

      if (draftStorageKey && typeof window !== "undefined") {
        window.localStorage.removeItem(draftStorageKey);
        setDraftSavedAt(null);
      }

      if (
        isTemplateMode &&
        templateVersionStorageKey &&
        typeof window !== "undefined"
      ) {
        const nextVersion = templateLocalVersion + 1;
        window.localStorage.setItem(
          templateVersionStorageKey,
          String(nextVersion),
        );
        setTemplateLocalVersion(nextVersion);
      }
      return saved;
    },
    {
      successMessage: isTemplateMode
        ? id
          ? "Modelo atualizado!"
          : "Modelo criado!"
        : id
          ? "Checklist salvo!"
          : "Checklist criado!",
      context: isTemplateMode ? "Modelo" : "Checklist",
    },
  );

  const handleClearDraft = () => {
    if (!draftStorageKey || typeof window === "undefined") return;
    window.localStorage.removeItem(draftStorageKey);
    setDraftSavedAt(null);
    toast.success("Rascunho local removido.");
  };

  const ensureChecklistPersisted = async () => {
    if (isOfflineQueued) {
      toast.error(
        "Sincronize o checklist salvo offline antes de assinar, emitir ou enviar.",
      );
      return null;
    }

    if (activeChecklistId) {
      return currentChecklist;
    }

    let savedChecklist: Checklist | null = null;
    await handleSubmit(async (data) => {
      const saved = await onSubmit(data);
      if (saved) {
        savedChecklist = saved as Checklist;
      }
    })();

    if (
      (savedChecklist as (Checklist & { offlineQueued?: boolean }) | null)
        ?.offlineQueued
    ) {
      toast.error(
        "O checklist entrou na fila offline. Aguarde a sincronização antes de continuar.",
      );
      return null;
    }

    return savedChecklist;
  };

  const handleUploadItemPhotos = async (itemIndex: number, files: File[]) => {
    if (!files.length) {
      return [];
    }

    const existingPhotos = getValues(`itens.${itemIndex}.fotos`) || [];
    const existingCount = existingPhotos.length;
    const imageBatch = await processMobileImages(files, {
      // Backend throttle: no máximo cinco anexos, enviados sequencialmente.
      maxFiles: Math.min(5, Math.max(0, 6 - existingCount)),
    });
    const processedFiles = imageBatch.processed.map((entry) => entry.file);
    if (imageBatch.rejected.length) {
      toast.warning(
        `${imageBatch.rejected.length} foto(s) rejeitada(s): ${imageBatch.rejected[0]?.message}`,
      );
    }
    if (!processedFiles.length) {
      return [];
    }

    if (!activeChecklistId || isOfflineQueued || !canManageChecklists) {
      toast.info(
        activeChecklistId
          ? "Fotos processadas do item serão mantidas localmente até o checklist poder usar upload governado."
          : "Fotos processadas do item serão mantidas localmente até o checklist ser salvo.",
      );
      const formValues = getValues();
      const existingDataUrls = [
        formValues.foto_equipamento,
        ...(formValues.itens || []).flatMap((item) => item.fotos || []),
      ].filter(
        (photo): photo is string =>
          typeof photo === "string" && photo.startsWith("data:"),
      );
      const localResults = await blobsToBoundedDataUrls(processedFiles, {
        existingDataUrls,
      });
      const localPhotos = localResults.values;
      if (localPhotos.length !== processedFiles.length) {
        toast.warning("Parte das fotos não coube na quota offline e não foi adicionada.");
      }
      return localPhotos;
    }

    const previousSignatureCount = Object.keys(signatures).length;
    const uploadBatch = await uploadSequentially(
      processedFiles,
      (file) =>
        checklistsService.attachItemPhoto(activeChecklistId, itemIndex, file),
      5,
    );
    const uploaded = uploadBatch.successes.map(({ value }) => value);

    if (uploaded.some((entry) => entry.signaturesReset)) {
      await refreshChecklistSignatures(activeChecklistId, {
        notifyReset: true,
        previousCount: previousSignatureCount,
      });
    }

    if (uploaded.length) {
      toast.success(`${uploaded.length} foto(s) do item enviada(s) para o armazenamento governado.`);
    }
    if (uploaded.length !== processedFiles.length) {
      toast.warning("Falha parcial no envio: as fotos com erro podem ser selecionadas novamente.");
    }
    return uploaded.map((entry) => entry.photoReference);
  };

  const resolveChecklistPhotoSrc = (
    photo: string,
    itemIndex?: number,
    photoIndex?: number,
  ) => {
    if (!isGovernedChecklistPhotoReference(photo)) {
      return photo;
    }

    if (itemIndex === undefined || photoIndex === undefined) {
      return resolvedGovernedPhotoUrls.equipment || "";
    }

    return resolvedGovernedPhotoUrls[`item-${itemIndex}-${photoIndex}`] || "";
  };

  const handleRetryGovernedPhotoAccess = useCallback(
    (cacheKey: string) => {
      resetGovernedPhotoAccess(cacheKey);
    },
    [resetGovernedPhotoAccess],
  );

  const handleOpenGovernedPhoto = useCallback(
    (cacheKey: string) => {
      const url = resolvedGovernedPhotoUrls[cacheKey];
      if (!url) {
        toast.error("A foto governada ainda não está disponível.");
        return;
      }

      openUrlInNewTab(url);
    },
    [resolvedGovernedPhotoUrls],
  );

  const openStoredPdf = async (mode: "open" | "print" = "open") => {
    if (!activeChecklistId) {
      return false;
    }

    if (resolvedPdfAccessState === "ready" && resolvedPdfAccessUrl) {
      if (mode === "print") {
        openPdfForPrint(resolvedPdfAccessUrl, () => {
          toast.info(
            "Pop-up bloqueado. Abrimos o PDF final na mesma aba para impressão.",
          );
        });
      } else {
        openUrlInNewTab(resolvedPdfAccessUrl);
      }
      return true;
    }

    return refreshGovernedPdfAccess(activeChecklistId, { openMode: mode });
  };

  const handlePrint = async () => {
    if (isFinalized) {
      await openStoredPdf("print");
      return;
    }

    window.print();
  };

  const handleOpenSignature = async () => {
    if (!canManageSignatures) {
      toast.error("Você não possui permissão para registrar assinaturas.");
      return;
    }

    if (!selectedInspectorId) {
      toast.error("Selecione o inspetor antes de assinar.");
      return;
    }

    if (!selectedSiteId) {
      toast.error("Selecione a obra/setor antes de assinar.");
      return;
    }

    if (isFinalized) {
      toast.info(
        "Checklist já finalizado. O PDF emitido está bloqueado para edição.",
      );
      return;
    }

    const persistedChecklist = await ensureChecklistPersisted();
    const resolvedChecklistId = persistedChecklist?.id || activeChecklistId;
    if (!resolvedChecklistId) {
      return;
    }

    const inspector =
      users.find((u) => u.id === selectedInspectorId) || user || null;
    setCurrentSigningUser(inspector);
    setIsSignatureModalOpen(true);
  };

  const handleOpenEmail = async () => {
    const persistedChecklist = await ensureChecklistPersisted();
    const resolvedChecklistId = persistedChecklist?.id || activeChecklistId;
    if (!resolvedChecklistId) {
      return;
    }

    // Use governed access (pdf_file_key may be hidden); no need for full latestChecklist
    const pdfAccess = await checklistsService.getPdfAccess(resolvedChecklistId);
    if (!pdfAccess.hasFinalPdf) {
      toast.info(
        pdfAccess.message || "Emita o PDF final antes de enviar este checklist por e-mail.",
      );
      return;
    }
    setEmailModalOpen(true);
  };

  const handleSendEmail = async () => {
    if (!emailTo) {
      toast.error("Digite um email.");
      return;
    }
    try {
      setSendingEmail(true);
      const resolvedChecklistId = activeChecklistId;
      if (resolvedChecklistId) {
        // Use governed access (pdf_file_key may be hidden in responses)
        const pdfAccess = await checklistsService.getPdfAccess(resolvedChecklistId);
        if (!pdfAccess.hasFinalPdf) {
          throw new Error(pdfAccess.message || "Checklist sem PDF final governado.");
        }
        const result = await checklistsService.sendEmail(
          resolvedChecklistId,
          emailTo,
        );
        toast.success(result.message);
        setEmailModalOpen(false);
      }
    } catch (error) {
      logger.error("Erro ao enviar email:", error);
      const message = (
        error as
          | { response?: { data?: { message?: string | string[] } } }
          | undefined
      )?.response?.data?.message;
      toast.error(
        Array.isArray(message)
          ? message.join(" ")
          : message || "Erro ao enviar email.",
      );
    } finally {
      setSendingEmail(false);
    }
  };

  const handleFinalizeChecklist = async () => {
    if (isTemplateMode) {
      return;
    }

    if (isFinalized) {
      await openStoredPdf();
      return;
    }

    if (!hasAnySignature) {
      toast.error(
        "Adicione ao menos uma assinatura antes de emitir o PDF final.",
      );
      return;
    }

    const persistedChecklist = await ensureChecklistPersisted();
    const resolvedChecklistId = persistedChecklist?.id || activeChecklistId;
    if (!resolvedChecklistId) {
      return;
    }

    try {
      setFinalizingPdf(true);
      const latestChecklist =
        await checklistsService.findOne(resolvedChecklistId);
      const signatures =
        await signaturesService.findByChecklist(resolvedChecklistId);
      const [{ generateChecklistPdf }, { base64ToPdfFile }] = await Promise.all([
        import("@/lib/pdf/checklistGenerator"),
        import("@/lib/pdf/pdfFile"),
      ]);
      const generatedPdf = (await generateChecklistPdf(
        latestChecklist,
        signatures,
        {
          save: false,
          output: "base64",
          draftWatermark: false,
        },
      )) as { base64: string; filename: string } | undefined;
      if (!generatedPdf?.base64) {
        throw new Error("Falha ao gerar o PDF oficial do checklist.");
      }
      const pdfFile = base64ToPdfFile(
        generatedPdf.base64,
        generatedPdf.filename || `checklist-${resolvedChecklistId}.pdf`,
      );
      await checklistsService.attachFile(resolvedChecklistId, pdfFile);
      const refreshedChecklist =
        await checklistsService.findOne(resolvedChecklistId);
      setCurrentChecklist(refreshedChecklist);
      setCurrentChecklistId(refreshedChecklist.id);
      setIsOfflineQueued(false);
      toast.success(
        "PDF final emitido e salvo no armazenamento semanal do checklist.",
      );
      await refreshGovernedPdfAccess(resolvedChecklistId, { openMode: "open" });
    } catch (error) {
      logger.error("Erro ao emitir PDF final do checklist:", error);
      toast.error("Não foi possível emitir o PDF final deste checklist.");
    } finally {
      setFinalizingPdf(false);
    }
  };

  return (
    <div
      className={`ds-form-page mx-auto w-full max-w-[min(96vw,1880px)] print:max-w-none print:p-0 ${isFieldMode ? "pb-28" : ""}`}
    >
      {fetching ? (
        <div className="mb-6 rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)] print:hidden">
          <InlineLoadingState
            label={id ? "Carregando checklist..." : "Preparando checklist..."}
          />
        </div>
      ) : null}

      <div className="mb-6 print:hidden">
        <PageHeader
          eyebrow={isTemplateMode ? "Modelos de checklist" : "Checklist operacional"}
          title={
            isTemplateMode
              ? id
                ? "Editar modelo"
                : "Novo modelo"
              : id
                ? "Editar checklist"
                : "Novo checklist"
          }
          description={
            isTemplateMode
              ? "Defina a estrutura padrão, tópicos e itens reutilizáveis do checklist."
              : "Preencha dados de verificação, execução e evidências em um fluxo único."
          }
          icon={
            <Link
              href={
                isTemplateMode
                  ? "/dashboard/checklist-models"
                  : "/dashboard/checklists"
              }
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-sm)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]/24"
              aria-label={
                isTemplateMode
                  ? "Voltar para os modelos de checklist"
                  : "Voltar para a lista de checklists"
              }
              title="Voltar"
            >
              <ArrowLeft className="h-5 w-5 text-[var(--ds-color-text-secondary)]" />
            </Link>
          }
          actions={
            <div className="flex flex-wrap gap-2">
              <StatusPill tone={isTemplateMode ? "primary" : "info"}>
                {isTemplateMode ? "Modelo" : "Checklist"}
              </StatusPill>
              <StatusPill tone={id ? "warning" : "success"}>
                {id ? "Edição" : "Novo cadastro"}
              </StatusPill>
              {isFieldMode ? <StatusPill tone="success">Modo campo</StatusPill> : null}
            </div>
          }
        />
        <div
          className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--ds-color-text-muted)]"
          aria-live="polite"
        >
          <span>
            {draftSavedAt
              ? `Rascunho salvo às ${new Date(draftSavedAt).toLocaleTimeString("pt-BR")}`
              : "Rascunho salvo automaticamente"}
          </span>
          {openNcWithSophieHref && canManageNc ? (
            <Link
              href={openNcWithSophieHref}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] px-2.5 py-1 font-semibold text-[var(--ds-color-warning)] motion-safe:transition-colors hover:border-[var(--ds-color-warning)]/50"
            >
              <Bot className="h-3.5 w-3.5" />
              Abrir NC com SOPHIE
            </Link>
          ) : null}
          {activeChecklistId && canManageNc ? (
            <Link
              href={`/dashboard/nonconformities/new?checklist_id=${activeChecklistId}&title=${encodeURIComponent(tituloValue || "Não conformidade de checklist")}`}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-2.5 py-1 font-semibold text-[var(--ds-color-danger)] motion-safe:transition-colors hover:border-[var(--ds-color-danger)]/50"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Criar NC manual
            </Link>
          ) : null}
          {isTemplateMode ? (
            <span className="rounded-full bg-[var(--ds-color-primary-subtle)] px-2 py-0.5 text-[var(--ds-color-action-primary)]">
              Versão local v{templateLocalVersion}
            </span>
          ) : null}
          {!id ? (
            <button
              type="button"
              onClick={handleClearDraft}
              className="underline decoration-dotted underline-offset-2 hover:text-[var(--ds-color-text-primary)]"
            >
              Limpar rascunho
            </button>
          ) : null}
        </div>
      </div>

      {isFieldMode ? (
        <div
          className={`${panelClassName} mb-6 border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-5 print:hidden`}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-success)]">
                Modo campo
              </p>
              <h2 className="mt-2 text-lg font-semibold text-[var(--ds-color-text-primary)]">
                Checklist rápido para celular
              </h2>
              <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                Fluxo com botões maiores, câmera pronta e fila offline para uso
                em obra, rua e áreas industriais.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center md:w-[260px]">
              <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-success-border)]/30 bg-[var(--ds-color-surface-base)]/35 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-muted)]">
                  Câmera
                </p>
                <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">Pronta</p>
              </div>
              <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-success-border)]/30 bg-[var(--ds-color-surface-base)]/35 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-muted)]">
                  Fila
                </p>
                <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  Automática
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {isFinalized ? (
        <div
          className={`${panelClassName} mb-6 border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-5 print:hidden`}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="flex items-start gap-3">
              <CheckCircle className="mt-0.5 h-5 w-5 text-[var(--ds-color-success)]" />
              <div>
                <p className="text-sm font-semibold text-[var(--ds-color-success-fg)]">
                  PDF final emitido e salvo no armazenamento
                </p>
                <p className="mt-1 text-sm text-[var(--ds-color-success)]">
                  Este checklist já entrou no storage semanal e agora está
                  bloqueado para edição.
                </p>
                <p
                  className={`mt-2 text-xs font-medium ${
                    resolvedPdfAccessState === "error"
                      ? "text-[var(--ds-color-danger)]"
                      : resolvedPdfAccessState === "loading"
                        ? "text-[var(--ds-color-warning)]"
                        : "text-[var(--ds-color-text-secondary)]"
                  }`}
                >
                  {resolvedPdfAccessState === "loading"
                    ? "Carregando acesso ao PDF final..."
                    : resolvedPdfAccessState === "error"
                      ? resolvedPdfAccessMessage ||
                        "Acesso governado do PDF final indisponível."
                      : "Acesso governado do PDF final pronto."}
                </p>
                {currentChecklist?.pdf_folder_path ? (
                  <p className="mt-2 text-xs text-[var(--ds-color-text-secondary)]">
                    Pasta: {currentChecklist.pdf_folder_path}
                  </p>
                ) : null}
              </div>
            </div>
            <Button
              type="button"
              onClick={() => void openStoredPdf()}
              variant="outline"
              className="gap-2"
              loading={resolvedPdfAccessState === "loading"}
            >
              <Printer className="h-4 w-4" />
              {resolvedPdfAccessState === "error"
                ? "Recarregar acesso"
                : "Abrir PDF final"}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Cabeçalho de Impressão */}
      <div className="hidden print:mb-8 print:block">
        <div className="border-b border-[var(--ds-color-border-subtle)] pb-4 text-center">
          <h1 className="text-2xl font-bold text-[var(--ds-color-text-primary)]">
            SGS
          </h1>
          <h2 className="text-xl text-[var(--ds-color-text-secondary)]">
            {tituloValue}
          </h2>
          <p className="text-sm text-[var(--ds-color-text-muted)]">
            Data: {new Date().toLocaleDateString("pt-BR")} | ID:{" "}
            {currentChecklistId || id || "Novo"}
          </p>
        </div>
      </div>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="space-y-6 print:space-y-4"
      >
        <fieldset
          disabled={isFinalized}
          className={`space-y-6 ${isFinalized ? "opacity-75" : ""}`}
        >
          {/* Dados Principais */}
          <div className={`${panelClassName} p-6`}>
            <h2 className="mb-4 text-lg font-semibold text-[var(--ds-color-text-primary)]">
              Informações
            </h2>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {/* Título */}
              <div className="md:col-span-2">
                <label
                  htmlFor="checklist-form-titulo"
                  className={labelClassName}
                >
                  Título do Checklist
                </label>
                <input
                  id="checklist-form-titulo"
                  {...register("titulo")}
                  aria-invalid={errors.titulo ? "true" : undefined}
                  className={fieldClassName}
                  placeholder="Ex: Checklist de Furadeira"
                />
                {errors.titulo && (
                  <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                    {errors.titulo.message}
                  </p>
                )}
              </div>

              {/* Empresa */}
              <div>
                <label
                  htmlFor="checklist-form-company-id"
                  className={labelClassName}
                >
                  Empresa
                </label>
                <select
                  id="checklist-form-company-id"
                  {...register("company_id", {
                    onChange: (e) => {
                      const value = e.target.value;
                      setValue("company_id", value);
                      setValue("site_id", "");
                      setValue("inspetor_id", "");
                    },
                  })}
                  aria-invalid={errors.company_id ? "true" : undefined}
                  className={fieldClassName}
                >
                  <option value="">Selecione uma empresa</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.razao_social}
                    </option>
                  ))}
                </select>
                {errors.company_id && (
                  <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                    {errors.company_id.message}
                  </p>
                )}
              </div>
              {/* Data */}
              <div>
                <label htmlFor="checklist-form-data" className={labelClassName}>
                  Data
                </label>
                <input
                  id="checklist-form-data"
                  type="date"
                  {...register("data")}
                  aria-invalid={errors.data ? "true" : undefined}
                  className={fieldClassName}
                />
                {errors.data && (
                  <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                    {errors.data.message}
                  </p>
                )}
              </div>
              {/* Obra/Setor */}
              <div>
                <label
                  htmlFor="checklist-form-site-id"
                  className={labelClassName}
                >
                  Obra/Setor
                </label>
                <select
                  id="checklist-form-site-id"
                  {...register("site_id")}
                  disabled={!selectedCompanyId}
                  aria-label="Obra ou setor do checklist"
                  className={`${fieldClassName} disabled:bg-[var(--ds-color-surface-muted)]/32`}
                >
                  <option value="">
                    {selectedCompanyId
                      ? "Selecione uma obra"
                      : "Selecione uma empresa primeiro"}
                  </option>
                  {filteredSites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.nome}
                    </option>
                  ))}
                </select>
                {errors.site_id && (
                  <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                    {errors.site_id.message}
                  </p>
                )}
              </div>
              {/* Inspetor */}
              <div>
                <label
                  htmlFor="checklist-form-inspetor-id"
                  className={labelClassName}
                >
                  Inspetor
                </label>
                <select
                  id="checklist-form-inspetor-id"
                  {...register("inspetor_id")}
                  disabled={!selectedCompanyId}
                  aria-label="Inspetor do checklist"
                  className={`${fieldClassName} disabled:bg-[var(--ds-color-surface-muted)]/32`}
                >
                  <option value="">
                    {selectedCompanyId
                      ? "Selecione um inspetor"
                      : "Selecione uma empresa primeiro"}
                  </option>
                  {filteredInspectors.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nome}
                    </option>
                  ))}
                </select>
                {errors.inspetor_id && (
                  <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                    {errors.inspetor_id.message}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="checklist-form-categoria"
                  className={labelClassName}
                >
                  Categoria
                </label>
                <select
                  id="checklist-form-categoria"
                  {...register("categoria")}
                  aria-label="Categoria do checklist"
                  className={fieldClassName}
                >
                  {checklistCategoryOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-[var(--ds-color-text-muted)]">
                  {
                    checklistCategoryOptions.find(
                      (option) => option.value === watch("categoria"),
                    )?.helper
                  }
                </p>
              </div>

              <div className="md:col-span-2">
                <p className={labelClassName}>Modo do Checklist</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleStructureModeChange("machines_equipment")}
                    aria-pressed={isMachinesEquipmentMode}
                    className={`${conditionalToggleClassName} ${
                      isMachinesEquipmentMode
                        ? "border-[var(--ds-color-primary-border)] bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-action-primary)]"
                        : "border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]"
                    }`}
                  >
                    Máquinas e Equipamentos
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStructureModeChange("operational")}
                    aria-pressed={isOperationalMode}
                    className={`${conditionalToggleClassName} ${
                      isOperationalMode
                        ? "border-[var(--ds-color-primary-border)] bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-action-primary)]"
                        : "border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]"
                    }`}
                  >
                    Operacional
                  </button>
                </div>
                <p className="mt-2 text-xs text-[var(--ds-color-text-muted)]">
                  {isMachinesEquipmentMode
                    ? "Use para inspeções de ferramenta, máquina e equipamento com regras operacionais."
                    : "Use para modelos normativos e operacionais, como NR24 e NR10."}
                </p>
              </div>

              {isMachinesEquipmentMode ? (
                <>
                  <div className="md:col-span-2">
                    <p className={labelClassName}>Tipo do ativo</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setChecklistMode("tool");
                          setValue("maquina", "");
                        }}
                        aria-pressed={checklistMode === "tool"}
                        className={`${conditionalToggleClassName} ${
                          checklistMode === "tool"
                            ? "border-[var(--ds-color-primary-border)] bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-action-primary)]"
                            : "border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]"
                        }`}
                      >
                        Ferramenta
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setChecklistMode("machine");
                          setValue("equipamento", "");
                        }}
                        aria-pressed={checklistMode === "machine"}
                        className={`${conditionalToggleClassName} ${
                          checklistMode === "machine"
                            ? "border-[var(--ds-color-primary-border)] bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-action-primary)]"
                            : "border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]"
                        }`}
                      >
                        Máquina
                      </button>
                    </div>
                  </div>

                  {checklistMode === "tool" ? (
                    <div className="md:col-span-2">
                      <label
                        htmlFor="checklist-form-equipamento"
                        className={labelClassName}
                      >
                        Equipamento *
                      </label>
                      <input
                        id="checklist-form-equipamento"
                        {...register("equipamento")}
                        className={fieldClassName}
                        placeholder="Ex: Furadeira, escada, detector de gás..."
                      />
                    </div>
                  ) : (
                    <div className="md:col-span-2">
                      <label
                        htmlFor="checklist-form-maquina"
                        className={labelClassName}
                      >
                        Máquina *
                      </label>
                      <input
                        id="checklist-form-maquina"
                        {...register("maquina")}
                        className={fieldClassName}
                        placeholder="Ex: Retroescavadeira, prensa, guindaste..."
                      />
                    </div>
                  )}
                </>
              ) : (
                <div className="md:col-span-2">
                  <p className={`${labelClassName} mb-2`}>Referência operacional</p>
                  <p className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/24 px-4 py-3 text-sm text-[var(--ds-color-text-secondary)]">
                    Para NR24, NR10 e outros checklists normativos, use o título como referência principal.
                  </p>
                </div>
              )}
            </div>
            {isMachinesEquipmentMode ? (
            <div className="mt-6">
              <label
                htmlFor="checklist-form-foto-equipamento"
                className={labelClassName}
              >
                Foto do Equipamento
              </label>
              <input
                id="checklist-form-foto-equipamento"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                onChange={handlePhotoChange}
                disabled={processingEquipmentPhoto}
                aria-busy={processingEquipmentPhoto}
                className="w-full text-sm text-[var(--ds-color-text-muted)] file:mr-4 file:rounded-[var(--ds-radius-md)] file:border-0 file:bg-[var(--ds-color-surface-muted)] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-[var(--ds-color-text-secondary)] hover:file:bg-[var(--ds-color-primary-subtle)]/45"
                title="Foto do equipamento"
                aria-label="Foto do equipamento"
              />
              {processingEquipmentPhoto ? (
                <p className="mt-2 text-xs text-[var(--color-text-secondary)]" role="status">
                  Otimizando foto para uso mobile…
                </p>
              ) : null}
              {equipmentPhotoValue && (
                <div className="relative mt-4">
                  <Image
                    src={
                      resolveChecklistPhotoSrc(equipmentPhotoValue) ||
                      "/placeholder-image.png"
                    }
                    alt="Foto do Equipamento"
                    width={160}
                    height={160}
                    className="h-40 w-auto rounded-lg border p-2 object-cover"
                    unoptimized
                  />
                  {isGovernedChecklistPhotoReference(equipmentPhotoValue) ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`text-xs font-medium ${
                          resolvedGovernedPhotoStates.equipment === "error"
                            ? "text-[var(--ds-color-danger)]"
                            : resolvedGovernedPhotoStates.equipment === "loading"
                              ? "text-[var(--ds-color-warning)]"
                              : "text-[var(--ds-color-text-muted)]"
                        }`}
                      >
                        {resolvedGovernedPhotoStates.equipment === "loading"
                          ? "Carregando acesso governado..."
                          : resolvedGovernedPhotoStates.equipment === "error"
                            ? "Acesso governado indisponível."
                            : "Foto armazenada em modo governado."}
                      </span>
                      {resolvedGovernedPhotoUrls.equipment ? (
                        <button
                          type="button"
                          onClick={() => handleOpenGovernedPhoto("equipment")}
                          className="rounded-[var(--ds-radius-sm)] border border-[var(--ds-color-border-default)] px-2 py-1 text-xs font-semibold text-[var(--ds-color-text-secondary)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]/24"
                        >
                          Abrir foto
                        </button>
                      ) : null}
                      {resolvedGovernedPhotoStates.equipment === "error" ? (
                        <button
                          type="button"
                          onClick={() =>
                            handleRetryGovernedPhotoAccess("equipment")
                          }
                          className="rounded-[var(--ds-radius-sm)] border border-[var(--ds-color-warning-border)] px-2 py-1 text-xs font-semibold text-[var(--ds-color-warning)] motion-safe:transition-colors hover:bg-[var(--ds-color-warning-subtle)]/36"
                        >
                          Recarregar
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            ) : null}
          </div>

          {/* Itens do Checklist */}
          <div className={`${panelClassName} p-6`}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--ds-color-text-primary)]">
                Estrutura do Checklist
              </h2>
              <div className="flex items-center gap-2">
                {isTemplateMode && isAiEnabled() && isMachinesEquipmentMode && (
                  <Button
                    type="button"
                    onClick={handleAiGenerate}
                    variant="secondary"
                    loading={aiGenerating}
                    className="gap-2"
                  >
                    <Sparkles className="h-4 w-4" />
                    Gerar com IA
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={handleAddTopic}
                  variant="outline"
                  className="gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Novo tópico
                </Button>
              </div>
            </div>

            <div className="space-y-5">
              {isMachinesEquipmentMode ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-color-text-muted)]">
                    Barreiras
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[var(--ds-color-text-primary)]">
                    {barrierOverview.total}
                  </p>
                </div>
                <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)]/40 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-color-success)]">
                    Íntegras
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[var(--ds-color-success)]">
                    {barrierOverview.integras}
                  </p>
                </div>
                <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)]/40 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-color-warning)]">
                    Degradadas
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[var(--ds-color-warning)]">
                    {barrierOverview.degradadas}
                  </p>
                </div>
                <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)]/40 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-color-danger)]">
                    Rompidas
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[var(--ds-color-danger)]">
                    {barrierOverview.rompidas}
                  </p>
                </div>
                <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-surface-base)] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-color-text-muted)]">
                    Bloqueios
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[var(--ds-color-text-primary)]">
                    {barrierOverview.bloqueios}
                  </p>
                </div>
              </div>
              ) : null}

              {groupedItemsByTopic.map(
                ({ topico, topicIndex, items, barrierSummary }) => (
                <div
                  key={topico.id || `topico-${topicIndex}`}
                  className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/16 p-4"
                >
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-muted)]">
                        Tópico principal
                      </label>
                      <input
                        {...register(`topicos.${topicIndex}.titulo`)}
                        onBlur={() => handleTopicTitleBlur(topicIndex)}
                        className={fieldClassName}
                        placeholder="Ex: VERIFICAÇÃO DA ÁREA DE VIVÊNCIA"
                      />
                      {isMachinesEquipmentMode ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex rounded-[var(--ds-radius-sm)] px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                            barrierSummary.status_barreira === "rompida"
                              ? "bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger)]"
                              : barrierSummary.status_barreira === "degradada"
                                ? "bg-[var(--ds-color-warning-subtle)] text-[var(--ds-color-warning)]"
                                : "bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success)]"
                          }`}
                        >
                          {barrierSummary.status_barreira === "rompida"
                            ? "Barreira rompida"
                            : barrierSummary.status_barreira === "degradada"
                              ? "Barreira degradada"
                              : "Barreira íntegra"}
                        </span>
                        <span className="text-xs text-[var(--ds-color-text-muted)]">
                          Rompidos: {barrierSummary.controles_rompidos}
                        </span>
                        <span className="text-xs text-[var(--ds-color-text-muted)]">
                          Degradados: {barrierSummary.controles_degradados}
                        </span>
                        <span className="text-xs text-[var(--ds-color-text-muted)]">
                          Pendentes: {barrierSummary.controles_pendentes}
                        </span>
                        {barrierSummary.bloqueia_operacao ? (
                          <span className="inline-flex rounded-[var(--ds-radius-sm)] bg-[var(--ds-color-danger-subtle)] px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-color-danger)]">
                            Bloqueia operação
                          </span>
                        ) : null}
                      </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveTopic(topicIndex)}
                      className="inline-flex items-center justify-center rounded-[var(--ds-radius-md)] border border-[var(--ds-color-danger-border)] px-3 py-2 text-xs font-semibold text-[var(--ds-color-danger)] motion-safe:transition-colors hover:bg-[var(--ds-color-danger-subtle)]"
                    >
                      Remover tópico
                    </button>
                  </div>

                  {isTemplateMode && isMachinesEquipmentMode ? (
                    <div className="mb-4 grid grid-cols-1 gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-3 md:grid-cols-4">
                      <div className="md:col-span-2">
                        <label className={labelClassName}>Descrição da barreira</label>
                        <input
                          {...register(`topicos.${topicIndex}.descricao`)}
                          className={fieldClassName}
                          placeholder="Contexto operacional da barreira"
                        />
                      </div>
                      <div>
                        <label className={labelClassName}>Tipo de barreira</label>
                        <select
                          {...register(`topicos.${topicIndex}.barreira_tipo`)}
                          className={fieldClassName}
                        >
                          <option value="procedimental">Procedimental</option>
                          <option value="humana">Humana</option>
                          <option value="fisica">Física</option>
                          <option value="documental">Documental</option>
                          <option value="isolamento">Isolamento</option>
                          <option value="organizacional">Organizacional</option>
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelClassName}>Peso</label>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            {...register(`topicos.${topicIndex}.peso_barreira`, {
                              valueAsNumber: true,
                            })}
                            className={fieldClassName}
                          />
                        </div>
                        <div>
                          <label className={labelClassName}>Ruptura</label>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            {...register(`topicos.${topicIndex}.limite_ruptura`, {
                              valueAsNumber: true,
                            })}
                            className={fieldClassName}
                          />
                        </div>
                      </div>
                    </div>
                  ) : isMachinesEquipmentMode && topico.descricao ? (
                    <p className="mb-4 text-sm text-[var(--ds-color-text-secondary)]">
                      {topico.descricao}
                    </p>
                  ) : null}

                  <div className="space-y-3 border-l-2 border-[var(--ds-color-border-subtle)] pl-4">
                    {items.map(({ field, item, index }) =>
                      isTemplateMode ? (
                        <TemplateItem
                          key={field._formId}
                          item={item as ChecklistItemForm}
                          index={index}
                          structureMode={structureMode}
                          register={register}
                          watch={watch}
                          setValue={setValue}
                          remove={handleRemoveItem}
                        />
                      ) : (
                        <ExecutionItem
                          key={field._formId}
                          item={item as ChecklistItemForm}
                          index={index}
                          register={register}
                          watch={watch}
                          setValue={setValue}
                          getPhotoValues={(itemIndex) =>
                            getValues(`itens.${itemIndex}.fotos`) || []
                          }
                          onUploadPhotos={handleUploadItemPhotos}
                          resolvePhotoSrc={resolveChecklistPhotoSrc}
                          photoAccessStates={resolvedGovernedPhotoStates}
                          onRetryGovernedPhotoAccess={(
                            itemIndex,
                            photoIndex,
                          ) =>
                            handleRetryGovernedPhotoAccess(
                              `item-${itemIndex}-${photoIndex}`,
                            )
                          }
                          onOpenGovernedPhoto={(itemIndex, photoIndex) =>
                            handleOpenGovernedPhoto(
                              `item-${itemIndex}-${photoIndex}`,
                            )
                          }
                          onRemove={handleRemoveItem}
                        />
                      ),
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        handleAddItemToTopic(topico.id || createChecklistTopicId())
                      }
                      className="flex w-full items-center justify-center gap-2 rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-color-border-default)] py-2 text-sm font-medium text-[var(--ds-color-text-secondary)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]/26 hover:text-[var(--ds-color-text-primary)]"
                    >
                      <Plus className="h-4 w-4" />
                      Adicionar item neste tópico
                    </button>
                  </div>
                </div>
              ),
              )}
            </div>
          </div>

          {/* Assinatura */}
          {!isTemplateMode && (
            <div className={`${panelClassName} p-6`}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-[var(--ds-color-text-primary)]">
                  Assinatura
                </h2>
                <Button
                  type="button"
                  onClick={handleOpenSignature}
                  variant="outline"
                  className="gap-2"
                  disabled={!canManageSignatures || isOfflineQueued}
                >
                  <PenTool className="h-4 w-4" />
                  {signatures[selectedInspectorId || ""]
                    ? "Reassinar"
                    : "Assinar Agora"}
                </Button>
              </div>
              <p className="mb-3 text-sm text-[var(--ds-color-text-secondary)]">
                Inspetor selecionado:{" "}
                {users.find((u) => u.id === selectedInspectorId)?.nome || "-"}
              </p>

              {Object.keys(signatures).length > 0 ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(signatures).map(([userId, sig]) => (
                    <div
                      key={userId}
                      className="flex items-center gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-3"
                    >
                      <CheckCircle className="h-5 w-5 text-[var(--ds-color-success)]" />
                      <div>
                        <p className="text-sm font-medium text-[var(--ds-color-success-fg)]">
                          Assinado Digitalmente
                        </p>
                        <p className="text-xs text-[var(--ds-color-success)]">
                          {safeToLocaleString(sig.signedAt, undefined, undefined, "Data não disponível")}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm italic text-[var(--ds-color-text-muted)]">
                  Nenhuma assinatura ainda.
                </p>
              )}
              <p className="mt-4 text-xs text-[var(--ds-color-text-muted)]">
                Depois da assinatura, use <strong>Emitir PDF final</strong> para
                salvar este checklist na pasta semanal da empresa e bloquear
                novas edições.
              </p>
            </div>
          )}
        </fieldset>

        {/* Rodapé de Ações */}
        <div
          className={`ds-mobile-form-actions print:hidden ${isFieldMode ? "sticky bottom-4 z-10 rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-strong)] bg-[var(--ds-color-surface-elevated)]/95 p-4 shadow-[var(--ds-shadow-lg)] backdrop-blur" : "flex items-center justify-end gap-3"}`}
        >
          {isFieldMode ? (
            <div className="mb-3">
              <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                Pronto para salvar em campo
              </p>
              <p className="text-xs text-[var(--ds-color-text-muted)]">
                Se a internet cair, o checklist fica na fila local e sincroniza
                automaticamente depois.
              </p>
            </div>
          ) : null}
          <div
            className={
              isFieldMode
                ? "grid grid-cols-2 gap-3"
                : "flex items-center justify-end gap-3"
            }
          >
            <Link
              href={
                isTemplateMode
                  ? "/dashboard/checklist-models"
                  : "/dashboard/checklists"
              }
              className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] px-4 py-2 text-sm font-medium text-[var(--ds-color-text-secondary)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]/24"
            >
              Cancelar
            </Link>

            <Button
              type="submit"
              loading={loading}
              className="gap-2"
              size="lg"
              disabled={
                isFinalized || (!canManageChecklists && !isTemplateFillFlow)
              }
            >
              <Save className="h-4 w-4" />
              {isTemplateMode
                ? "Salvar Modelo"
                : isFieldMode
                  ? "Salvar em campo"
                  : isFinalized
                    ? "Checklist finalizado"
                    : "Salvar Checklist"}
            </Button>

            {!isTemplateMode && !isFieldMode && (
              <>
                <Button
                  type="button"
                  onClick={handleFinalizeChecklist}
                  variant={isFinalized ? "outline" : "secondary"}
                  className="gap-2"
                  loading={finalizingPdf || resolvedPdfAccessState === "loading"}
                  disabled={loading || isOfflineQueued || !canManageChecklists}
                >
                  <CheckCircle className="h-4 w-4" />
                  {isFinalized
                    ? resolvedPdfAccessState === "error"
                      ? "Recarregar PDF final"
                      : "Abrir PDF final"
                    : "Emitir PDF final"}
                </Button>
                <Button
                  type="button"
                  onClick={handleOpenEmail}
                  variant="outline"
                  className="gap-2"
                  disabled={isOfflineQueued || !canManageChecklists}
                >
                  <Send className="h-4 w-4" />
                  Enviar por Email
                </Button>
                <Button
                  type="button"
                  onClick={handlePrint}
                  variant="outline"
                  className="gap-2"
                >
                  <Printer className="h-4 w-4" />
                  Imprimir
                </Button>
              </>
            )}
          </div>
        </div>
      </form>

      {/* Modal de Assinatura */}
      <SignatureModal
        isOpen={isSignatureModalOpen}
        onClose={() => setIsSignatureModalOpen(false)}
        onSave={async (signatureData, type) => {
          const activeId = activeChecklistId;
          if (activeId && currentSigningUser) {
            try {
              const createdSignature = await signaturesService.create({
                document_id: activeId,
                document_type: "CHECKLIST",
                user_id: currentSigningUser.id,
                signature_data: signatureData,
                type,
              });
              setSignatures((prev) => ({
                ...prev,
                [currentSigningUser.id]: {
                  signatureData:
                    createdSignature.signature_data || signatureData,
                  type: createdSignature.type || type,
                  signedAt:
                    createdSignature.signed_at ||
                    createdSignature.created_at ||
                    new Date().toISOString(),
                },
              }));
              toast.success("Assinatura salva com sucesso!");
              toast.info(
                "Assinatura registrada. Agora emita o PDF final para salvar o checklist no armazenamento semanal.",
              );
              setIsSignatureModalOpen(false);
            } catch (error) {
              logger.error("Erro ao salvar assinatura:", error);
              toast.error("Erro ao salvar assinatura.");
            }
          } else {
            toast.error("Salve o checklist antes de assinar.");
            setIsSignatureModalOpen(false);
          }
        }}
        userName={currentSigningUser?.nome || "Inspetor"}
      />

      {/* Modal de Email */}
      <ModalFrame
        isOpen={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        shellClassName="max-w-md"
      >
        <ModalHeader
          title="Enviar checklist por e-mail"
          description="Informe o endereço que receberá o PDF do checklist."
          onClose={() => setEmailModalOpen(false)}
        />
        <ModalBody>
          <label
            htmlFor="checklist-form-email-destino"
            className={labelClassName}
          >
            E-mail de destino
          </label>
          <input
            id="checklist-form-email-destino"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={emailTo}
            onChange={(e) => setEmailTo(e.target.value)}
            placeholder="exemplo@empresa.com"
            className={fieldClassName}
            autoFocus
          />
        </ModalBody>
        <ModalFooter>
          <Button
            variant="secondary"
            onClick={() => setEmailModalOpen(false)}
            disabled={sendingEmail}
          >
            Cancelar
          </Button>
          <Button
            onClick={handleSendEmail}
            loading={sendingEmail}
            disabled={!emailTo}
            className="gap-2"
          >
            <Send className="h-4 w-4" />
            Enviar
          </Button>
        </ModalFooter>
      </ModalFrame>
    </div>
  );
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}
