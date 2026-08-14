"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ddsService, type Dds, type DdsPerson } from "@/services/ddsService";
import { sitesService, Site } from "@/services/sitesService";
import { useForm } from "react-hook-form";
import type { FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowLeft,
  Save,
  Sparkles,
  BookOpen,
  Loader2,
  Camera,
  Trash2,
  FileText,
  HardHat,
} from "lucide-react";
import Link from "next/link";
import NextImage from "next/image";
import { toast } from "sonner";
import { companiesService, Company } from "@/services/companiesService";
import { aiService } from "@/services/aiService";
import { isAiEnabled } from "@/lib/featureFlags";
import { logger } from "@/lib/logger";
import { SignatureModal } from "../../app/dashboard/checklists/components/SignatureModal";
import { DdsThemeLibraryModal } from "./DdsThemeLibraryModal";
import {
  extractApiErrorMessage,
  getFormErrorMessage,
} from "@/lib/error-handler";
import { selectedTenantStore } from "@/lib/selectedTenantStore";
import { sessionStore } from "@/lib/sessionStore";
import { siteStore } from "@/lib/siteStore";
import { isAdminGeralAccount } from "@/lib/auth-session-state";
import { usePermissions } from "@/hooks/usePermissions";
import { Permission } from '@/lib/permissions';
import { useAiConsent } from "@/hooks/useAiConsent";
import { useDocumentVideos } from "@/hooks/useDocumentVideos";
import { DocumentVideoPanel } from "@/components/document-videos/DocumentVideoPanel";
import { DdsApprovalPanel } from "@/components/dds/DdsApprovalPanel";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/layout";
import { ErrorState, InlineLoadingState } from "@/components/ui/state";
import { StatusPill } from "@/components/ui/status-pill";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { Button } from "@/components/ui/button";
import {
  safeToLocaleDateString,
  toInputDateValue,
} from "@/lib/date/safeFormat";
import { dedupeDdsUsersById } from "@/lib/dds-user-scope";
import { ddsSchema, type DdsFormData } from "@/lib/validation/ddsForm.schema";
import {
  blobToBoundedDataUrl,
  processMobileImages,
} from "@/lib/images/process-mobile-image";

// Importação dinâmica do gerador de PDF — evita incluir jsPDF no bundle inicial
const loadDdsPdfGenerator = () => import("@/lib/pdf/ddsGenerator");

interface DdsFormProps {
  id?: string;
}

type TeamPhotoEvidence = {
  imageData: string;
  capturedAt: string;
  hash: string;
  metadata: TeamPhotoMetadata;
};

type TeamPhotoMetadata = {
  userAgent: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
};

type HistoricalPhotoReference = {
  ddsId: string;
  tema: string;
  data: string;
};

const TEAM_PHOTO_SIGNATURE_PREFIX = "team_photo";
const TEAM_PHOTO_REUSE_JUSTIFICATION_TYPE = "team_photo_reuse_justification";

const inputClassName =
  "mt-1 block w-full rounded-[var(--ds-radius-md)] border bg-[color:var(--component-field-bg-subtle)] px-3 py-2.5 text-sm text-[var(--component-field-text)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]";
const inputErrorClass =
  "border-[var(--ds-color-danger)] focus:border-[var(--ds-color-danger)]";
const inputDefaultClass =
  "border-[var(--ds-color-border-default)] focus:border-[var(--ds-color-action-primary)]";
const inputDisabledClass =
  "bg-[var(--ds-color-surface-muted)] cursor-not-allowed border-[var(--ds-color-border-default)]";
const UUID_LIKE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeDdsTemaFromAi(value: string): string {
  return String(value || "")
    .replace(/[*_`#>\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeDdsConteudoFromAi(value: string): string {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*[-*•]+\s*/, "")
        .replace(/^\s*\d+\.\s*/, "")
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isUuidLike(value?: string | null): value is string {
  return typeof value === "string" && UUID_LIKE_REGEX.test(value.trim());
}

function buildSignatureSnapshot(input: {
  participantIds: string[];
  signatures: Record<string, { data: string; type: string }>;
  teamPhotos: TeamPhotoEvidence[];
  photoReuseJustification: string;
}) {
  const participants = [...input.participantIds].sort();
  const normalizedSignatures = participants.map((participantId) => {
    const signature = input.signatures[participantId];
    return {
      participantId,
      type: signature?.type || "",
      data: signature?.data || "",
    };
  });
  const normalizedPhotos = [...input.teamPhotos]
    .map((photo) => ({
      hash: photo.hash,
      capturedAt: photo.capturedAt,
      imageData: photo.imageData,
      metadata: photo.metadata,
    }))
    .sort((first, second) => first.hash.localeCompare(second.hash));

  return JSON.stringify({
    participants,
    normalizedSignatures,
    normalizedPhotos,
    photoReuseJustification: String(input.photoReuseJustification || "").trim(),
  });
}

function buildDdsSignatureResetReasons(
  currentDds: Dds,
  nextData: DdsFormData,
): string[] {
  const reasons: string[] = [];
  const currentParticipantIds = (currentDds.participants || [])
    .map((participant) => participant.id)
    .sort();
  const nextParticipantIds = [...nextData.participants].sort();

  if (
    JSON.stringify(currentParticipantIds) !== JSON.stringify(nextParticipantIds)
  ) {
    reasons.push("participantes");
  }
  if (nextData.tema !== currentDds.tema) {
    reasons.push("tema");
  }
  if ((nextData.conteudo || "") !== (currentDds.conteudo || "")) {
    reasons.push("conteúdo");
  }
  if (nextData.data !== toInputDateValue(currentDds.data)) {
    reasons.push("data");
  }
  if (nextData.site_id !== currentDds.site_id) {
    reasons.push("site");
  }
  if (nextData.facilitador_id !== currentDds.facilitador_id) {
    reasons.push("facilitador");
  }

  return reasons;
}

// Refactor backlog: quebrar este componente em submódulos menores após estabilização dos patches emergenciais.
export function DdsForm({ id }: DdsFormProps) {
  const { hasPermission } = usePermissions();
  const canViewDds = hasPermission(Permission.CAN_VIEW_DDS);
  const canManageDds = hasPermission(Permission.CAN_MANAGE_DDS);
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefillCompanyIdParam = searchParams.get("company_id") || "";
  const selectedTenantCompanyId = selectedTenantStore.get()?.companyId || null;
  const sessionCompanyId = sessionStore.get()?.companyId || null;
  const isAdminGeral = isAdminGeralAccount(sessionStore.get());
  const prefillCompanyId = isUuidLike(prefillCompanyIdParam)
    ? prefillCompanyIdParam
    : isAdminGeral && isUuidLike(selectedTenantCompanyId)
      ? selectedTenantCompanyId
      : isUuidLike(sessionCompanyId)
        ? sessionCompanyId
        : "";
  const prefillSiteId = searchParams.get("site_id") || "";
  const prefillFacilitatorId =
    searchParams.get("facilitador_id") || searchParams.get("user_id") || "";
  const prefillTitle = searchParams.get("title") || "";
  const prefillDescription = searchParams.get("description") || "";
  const resumeSignatures = searchParams.get("resume_signatures") === "1";
  const resumeVideos = searchParams.get("resume_videos") === "1";
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [isThemeLibraryOpen, setIsThemeLibraryOpen] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const companiesRef = useRef<Company[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<DdsPerson[]>([]);
  const [currentDds, setCurrentDds] = useState<Dds | null>(null);

  // Signature States
  const [isSignatureModalOpen, setIsSignatureModalOpen] = useState(false);
  const [currentSigningUser, setCurrentSigningUser] =
    useState<DdsPerson | null>(null);
  const [signatures, setSignatures] = useState<
    Record<string, { data: string; type: string }>
  >({});
  const [teamPhotos, setTeamPhotos] = useState<TeamPhotoEvidence[]>([]);
  const [historicalPhotoHashes, setHistoricalPhotoHashes] = useState<
    Record<string, HistoricalPhotoReference>
  >({});
  const [photoReuseWarnings, setPhotoReuseWarnings] = useState<
    Record<string, HistoricalPhotoReference>
  >({});
  const [photoReuseJustification, setPhotoReuseJustification] = useState("");
  const [initialSignatureSnapshot, setInitialSignatureSnapshot] = useState<
    string | null
  >(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  /** Gera uma prévia em PDF do DDS salvo e abre em nova aba. */
  const handlePreviewPdf = async () => {
    if (!currentDds?.id) {
      toast.error("Salve o DDS antes de gerar a prévia em PDF.");
      return;
    }
    try {
      setPreviewLoading(true);
      const [signatures, videos] = await Promise.all([
        ddsService.listSignatures(currentDds.id),
        ddsService.listVideoAttachments(currentDds.id),
      ]);
      const { generateDdsPdf } = await loadDdsPdfGenerator();
      const base64 = await generateDdsPdf(
        currentDds,
        signatures,
        videos,
        { save: false, output: "base64", draftWatermark: true },
      );
      if (!base64) throw new Error("Falha ao gerar a prévia do PDF.");
      const blob = new Blob(
        [Uint8Array.from(atob(String(base64)), (c) => c.charCodeAt(0))],
        { type: "application/pdf" },
      );
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast.error("Não foi possível gerar a prévia do PDF.");
      logger.error("handlePreviewPdf:", err);
    } finally {
      setPreviewLoading(false);
    }
  };
  const [confirmResetDialogOpen, setConfirmResetDialogOpen] = useState(false);
  const [pendingResetCallback, setPendingResetCallback] = useState<
    (() => Promise<void>) | null
  >(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    clearErrors,
    watch,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<DdsFormData>({
    resolver: zodResolver(ddsSchema),
    mode: "onBlur",
    reValidateMode: "onBlur",
    defaultValues: {
      tema: prefillTitle,
      conteudo: prefillDescription,
      data: new Date().toISOString().split("T")[0],
      company_id: prefillCompanyId,
      site_id: prefillSiteId,
      facilitador_id: prefillFacilitatorId,
      participants: prefillFacilitatorId ? [prefillFacilitatorId] : [],
    },
  });

  const selectedCompanyId = watch("company_id");
  const selectedSiteId = watch("site_id");
  const filteredSites = sites.filter(
    (site) => site.company_id === selectedCompanyId,
  );
  const filteredUsers = selectedCompanyId
    ? users.filter((user) => user.company_id === selectedCompanyId)
    : [];
  const selectedParticipantIds = watch("participants") || [];
  const ddsReadOnly =
    !canManageDds ||
    Boolean(currentDds?.pdf_file_key) ||
    currentDds?.status === "auditado" ||
    currentDds?.status === "arquivado";
  const ddsReadOnlyMessage = !canManageDds
    ? "Seu perfil possui acesso somente leitura neste módulo."
    : currentDds?.pdf_file_key
    ? "Este DDS já possui PDF final governado e está em modo somente leitura."
    : currentDds?.status === "auditado"
      ? "Este DDS já foi auditado e o fluxo operacional está bloqueado para edição."
      : currentDds?.status === "arquivado"
        ? "Este DDS está arquivado e não aceita novas alterações pelo fluxo comum."
        : null;
  const ddsVideoLocked =
    !id ||
    Boolean(currentDds?.pdf_file_key) ||
    currentDds?.status === "auditado" ||
    currentDds?.status === "arquivado" ||
    Boolean(currentDds?.is_modelo);
  const ddsVideoLockMessage = !id
    ? "Salve o DDS primeiro para habilitar anexos de vídeo."
    : currentDds?.is_modelo
    ? "Modelos de DDS não aceitam vídeos operacionais."
    : currentDds?.pdf_file_key
      ? "O DDS já possui PDF final emitido."
      : currentDds?.status === "auditado"
        ? "O DDS já foi auditado."
    : currentDds?.status === "arquivado"
      ? "O DDS está arquivado."
      : null;

  const formSectionHighlights = [
    {
      step: "01",
      title: "Base do DDS",
      description: "tema, resumo e contexto operacional",
      tone: "primary",
    },
    {
      step: "02",
      title: "Participantes",
      description: "equipe, facilitador e assinaturas",
      tone: "neutral",
    },
    {
      step: "03",
      title: "Evidências",
      description: "foto da equipe e justificativa de reuso",
      tone: "neutral",
    },
    {
      step: "04",
      title: "Aprovação",
      description: "trilha, PDF e fechamento governado",
      tone: "neutral",
    },
  ] as const;

  useEffect(() => {
    if (isAdminGeral) {
      return;
    }

    const tenantFromSession = sessionStore.get()?.companyId || null;
    const selectedTenant = selectedTenantStore.get();

    if (
      selectedTenant?.companyId &&
      (!tenantFromSession || selectedTenant.companyId !== tenantFromSession)
    ) {
      selectedTenantStore.clear();
    }

    if (
      isUuidLike(tenantFromSession) &&
      selectedCompanyId !== tenantFromSession
    ) {
      setValue("company_id", tenantFromSession, {
        shouldValidate: true,
      });
    }
  }, [isAdminGeral, selectedCompanyId, setValue]);

  // Sincronizar site_id com o siteStore global
  useEffect(() => {
    const activeSite = siteStore.get();
    if (activeSite) {
      const currentSiteId = watch('site_id');
      if (!currentSiteId || currentSiteId !== activeSite.siteId) {
        setValue('site_id', activeSite.siteId, { shouldValidate: false });
      }
    }
  }, [setValue, selectedSiteId, watch]);

  // Inscrição para mudanças de obra
  useEffect(() => {
    const unsubscribe = siteStore.subscribe((site) => {
      if (site) {
        // Se mudou de obra, limpa participantes
        if (selectedSiteId && selectedSiteId !== site.siteId) {
          setValue('participants', [], { shouldValidate: false });
        }
        setValue('site_id', site.siteId, { shouldValidate: false });
      }
    });
    return () => { unsubscribe(); };
  }, [setValue, selectedSiteId]);

  const documentVideos = useDocumentVideos({
    documentId: id,
    enabled: Boolean(id),
    operationKey: `${currentDds?.company_id || selectedCompanyId || "none"}:${id || "new"}`,
    loadVideos: ddsService.listVideoAttachments,
    uploadVideo: ddsService.uploadVideoAttachment,
    removeVideo: ddsService.removeVideoAttachment,
    getVideoAccess: ddsService.getVideoAttachmentAccess,
    labels: {
      loadError: "Não foi possível carregar os vídeos do DDS.",
      uploadSuccess: "Vídeo anexado ao DDS.",
      uploadError: "Não foi possível anexar o vídeo ao DDS.",
      removeSuccess: "Vídeo removido do DDS.",
      removeError: "Não foi possível remover o vídeo do DDS.",
      accessError: "Não foi possível abrir o vídeo do DDS.",
    },
  });

  const { consentGiven, requestConsent, ConsentGate } = useAiConsent();

  const handleAiSuggestion = async () => {
    if (!isAiEnabled()) {
      toast.error("IA desativada neste ambiente.");
      return;
    }

    if (!consentGiven) {
      requestConsent();
      return;
    }

    try {
      setSuggesting(true);
      const result = await aiService.generateDds(undefined, selectedCompanyId);
      const normalizedTema = normalizeDdsTemaFromAi(result.tema);
      const normalizedConteudo = normalizeDdsConteudoFromAi(result.conteudo);

      setValue("tema", normalizedTema, {
        shouldDirty: true,
        shouldTouch: true,
        shouldValidate: true,
      });
      setValue("conteudo", normalizedConteudo, {
        shouldDirty: true,
        shouldTouch: true,
        shouldValidate: true,
      });
      clearErrors(["tema", "conteudo"]);

      toast.success("Sophie sugeriu um tema para o DDS!", {
        description: result.explanation,
        duration: 5000,
      });
    } catch (error) {
      logger.error("Erro na sugestão com Sophie:", error);
      const message = await extractApiErrorMessage(
        error,
        "Não foi possível obter uma sugestão no momento.",
      );
      toast.error(message);
    } finally {
      setSuggesting(false);
    }
  };

  useEffect(() => {
    if (!canViewDds) {
      setFetching(false);
      return;
    }

    async function loadData() {
      try {
        // Dispara todos os fetches independentes em paralelo
        const [companiesResult, ddsResult, signaturesResult] =
          await Promise.allSettled([
            companiesService.findPaginated({ page: 1, limit: 100 }),
            id ? ddsService.findOne(id) : Promise.resolve(null),
            id ? ddsService.listSignatures(id) : Promise.resolve([]),
          ]);

        // Processa empresas
        let companiesData: Company[] = [];
        if (companiesResult.status === "fulfilled") {
          companiesData = companiesResult.value.data;
          if (companiesResult.value.lastPage > 1) {
            toast.warning(
              "A lista de empresas foi limitada aos primeiros 100 registros.",
            );
          }
        }
        // sem permissão para listar empresas — seguir com lista vazia

        const fallbackCompanyId = isUuidLike(prefillCompanyId)
          ? prefillCompanyId
          : undefined;
        if (
          fallbackCompanyId &&
          !companiesData.some((company) => company.id === fallbackCompanyId)
        ) {
          try {
            const fallbackCompany =
              await companiesService.findOne(fallbackCompanyId);
            companiesData = [fallbackCompany, ...companiesData];
          } catch {
            // ignora fallback sem permissão
          }
        }

        if (
          !id &&
          !prefillCompanyId &&
          companiesData.length === 1 &&
          companiesData[0]?.id
        ) {
          setValue("company_id", companiesData[0].id, {
            shouldValidate: true,
          });
        }

        companiesRef.current = companiesData;
        setCompanies(companiesData);

        if (id) {
          if (ddsResult.status !== "fulfilled" || ddsResult.value === null) {
            throw ddsResult.status === "rejected"
              ? ddsResult.reason
              : new Error("DDS não encontrado.");
          }
          const dds = ddsResult.value;
          const existingSignatures =
            signaturesResult.status === "fulfilled"
              ? (signaturesResult.value ?? [])
              : [];
          if (signaturesResult.status === "rejected") {
            toast.warning(
              await extractApiErrorMessage(
                signaturesResult.reason,
                "Assinaturas existentes não puderam ser carregadas agora. O formulário foi aberto em modo degradado.",
              ),
            );
          }
          setCurrentDds(dds);

          const participantSignatures: Record<
            string,
            { data: string; type: string }
          > = {};
          const loadedTeamPhotos: TeamPhotoEvidence[] = [];
          let loadedPhotoReuseJustification = "";

          existingSignatures.forEach((sig) => {
            if (sig.type === TEAM_PHOTO_REUSE_JUSTIFICATION_TYPE) {
              loadedPhotoReuseJustification = sig.signature_data || "";
              setPhotoReuseJustification(loadedPhotoReuseJustification);
              return;
            }

            if (sig.type.startsWith(TEAM_PHOTO_SIGNATURE_PREFIX)) {
              try {
                const parsed = JSON.parse(
                  sig.signature_data,
                ) as TeamPhotoEvidence;
                if (parsed?.imageData && parsed?.hash) {
                  loadedTeamPhotos.push(parsed);
                }
              } catch {
                loadedTeamPhotos.push({
                  imageData: sig.signature_data,
                  capturedAt: sig.created_at || new Date().toISOString(),
                  hash: "indisponivel",
                  metadata: { userAgent: "legacy" },
                });
              }
              return;
            }
            if (sig.user_id) {
              participantSignatures[sig.user_id] = {
                data: sig.signature_data,
                type: sig.type || "participant",
              };
            }
          });

          setSignatures(participantSignatures);
          setTeamPhotos(loadedTeamPhotos);

          const participants = dds.participants ?? [];

          reset({
            tema: dds.tema,
            conteudo: dds.conteudo || "",
            data: toInputDateValue(dds.data),
            company_id: dds.company_id,
            site_id: dds.site_id,
            facilitador_id: dds.facilitador_id,
            participants: participants.map((p) => p.id),
          });

          setInitialSignatureSnapshot(
            buildSignatureSnapshot({
              participantIds: participants.map((participant) => participant.id),
              signatures: participantSignatures,
              teamPhotos: loadedTeamPhotos,
              photoReuseJustification: loadedPhotoReuseJustification,
            }),
          );
        } else {
          setCurrentDds(null);
          setInitialSignatureSnapshot(null);
        }
      } catch (error) {
        logger.error("Erro ao carregar dados:", error);
        toast.error(
          getFormErrorMessage(error, {
            fallback: "Erro ao carregar dados para o formulário.",
            server: "O DDS não pôde ser carregado agora.",
          }),
        );
      } finally {
        setFetching(false);
      }
    }
    loadData();
  }, [canViewDds, id, reset, prefillCompanyId, setValue]);

  // Efeito 1: dispara quando empresa muda — carrega sites da empresa.
  // Usuários do DDS são carregados pela obra selecionada para evitar lista parcial.
  useEffect(() => {
    if (!canViewDds) {
      return;
    }

    let cancelled = false;

    async function loadCompanyScopedCatalogs() {
      if (!isUuidLike(selectedCompanyId)) {
        setSites([]);
        setUsers([]);
        return;
      }

      const selectedCompany = companiesRef.current.find(
        (company) => company.id === selectedCompanyId,
      );

      if (isAdminGeral) {
        selectedTenantStore.set({
          companyId: selectedCompanyId,
          companyName: selectedCompany?.razao_social || "Empresa selecionada",
        });
      }

      const siteResult = await sitesService
        .findPaginated({
          page: 1,
          limit: 100,
          companyId: selectedCompanyId,
        })
        .then((value) => ({ status: "fulfilled" as const, value }))
        .catch((reason) => ({ status: "rejected" as const, reason }));

      if (cancelled) return;

      const failedCatalogs = [
        siteResult.status === "rejected" ? "sites" : null,
      ].filter(Boolean);

      if (siteResult.status === "fulfilled") {
        setSites(siteResult.value.data);
        if (siteResult.value.lastPage > 1) {
          toast.warning(
            "A lista de sites foi limitada aos primeiros 100 registros para manter performance.",
          );
        }
      }

      if (failedCatalogs.length > 0) {
        toast.warning(
          `Parte do catálogo do DDS não pôde ser carregada para a empresa selecionada: ${failedCatalogs.join(", ")}.`,
        );
      }
    }

    loadCompanyScopedCatalogs();
    return () => {
      cancelled = true;
    };
  }, [canViewDds, isAdminGeral, selectedCompanyId]);

  // Efeito 2: dispara quando site muda — recarrega os usuários da obra com paginação completa.
  useEffect(() => {
    if (!canViewDds) {
      return;
    }

    if (!isUuidLike(selectedCompanyId) || !isUuidLike(selectedSiteId)) {
      setUsers([]);
      return;
    }

    let cancelled = false;

    async function reloadUsersForSite() {
      const userResult = await ddsService
        .listAllPeople({
          companyId: selectedCompanyId,
          siteId: selectedSiteId,
        })
        .catch(() => null);

      if (cancelled || !userResult) return;

      setUsers(dedupeDdsUsersById(userResult));
    }

    reloadUsersForSite();
    return () => {
      cancelled = true;
    };
  }, [canViewDds, selectedCompanyId, selectedSiteId]);

  useEffect(() => {
    if (!canViewDds) {
      return;
    }

    async function loadHistoricalPhotoHashes() {
      try {
        const nextHashes: Record<string, HistoricalPhotoReference> = {};
        const historicalReferences = await ddsService.getHistoricalPhotoHashes(
          100,
          id,
        );
        historicalReferences.forEach((item) => {
          item.hashes.forEach((hash) => {
            if (!hash) {
              return;
            }
            nextHashes[hash] = {
              ddsId: item.ddsId,
              tema: item.tema,
              data: item.data,
            };
          });
        });
        setHistoricalPhotoHashes(nextHashes);
      } catch (error) {
        logger.error(
          "Erro ao carregar hashes históricos de fotos do DDS:",
          error,
        );
      }
    }

    if (isUuidLike(selectedCompanyId)) {
      loadHistoricalPhotoHashes();
    } else {
      setHistoricalPhotoHashes({});
      setPhotoReuseWarnings({});
    }
  }, [canViewDds, selectedCompanyId, id]);

  useEffect(() => {
    const nextWarnings: Record<string, HistoricalPhotoReference> = {};
    teamPhotos.forEach((photo) => {
      const found = historicalPhotoHashes[photo.hash];
      if (found) {
        nextWarnings[photo.hash] = found;
      }
    });
    setPhotoReuseWarnings(nextWarnings);
  }, [teamPhotos, historicalPhotoHashes]);

  useEffect(() => {
    if (resumeSignatures) {
      toast.warning(
        "O DDS foi salvo, mas as assinaturas/fotos precisam ser concluídas antes do PDF final.",
      );
    }
    if (resumeVideos) {
      toast.info("DDS salvo. Agora você pode anexar vídeos governados.");
    }
  }, [resumeSignatures, resumeVideos]);

  const getGeoMetadata = async (): Promise<TeamPhotoMetadata> => {
    const nav: Navigator | undefined =
      typeof window !== "undefined" ? window.navigator : undefined;

    if (!nav) {
      return { userAgent: "server" };
    }

    if (!nav.geolocation) {
      return { userAgent: nav.userAgent };
    }

    try {
      const position = await new Promise<GeolocationPosition>(
        (resolve, reject) => {
          nav.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 6000,
            maximumAge: 120000,
          });
        },
      );

      return {
        userAgent: nav.userAgent,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
    } catch {
      return { userAgent: nav.userAgent };
    }
  };

  const sha256 = async (value: string): Promise<string> => {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };


  const handleTeamPhotoChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    try {
      // Geolocalização e pipeline compartilhado correm em paralelo.
      const [geoMetadata, imageBatch] = await Promise.all([
        getGeoMetadata(),
        processMobileImages(Array.from(files), {
          maxFiles: Math.max(0, 6 - teamPhotos.length),
        }),
      ]);
      const processedPhotos = await Promise.all(
        imageBatch.processed.map(async (processed) => {
          const imageData = await blobToBoundedDataUrl(processed.file);
          const hash = await sha256(imageData);
          return {
            imageData,
            hash,
            capturedAt: new Date().toISOString(),
            metadata: geoMetadata,
          } as TeamPhotoEvidence;
        }),
      );
      const hasPotentialReuse = processedPhotos.some((photo) =>
        Boolean(historicalPhotoHashes[photo.hash]),
      );
      if (hasPotentialReuse) {
        toast.warning(
          "Detectamos foto(s) já usada(s) em DDS anterior desta empresa.",
        );
      }
      setTeamPhotos((prev) => [...prev, ...processedPhotos].slice(0, 6));
      if (processedPhotos.length) {
        toast.success(`${processedPhotos.length} foto(s) auditável(is) adicionada(s) ao DDS.`);
      }
      if (imageBatch.rejected.length) {
        toast.warning(
          `${imageBatch.rejected.length} foto(s) não foram adicionadas: ${imageBatch.rejected[0]?.message}`,
        );
      }
    } catch (error) {
      logger.error("Erro ao processar fotos da equipe:", error);
      toast.error("Não foi possível processar uma ou mais fotos.");
    } finally {
      event.target.value = "";
    }
  };

  async function onSubmit(data: DdsFormData) {
    if (!canManageDds) {
      setSubmitError("Você não tem permissão para salvar DDS.");
      toast.error("Você não tem permissão para salvar DDS.");
      return;
    }
    let persistedDdsId: string | undefined;
    let shouldPersistSignatures = false;

    const submitFormWithResetConfirmed = async (
      data: DdsFormData,
      payload: {
        tema: string;
        conteudo?: string;
        data: string;
        site_id: string;
        facilitador_id: string;
        participants: string[];
      },
      confirmedSignatureReset: boolean,
    ) => {
      let ddsId = id;

      if (id) {
        const updatedDds = await ddsService.update(id, {
          ...payload,
          ...(confirmedSignatureReset ? { confirm_signature_reset: true } : {}),
        });
        persistedDdsId = updatedDds.id;
        setCurrentDds(updatedDds);
      } else {
        const newDds = await ddsService.create(payload);
        ddsId = newDds.id;
        persistedDdsId = newDds.id;
        setCurrentDds(newDds);
      }

      const currentSignatureSnapshot = buildSignatureSnapshot({
        participantIds: data.participants,
        signatures,
        teamPhotos,
        photoReuseJustification,
      });
      const hasAnySignature = Object.keys(signatures).length > 0;
      const hasAnyTeamPhoto = teamPhotos.length > 0;
      const hasEvidenceToPersist = hasAnySignature || hasAnyTeamPhoto;
      const evidenceChangedOrNew =
        !id ||
        !initialSignatureSnapshot ||
        currentSignatureSnapshot !== initialSignatureSnapshot;
      const shouldReplaceSignatures =
        hasEvidenceToPersist && (confirmedSignatureReset || evidenceChangedOrNew);
      shouldPersistSignatures = shouldReplaceSignatures;

      if (ddsId && shouldReplaceSignatures) {
        const participantSignaturesPayload = Object.entries(signatures)
          .filter(([participantId]) => data.participants.includes(participantId))
          .map(([participantId, signature]) => {
            if (signature.type === "hmac") {
              const pin = String(signature.data || "").trim();
              if (!/^\d{4,6}$/.test(pin)) {
                const participantName =
                  users.find((user) => user.id === participantId)?.nome ||
                  "Participante";
                throw new Error(
                  `${participantName} precisa confirmar novamente a assinatura por PIN para concluir esta alteração.`,
                );
              }
              return {
                user_id: participantId,
                type: signature.type,
                signature_data: "HMAC_PENDING",
                pin,
              };
            }

            return {
              user_id: participantId,
              type: signature.type || "digital",
              signature_data: signature.data,
            };
          });

        await ddsService.replaceSignatures(ddsId, {
          participant_signatures: participantSignaturesPayload,
          team_photos: teamPhotos,
          photo_reuse_justification:
            Object.keys(photoReuseWarnings).length > 0
              ? photoReuseJustification.trim()
              : undefined,
        });

        if (id) {
          setInitialSignatureSnapshot(currentSignatureSnapshot);
        }
      }

      if (!id && ddsId) {
        toast.success("DDS salvo. Continue anexando vídeos governados.");
        router.replace(`/dashboard/dds/edit/${ddsId}?resume_videos=1`);
        router.refresh();
        return;
      }

      toast.success("DDS atualizado com sucesso!");
      router.push("/dashboard/dds");
      router.refresh();
    };

    try {
      setLoading(true);
      setSubmitError(null);

      const signedSelectedParticipants = data.participants.filter(
        (participantId) => Boolean(signatures[participantId]),
      );
      const hasPartialSignatures =
        signedSelectedParticipants.length > 0 &&
        signedSelectedParticipants.length < data.participants.length;
      if (hasPartialSignatures) {
        setSubmitError(
          "Se iniciar assinaturas, todos os participantes selecionados devem assinar o DDS.",
        );
        toast.error("Assinaturas parciais detectadas.");
        return;
      }

      if (
        Object.keys(photoReuseWarnings).length > 0 &&
        photoReuseJustification.trim().length < 20
      ) {
        setSubmitError(
          "Detectamos possível reuso de foto. Informe uma justificativa com pelo menos 20 caracteres para continuar.",
        );
        toast.error("Justificativa obrigatória para reuso de foto detectado.");
        return;
      }

      const payload = {
        tema: data.tema,
        conteudo: data.conteudo,
        data: data.data,
        site_id: data.site_id,
        facilitador_id: data.facilitador_id,
        participants: data.participants,
      };
      if (payload.conteudo === "") delete payload.conteudo;
      const signatureResetReasons =
        id && currentDds ? buildDdsSignatureResetReasons(currentDds, data) : [];

      if (signatureResetReasons.length > 0) {
        // Armazena a callback e abre o modal
        setPendingResetCallback(() => async () => {
          await submitFormWithResetConfirmed(data, payload, true);
        });
        setConfirmResetDialogOpen(true);
        return;
      }

      // Se não há razões de reset, continua normalmente
      await submitFormWithResetConfirmed(data, payload, false);
    } catch (error) {
      if (persistedDdsId && shouldPersistSignatures) {
        const partialSaveMessage =
          "O DDS foi salvo, mas assinaturas/fotos ainda não foram concluídas. Revise o registro e finalize antes de emitir o PDF final.";
        setSubmitError(partialSaveMessage);
        toast.warning(partialSaveMessage);
        if (!id) {
          router.replace(
            `/dashboard/dds/edit/${persistedDdsId}?resume_signatures=1`,
          );
        }
        return;
      }
      logger.error("Erro ao salvar DDS:", error);
      const errorMessage = getFormErrorMessage(error, {
        badRequest: "Dados inválidos. Revise os campos obrigatórios.",
        unauthorized: "Sessão expirada. Faça login novamente.",
        forbidden: "Você não tem permissão para salvar DDS.",
        server: "Erro interno do servidor ao salvar DDS.",
        fallback: "Erro ao salvar DDS. Tente novamente.",
      });
      setSubmitError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  }

  const onInvalid = (formErrors: FieldErrors<DdsFormData>) => {
    if (formErrors.tema) {
      setFocus("tema");
    } else if (formErrors.company_id) {
      setFocus("company_id");
    } else if (formErrors.site_id) {
      setFocus("site_id");
    } else if (formErrors.facilitador_id) {
      setFocus("facilitador_id");
    }
    toast.error("Revise os campos obrigatórios antes de salvar.");
  };

  const toggleParticipant = (userId: string) => {
    const isSelected = selectedParticipantIds.includes(userId);

    if (isSelected) {
      // If already selected, just remove
      const updated = selectedParticipantIds.filter((id) => id !== userId);
      setValue("participants", updated, { shouldValidate: true });
      // Also remove temporary signature if exists
      const newSignatures = { ...signatures };
      delete newSignatures[userId];
      setSignatures(newSignatures);
    } else {
      // If not selected, open signature modal first
      const user = users.find((u) => u.id === userId);
      if (user) {
        setCurrentSigningUser(user);
        setIsSignatureModalOpen(true);
      }
    }
  };

  const handleSaveSignature = (signatureData: string, type: string) => {
    if (currentSigningUser) {
      setSignatures((prev) => ({
        ...prev,
        [currentSigningUser.id]: { data: signatureData, type },
      }));

      const updated = Array.from(
        new Set([...selectedParticipantIds, currentSigningUser.id]),
      );
      setValue("participants", updated, { shouldValidate: true });
      toast.success(`Assinatura de ${currentSigningUser.nome} capturada!`);
    }
  };

  if (!canViewDds) {
    return (
      <ErrorState
        title="Acesso ao DDS indisponível"
        description="Seu perfil não possui permissão para visualizar registros de DDS."
      />
    );
  }

  if (!canManageDds) {
    return (
      <div
        role="alert"
        className="rounded-[var(--ds-radius-md)] border border-[color:var(--ds-color-danger)]/20 bg-[color:var(--ds-color-danger)]/8 px-5 py-4 text-sm text-[var(--ds-color-danger)]"
      >
        <p className="font-semibold">Acesso bloqueado</p>
        <p className="mt-1 text-[color:var(--ds-color-danger)]/90">
          Você não tem permissão para criar ou editar DDS neste tenant.
        </p>
      </div>
    );
  }

  return (
    <div className="ds-form-page mx-auto max-w-4xl space-y-6">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState
            label={id ? "Carregando DDS" : "Preparando DDS"}
          />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Diálogo diário"
        title={id ? "Editar DDS" : "Novo DDS"}
        description={
          ddsReadOnly
            ? "Documento em modo de consulta, com evidências e assinaturas preservadas para auditoria."
            : "Registre tema, participantes e evidências do DDS com foco em rapidez de campo. Assinaturas podem ser concluídas depois, antes do PDF final."
        }
        icon={
          <Link
            href="/dashboard/dds"
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] hover:bg-[var(--ds-color-surface-muted)] hover:text-[var(--ds-color-text-secondary)]"
            title="Voltar para DDS"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {ddsReadOnly ? (
              <StatusPill tone="warning">Somente leitura</StatusPill>
            ) : (
              <StatusPill tone="primary">Fluxo ativo</StatusPill>
            )}
            {selectedParticipantIds.length > 0 ? (
              <StatusPill tone="success">
                {selectedParticipantIds.length} participante(s)
              </StatusPill>
            ) : null}
            {currentDds?.status === "arquivado" ? (
              <StatusPill tone="neutral">Arquivado</StatusPill>
            ) : null}
          </div>
        }
      />

      <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
          Condução guiada
        </p>
        <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
          Estruture o DDS com contexto e evidências visuais no mesmo fluxo.
        </p>
        <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
          O ideal é fechar tema, facilitador e participantes antes de subir as
          fotos da equipe. As assinaturas podem ser concluídas após o salvamento,
          mas são obrigatórias para emitir o PDF final.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-8">
        {submitError && (
          <div
            role="alert"
            className="rounded-[var(--ds-radius-md)] border border-[color:var(--ds-color-danger)]/20 bg-[color:var(--ds-color-danger)]/8 px-4 py-3 text-sm text-[var(--ds-color-danger)]"
          >
            <p className="font-semibold">Não foi possível concluir o DDS</p>
            <p className="mt-1 text-[color:var(--ds-color-danger)]/90">
              {submitError}
            </p>
          </div>
        )}
        {ddsReadOnlyMessage ? (
          <div
            role="alert"
            className="rounded-xl border border-[color:var(--ds-color-warning)]/25 bg-[color:var(--ds-color-warning-subtle)] px-5 py-4 text-sm text-[color:var(--ds-color-warning)]"
          >
            <p className="font-semibold text-[color:var(--ds-color-warning)]">
              Documento travado para edição
            </p>
            <p className="mt-1 text-[color:var(--ds-color-warning)]/90">
              {ddsReadOnlyMessage}
            </p>
          </div>
        ) : null}
        <div className="grid gap-3 rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[linear-gradient(180deg,rgba(255,255,255,0.6),rgba(255,255,255,0.2))] px-5 py-4 backdrop-blur-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
                Resumo do documento
              </p>
              <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                {ddsReadOnly ? "Leitura controlada" : "Edição em andamento"}
              </p>
              <p className="text-sm text-[var(--ds-color-text-secondary)]">
                {ddsReadOnly
                  ? "Os campos abaixo estão travados para manter a integridade do DDS publicado."
                  : "Preencha os dados principais antes de avançar para participantes, fotos e aprovação."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {currentDds?.status ? (
                <StatusPill tone={ddsReadOnly ? "warning" : "primary"}>
                  {currentDds.status}
                </StatusPill>
              ) : (
                <StatusPill tone="neutral">Novo DDS</StatusPill>
              )}
              {selectedParticipantIds.length > 0 ? (
                <StatusPill tone="success">
                  {selectedParticipantIds.length} participante(s)
                </StatusPill>
              ) : null}
              <StatusPill tone="neutral">
                {teamPhotos.length} foto(s)
              </StatusPill>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {formSectionHighlights.map((section) => (
              <div
                key={section.step}
                className={`rounded-[var(--ds-radius-md)] border px-3 py-3 shadow-[0_1px_0_rgba(0,0,0,0.02)] ${
                  section.tone === "primary"
                    ? "border-[color:var(--ds-color-action-primary)]/20 bg-[color:var(--ds-color-action-primary)]/8"
                    : "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]/65"
                }`}
              >
                <p
                  className={`text-[11px] font-semibold uppercase tracking-[0.16em] ${
                    section.tone === "primary"
                      ? "text-[var(--ds-color-action-primary)]"
                      : "text-[var(--ds-color-text-muted)]"
                  }`}
                >
                  {section.step}
                </p>
                <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  {section.title}
                </p>
                <p className="mt-1 text-xs text-[var(--ds-color-text-secondary)]">
                  {section.description}
                </p>
              </div>
            ))}
          </div>
        </div>
        <fieldset
          disabled={ddsReadOnly}
          className={`space-y-8 ${ddsReadOnly ? "opacity-80" : ""}`}
        >
          <Card tone="default" padding="lg">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                  Base do DDS
                </p>
                <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">
                  Informações Básicas
                </h2>
                <p className="max-w-2xl text-sm text-[var(--ds-color-text-secondary)]">
                  Defina o contexto mínimo do DDS. A leitura precisa começar
                  por aqui.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsThemeLibraryOpen(true)}
                  disabled={ddsReadOnly}
                  className="flex items-center space-x-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-2 text-sm font-bold text-[var(--ds-color-text-primary)] shadow-sm transition-all hover:bg-[var(--ds-color-surface-muted)] disabled:opacity-50"
                  title="Abrir biblioteca de temas pré-definidos"
                >
                  <BookOpen className="h-4 w-4 text-[var(--ds-color-action-primary)]" />
                  <span>Biblioteca de Temas</span>
                </button>
                {isAiEnabled() && (
                  <button
                    type="button"
                    onClick={handleAiSuggestion}
                    disabled={suggesting || ddsReadOnly}
                    className="flex items-center space-x-2 rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-bold text-[var(--ds-color-action-primary-foreground)] shadow-md transition-all hover:brightness-110 disabled:opacity-50"
                  >
                    {suggesting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    <span>Sugerir Tema com Sophie</span>
                  </button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/25 p-4 md:col-span-2">
                <label
                  htmlFor="dds-tema"
                  className="block text-sm font-medium text-[var(--ds-color-text-secondary)]"
                >
                  Tema do DDS
                </label>
                <input
                  id="dds-tema"
                  type="text"
                  {...register("tema")}
                  className={`${inputClassName} ${errors.tema ? inputErrorClass : inputDefaultClass}`}
                  aria-invalid={errors.tema ? "true" : undefined}
                  placeholder="Ex: Importância do uso de EPIs"
                />
                <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">
                  Use um tema direto, fácil de reconhecer em campo e em
                  histórico administrativo.
                </p>
                {errors.tema && (
                  <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                    {errors.tema.message}
                  </p>
                )}
              </div>

              <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/20 p-4 md:col-span-2">
                <label
                  htmlFor="dds-conteudo"
                  className="block text-sm font-medium text-[var(--ds-color-text-secondary)]"
                >
                  Conteúdo / Resumo
                </label>
                <textarea
                  id="dds-conteudo"
                  {...register("conteudo")}
                  rows={5}
                  aria-label="Conteúdo do DDS"
                  className={`${inputClassName} ${inputDefaultClass}`}
                  placeholder="Descreva brevemente os pontos abordados no DDS..."
                />
                <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">
                  Resuma a orientação passada, riscos reforçados e combinados
                  operacionais do DDS.
                </p>
              </div>

              <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/15 p-4">
                <label
                  htmlFor="dds-data"
                  className="block text-sm font-medium text-[var(--ds-color-text-secondary)]"
                >
                  Data
                </label>
                <input
                  id="dds-data"
                  type="date"
                  {...register("data")}
                  aria-label="Data do DDS"
                  className={`${inputClassName} ${inputDefaultClass}`}
                />
              </div>

              {isAdminGeral ? (
                <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/15 p-4">
                  <label
                    htmlFor="dds-company-id"
                    className="block text-sm font-medium text-[var(--ds-color-text-secondary)]"
                  >
                    Empresa
                  </label>
                  <select
                    id="dds-company-id"
                    {...register("company_id")}
                    onChange={(e) => {
                      const nextCompanyId = e.target.value;
                      if (isUuidLike(nextCompanyId)) {
                        const selectedCompany = companies.find(
                          (company) => company.id === nextCompanyId,
                        );
                        selectedTenantStore.set({
                          companyId: nextCompanyId,
                          companyName:
                            selectedCompany?.razao_social ||
                            "Empresa selecionada",
                        });
                      }
                      setValue("company_id", nextCompanyId, {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                      setValue("site_id", "");
                      setValue("facilitador_id", "");
                      setValue("participants", []);
                      setSignatures({});
                      setTeamPhotos([]);
                      setPhotoReuseWarnings({});
                      setPhotoReuseJustification("");
                    }}
                    className={`${inputClassName} ${errors.company_id ? inputErrorClass : inputDefaultClass}`}
                    aria-invalid={errors.company_id ? "true" : undefined}
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
              ) : (
                <input type="hidden" {...register("company_id")} />
              )}

              <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/15 p-4">
                <label
                  htmlFor="dds-site-id"
                  className="block text-sm font-medium text-[var(--ds-color-text-secondary)]"
                >
                  Site/Unidade
                </label>
                <select
                  id="dds-site-id"
                  {...register("site_id")}
                  onChange={(e) => {
                    setValue("site_id", e.target.value, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                    setValue("facilitador_id", "", {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                    setValue("participants", [], {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                    setSignatures({});
                  }}
                  disabled={!selectedCompanyId}
                  aria-label="Site ou unidade do DDS"
                  className={`${inputClassName} ${!selectedCompanyId ? inputDisabledClass : errors.site_id ? inputErrorClass : inputDefaultClass}`}
                  aria-invalid={errors.site_id ? "true" : undefined}
                >
                  <option value="">
                    {selectedCompanyId
                      ? "Selecione um site"
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

              <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/15 p-4">
                <label
                  htmlFor="dds-facilitador-id"
                  className="block text-sm font-medium text-[var(--ds-color-text-secondary)]"
                >
                  Facilitador
                </label>
                <select
                  id="dds-facilitador-id"
                  {...register("facilitador_id")}
                  disabled={!selectedCompanyId}
                  aria-label="Facilitador do DDS"
                  className={`${inputClassName} ${!selectedCompanyId ? inputDisabledClass : errors.facilitador_id ? inputErrorClass : inputDefaultClass}`}
                  aria-invalid={errors.facilitador_id ? "true" : undefined}
                >
                  <option value="">
                    {selectedCompanyId
                      ? "Selecione um facilitador"
                      : "Selecione uma empresa primeiro"}
                  </option>
                  {filteredUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.nome}
                    </option>
                  ))}
                </select>
                {errors.facilitador_id && (
                  <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                    {errors.facilitador_id.message}
                  </p>
                )}
              </div>
            </div>
          </Card>

          <Card tone="default" padding="lg">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                  Participação
                </p>
                <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">
                  Participantes
                </h2>
                <p className="max-w-2xl text-sm text-[var(--ds-color-text-secondary)]">
                  Escolha quem participa e deixe a captura de assinatura
                  explícita no fluxo.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone="neutral">
                  {selectedParticipantIds.length} no fluxo
                </StatusPill>
                <StatusPill tone="success">
                  {Object.keys(signatures).length} assinado(s)
                </StatusPill>
              </div>
            </div>
            {!selectedCompanyId ? (
              <div className="rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] py-8 text-center text-sm text-[var(--ds-color-text-muted)]">
                Selecione uma empresa para listar os participantes
              </div>
            ) : !selectedSiteId ? (
              <div className="rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] py-8 text-center text-sm text-[var(--ds-color-text-muted)]">
                Selecione a obra para carregar participantes e facilitadores do DDS
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] py-8 text-center text-sm text-[var(--ds-color-text-muted)]">
                Nenhum usuário ou funcionário encontrado para esta obra
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                {filteredUsers.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => toggleParticipant(user.id)}
                    aria-label={
                      selectedParticipantIds.includes(user.id)
                        ? `${user.nome}: participante assinado. Clique para remover do DDS.`
                        : `${user.nome}: capturar assinatura e incluir no DDS.`
                    }
                    className={`flex items-center justify-between rounded-[var(--ds-radius-md)] border p-3 text-left text-sm transition-colors ${
                      selectedParticipantIds.includes(user.id)
                        ? "border-[var(--ds-color-action-primary)] bg-[color:var(--ds-color-action-primary)]/8"
                        : "border-[var(--ds-color-border-subtle)] hover:bg-[var(--ds-color-surface-muted)]"
                    }`}
                  >
                    <span className="font-medium text-[var(--ds-color-text-primary)]">
                      {user.nome}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${
                        selectedParticipantIds.includes(user.id)
                          ? "border border-[var(--ds-color-success-border)] bg-[color:var(--ds-color-success-subtle)] text-[var(--ds-color-success)]"
                          : "border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)]"
                      }`}
                    >
                      {selectedParticipantIds.includes(user.id)
                        ? "Assinado"
                        : "Assinar"}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {errors.participants && (
              <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                {errors.participants.message}
              </p>
            )}
          </Card>

          <Card tone="default" padding="lg">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                  Evidências
                </p>
                <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">
                  Registro Fotográfico da Equipe
                </h2>
                <p className="max-w-2xl text-sm text-[var(--ds-color-text-muted)]">
                  Use a câmera do celular para registrar presença e evidência do
                  DDS.
                </p>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-action-primary)] bg-[color:var(--ds-color-action-primary)] px-3 py-2 text-sm font-semibold text-[var(--ds-color-action-primary-foreground)] shadow-sm hover:brightness-110">
                <Camera className="h-4 w-4" />
                Adicionar Foto
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-label="Selecionar fotos da equipe para o DDS"
                  multiple
                  disabled={ddsReadOnly}
                  className="hidden"
                  onChange={handleTeamPhotoChange}
                />
              </label>
            </div>

            {teamPhotos.length === 0 ? (
              <div className="rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] py-6 text-center text-sm text-[var(--ds-color-text-muted)]">
                Nenhuma foto adicionada. Recomendado: anexar pelo menos 1 foto
                da equipe.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {teamPhotos.map((photo, index) => (
                  <div
                    key={`${index}-${photo.hash.slice(0, 12)}`}
                    className="relative overflow-hidden rounded-[var(--ds-radius-md)] border"
                    title={`Hash de integridade: ${photo.hash.slice(0, 16)}...`}
                  >
                    <NextImage
                      src={photo.imageData}
                      alt={`Foto da equipe ${index + 1}`}
                      width={600}
                      height={300}
                      loading="lazy"
                      className="h-36 w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setTeamPhotos((prev) =>
                          prev.filter((_, i) => i !== index),
                        )
                      }
                      className="absolute right-2 top-2 rounded-md bg-[var(--ds-color-surface-base)]/90 p-1 text-[var(--ds-color-danger)] hover:bg-[var(--ds-color-surface-base)]"
                      title="Remover foto"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {Object.keys(photoReuseWarnings).length > 0 && (
              <div
                role="alert"
                className="mt-4 space-y-2 rounded-[var(--ds-radius-md)] border border-[color:var(--ds-color-warning)]/25 bg-[color:var(--ds-color-warning)]/8 px-4 py-3 text-xs text-[var(--ds-color-warning)]"
              >
                <p className="font-semibold">
                  Alerta de possível reuso de imagem:
                </p>
                {Object.entries(photoReuseWarnings).map(([hash, ref]) => (
                  <p
                    key={hash}
                    className="text-[color:var(--ds-color-warning)]/90"
                  >
                    Hash {hash.slice(0, 12)}... já apareceu no DDS &quot;
                    {ref.tema}&quot; (
                    {safeToLocaleDateString(
                      ref.data,
                      "pt-BR",
                      undefined,
                      "data indisponível",
                    )}
                    ).
                  </p>
                ))}
                <div className="pt-2">
                  <label className="mb-1 block text-xs font-semibold text-[var(--ds-color-text-secondary)]">
                    Justificativa de exceção (obrigatória para salvar)
                  </label>
                  <textarea
                    value={photoReuseJustification}
                    onChange={(event) =>
                      setPhotoReuseJustification(event.target.value)
                    }
                    className="w-full rounded-md border border-[color:var(--ds-color-warning)]/35 bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-warning)] focus:outline-none"
                    rows={3}
                    placeholder="Explique por que a mesma foto está sendo reutilizada neste DDS."
                  />
                </div>
              </div>
            )}
          </Card>

          <DdsApprovalPanel
            dds={currentDds}
            canManage={canManageDds}
            onDdsChanged={setCurrentDds}
          />

          <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/20 px-4 py-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-2xl">
                <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  Pronto para finalizar o bloco atual?
                </p>
                <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                  Revise os campos principais, confira participantes e siga para
                  gravação governada do documento.
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.back()}
                >
                  Cancelar
                </Button>
                {currentDds?.id ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={previewLoading}
                    onClick={() => void handlePreviewPdf()}
                    leftIcon={
                      previewLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )
                    }
                    title="Gera uma prévia do PDF com marca d'água de rascunho"
                  >
                    {previewLoading ? "Gerando..." : "Prévia PDF"}
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  disabled={ddsReadOnly || loading || isSubmitting}
                  leftIcon={
                    loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )
                  }
                >
                  {loading ? "Salvando..." : "Salvar DDS"}
                </Button>
              </div>
            </div>
          </div>
        </fieldset>

        <DocumentVideoPanel
          title="Vídeos governados"
          description="Anexe vídeos do DDS como evidência operacional governada, com acesso seguro e trilha auditável."
          documentId={id}
          canManage={canManageDds}
          locked={ddsVideoLocked}
          lockMessage={ddsVideoLockMessage}
          attachments={documentVideos.attachments}
          loading={documentVideos.loading}
          uploading={documentVideos.uploading}
          removingId={documentVideos.removingId}
          onUpload={documentVideos.handleUpload}
          onRemove={documentVideos.handleRemove}
          resolveAccess={documentVideos.resolveAccess}
        />
      </form>

      {isSignatureModalOpen && currentSigningUser && (
        <SignatureModal
          isOpen={isSignatureModalOpen}
          onClose={() => setIsSignatureModalOpen(false)}
          onSave={handleSaveSignature}
          userName={currentSigningUser.nome}
        />
      )}

      <DdsThemeLibraryModal
        isOpen={isThemeLibraryOpen}
        onClose={() => setIsThemeLibraryOpen(false)}
        onSelect={(theme) => {
          setValue("tema", theme.tema, { shouldValidate: true });
          setValue("conteudo", theme.conteudo || "", { shouldValidate: true });
          toast.success("Tema aplicado com sucesso!");
        }}
      />

      {pendingResetCallback && (
        <ConfirmModal
          open={confirmResetDialogOpen}
          onClose={() => {
            setConfirmResetDialogOpen(false);
            setPendingResetCallback(null);
          }}
          onConfirm={async () => {
            try {
              await pendingResetCallback();
              setConfirmResetDialogOpen(false);
              setPendingResetCallback(null);
            } catch (error) {
              logger.error("Erro ao confirmar reset de assinaturas:", error);
            }
          }}
          title="Confirmar invalidação de assinaturas"
          description="Esta alteração invalida as assinaturas existentes do DDS. Deseja confirmar e reenviar as assinaturas já capturadas?"
          confirmLabel="Confirmar e continuar"
          danger={true}
        />
      )}
      <ConsentGate />
    </div>
  );
}


