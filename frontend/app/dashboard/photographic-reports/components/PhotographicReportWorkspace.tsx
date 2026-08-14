"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { CheckCircle2, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { extractApiErrorMessage } from "@/lib/error-handler";
import { Permission } from "@/lib/permissions";
import { openSafeExternalUrlInNewTab } from "@/lib/security/safe-external-url";
import {
  processMobileImage,
  processMobileImages,
} from "@/lib/images/process-mobile-image";
import {
  photographicReportsService,
  type CreatePhotographicReportDto,
  type PhotographicReport,
  type PhotographicReportExport,
  type PhotographicReportImage,
  type UpdatePhotographicReportDto,
  type UpdatePhotographicReportImageDto,
  type UploadPhotographicReportImagesDto,
} from "@/services/photographicReportsService";
import type { ReportFormState, WizardStep, PendingPhoto } from "../types";
import {
  buildCapturedAtList,
  captureUploadGeoContext,
} from "../upload-context";
import { WizardStep1BasicData } from "./WizardStep1BasicData";
import { WizardStep2Photos } from "./WizardStep2Photos";
import { WizardStep3Review } from "./WizardStep3Review";
import type { PhotoCardSavePayload } from "./PhotoCard";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_FORM_STATE: ReportFormState = {
  client_id: "",
  project_id: "",
  client_name: "",
  project_name: "",
  unit_name: "",
  location: "",
  activity_type: "",
  report_tone: "Positivo",
  area_status: "Loja aberta",
  shift: "Diurno",
  start_date: "",
  end_date: "",
  start_time: "08:00",
  end_time: "17:00",
  responsible_name: "",
  responsible_registration_type: "",
  responsible_registration_number: "",
  responsible_registration_state: "",
  art_number: "",
  contractor_company: "",
  applicable_nrs: [],
  inspection_methodology: "",
  scope_and_limitations: "",
  general_observations: "",
  ai_summary: "",
  final_conclusion: "",
  status: "Rascunho",
};

const WIZARD_STEPS: { label: string; step: WizardStep }[] = [
  { label: "Dados básicos", step: 1 },
  { label: "Fotos", step: 2 },
  { label: "Revisar e exportar", step: 3 },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function splitLines(value: string | null | undefined): string[] {
  return String(value || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function toNullableString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function reportToForm(report: PhotographicReport): ReportFormState {
  return {
    client_id: report.client_id || "",
    project_id: report.project_id || "",
    client_name: report.client_name || "",
    project_name: report.project_name || "",
    unit_name: report.unit_name || "",
    location: report.location || "",
    activity_type: report.activity_type || "",
    report_tone: report.report_tone,
    area_status: report.area_status,
    shift: report.shift,
    start_date: report.start_date || "",
    end_date: report.end_date || "",
    start_time: (report.start_time || "").slice(0, 5),
    end_time: (report.end_time || "").slice(0, 5),
    responsible_name: report.responsible_name || "",
    responsible_registration_type: report.responsible_registration_type || "",
    responsible_registration_number:
      report.responsible_registration_number || "",
    responsible_registration_state:
      report.responsible_registration_state || "",
    art_number: report.art_number || "",
    contractor_company: report.contractor_company || "",
    applicable_nrs: report.applicable_nrs || [],
    inspection_methodology: report.inspection_methodology || "",
    scope_and_limitations: report.scope_and_limitations || "",
    general_observations: report.general_observations || "",
    ai_summary: report.ai_summary || "",
    final_conclusion: report.final_conclusion || "",
    status: report.status,
  };
}

function formToCreatePayload(form: ReportFormState): CreatePhotographicReportDto {
  return {
    client_id: toNullableString(form.client_id),
    project_id: toNullableString(form.project_id),
    client_name: form.client_name.trim(),
    project_name: form.project_name.trim(),
    unit_name: toNullableString(form.unit_name),
    location: toNullableString(form.location),
    activity_type: form.activity_type.trim(),
    report_tone: form.report_tone,
    area_status: form.area_status,
    shift: form.shift,
    start_date: form.start_date.trim(),
    end_date: toNullableString(form.end_date),
    start_time: form.start_time.trim(),
    end_time: form.end_time.trim(),
    responsible_name: form.responsible_name.trim(),
    ...sstFieldsFromForm(form),
    general_observations: toNullableString(form.general_observations),
  };
}

/**
 * Campos de SST comuns ao payload de criação e ao de atualização.
 *
 * Extraído para não manter duas listas manuais dos mesmos campos — foi
 * exatamente esse padrão que fez `photo_conditions` e o INSERT de imagens
 * divergirem em silêncio no backend.
 */
function sstFieldsFromForm(form: ReportFormState) {
  return {
    responsible_registration_type:
      form.responsible_registration_type || null,
    responsible_registration_number: toNullableString(
      form.responsible_registration_number,
    ),
    responsible_registration_state: toNullableString(
      form.responsible_registration_state,
    ),
    art_number: toNullableString(form.art_number),
    contractor_company: form.contractor_company.trim(),
    applicable_nrs: form.applicable_nrs.length ? form.applicable_nrs : null,
    inspection_methodology: toNullableString(form.inspection_methodology),
    scope_and_limitations: toNullableString(form.scope_and_limitations),
  };
}

function formToUpdatePayload(form: ReportFormState): UpdatePhotographicReportDto {
  return {
    client_id: toNullableString(form.client_id),
    project_id: toNullableString(form.project_id),
    client_name: form.client_name.trim(),
    project_name: form.project_name.trim(),
    unit_name: toNullableString(form.unit_name),
    location: toNullableString(form.location),
    activity_type: form.activity_type.trim(),
    report_tone: form.report_tone,
    area_status: form.area_status,
    shift: form.shift,
    start_date: form.start_date.trim(),
    end_date: toNullableString(form.end_date),
    start_time: form.start_time.trim(),
    end_time: form.end_time.trim(),
    responsible_name: form.responsible_name.trim(),
    ...sstFieldsFromForm(form),
    general_observations: toNullableString(form.general_observations),
    ai_summary: toNullableString(form.ai_summary),
    final_conclusion: toNullableString(form.final_conclusion),
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function buildExportFileName(
  report: PhotographicReport,
  exportType: PhotographicReportExport["export_type"],
) {
  const base = [report.client_name, report.project_name, report.activity_type]
    .map((value) =>
      value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    )
    .filter(Boolean)
    .join("_")
    .slice(0, 80);
  const stamp = format(new Date(), "yyyyMMdd_HHmm");
  return `RELATORIO_FOTOGRAFICO_${base || "documento"}_${stamp}.${exportType === "pdf" ? "pdf" : "docx"}`;
}

function resolveInitialStep(report: PhotographicReport, stepParam?: string | null): WizardStep {
  const fromParam = stepParam ? (Number(stepParam) as WizardStep) : null;
  if (fromParam && (fromParam === 1 || fromParam === 2 || fromParam === 3)) {
    return fromParam;
  }
  if (["Finalizado", "Exportado", "Analisado", "Em edição"].includes(report.status)) return 3;
  if ((report.images?.length ?? 0) > 0 || report.status === "Aguardando análise") return 2;
  return 1;
}

// ── Wizard Progress Bar ──────────────────────────────────────────────────────

function WizardProgressBar({
  currentStep,
  onStepClick,
}: {
  currentStep: WizardStep;
  onStepClick?: (step: WizardStep) => void;
}) {
  return (
    <nav aria-label="Progresso do wizard" className="mb-8">
      <ol className="flex items-center gap-0">
        {WIZARD_STEPS.map(({ label, step }, index) => {
          const done = step < currentStep;
          const active = step === currentStep;
          return (
            <li key={step} className="flex flex-1 items-center">
              <button
                type="button"
                disabled={!done && !active}
                onClick={() => done && onStepClick?.(step)}
                className={[
                  "flex items-center gap-2 text-sm font-medium transition-colors",
                  active ? "text-[var(--ds-color-action-primary)]" : done ? "cursor-pointer text-[var(--ds-color-text-muted)] hover:text-[var(--ds-color-text-primary)]" : "text-[var(--ds-color-text-muted)]/50 cursor-default",
                ].join(" ")}
              >
                <span
                  className={[
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-all",
                    active
                      ? "border-[var(--ds-color-action-primary)] bg-[var(--ds-color-action-primary)] text-[var(--ds-color-action-primary-foreground)]"
                      : done
                        ? "border-[var(--ds-color-action-primary)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-action-primary)]"
                        : "border-muted-foreground/30 bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-muted)]/50",
                  ].join(" ")}
                >
                  {done ? <CheckCircle2 className="h-4 w-4" /> : step}
                </span>
                <span className="hidden sm:block">{label}</span>
              </button>
              {index < WIZARD_STEPS.length - 1 && (
                <div
                  className={[
                    "mx-2 flex-1 h-px transition-all",
                    step < currentStep ? "bg-[var(--ds-color-action-primary)]" : "bg-border",
                  ].join(" ")}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

type WorkspaceMode = "create" | "edit";

export function PhotographicReportWorkspace({
  mode,
  reportId,
}: {
  mode: WorkspaceMode;
  reportId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { hasPermission } = useAuth();

  const canManage = hasPermission(Permission.CAN_MANAGE_PHOTOGRAPHIC_REPORTS);
  const canUseAi = hasPermission(Permission.CAN_GENERATE_PHOTOGRAPHIC_REPORT_AI);
  const canFinalize = hasPermission(Permission.CAN_FINALIZE_PHOTOGRAPHIC_REPORT);
  const canExportPdf = hasPermission(Permission.CAN_EXPORT_PHOTOGRAPHIC_REPORT_PDF);
  const canExportWord = hasPermission(Permission.CAN_EXPORT_PHOTOGRAPHIC_REPORT_WORD);

  // ── Core state ──────────────────────────────────────────────────────────
  const [report, setReport] = useState<PhotographicReport | null>(null);
  const [form, setForm] = useState<ReportFormState>(DEFAULT_FORM_STATE);
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [savingImageId, setSavingImageId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  /** Último upload saiu sem geolocalização — usado para avisar no passo 2. */
  const [geoDenied, setGeoDenied] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "word" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Upload state ─────────────────────────────────────────────────────────
  const [uploadDayId, setUploadDayId] = useState("");
  const [uploadActivityDate, setUploadActivityDate] = useState("");
  const [uploadManualCaption, setUploadManualCaption] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [pendingPhotos, setPendingPhotos] = useState<PendingPhoto[]>([]);
  const [processingProgress, setProcessingProgress] = useState({ completed: 0, total: 0 });

  const processingControllerRef = useRef<AbortController | null>(null);
  const processingGenerationRef = useRef(0);
  const activePendingIdsRef = useRef<Set<string>>(new Set());
  const retryGenerationRef = useRef<Map<string, number>>(new Map());
  const mountedRef = useRef(true);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  // ── Load report ──────────────────────────────────────────────────────────
  const reloadReport = async (id = reportId) => {
    if (!id) return;
    const data = await photographicReportsService.findOne(id);
    setReport(data);
    setForm(reportToForm(data));
    setUploadDayId(data.days[0]?.id || "");
  };

  useEffect(() => {
    if (mode === "create" || !reportId) {
      setLoading(false);
      return;
    }

    let mounted = true;
    setLoading(true);
    setError(null);

    photographicReportsService
      .findOne(reportId)
      .then((data) => {
        if (!mounted) return;
        setReport(data);
        setForm(reportToForm(data));
        setUploadDayId(data.days[0]?.id || "");
        setCurrentStep(resolveInitialStep(data, searchParams.get("step")));
      })
      .catch(async (err) => {
        if (!mounted) return;
        setError(
          await extractApiErrorMessage(err, "Não foi possível carregar o relatório fotográfico."),
        );
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, reportId]);

  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      mountedRef.current = false;
      processingGenerationRef.current += 1;
      processingControllerRef.current?.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  // ── Derived state ────────────────────────────────────────────────────────
  const sortedDays = useMemo(
    () =>
      [...(report?.days || [])].sort((a, b) => a.activity_date.localeCompare(b.activity_date)),
    [report?.days],
  );

  const groupedImages = useMemo(() => {
    const dayMap = new Map(sortedDays.map((day) => [day.id, day]));
    const groups = new Map<string, PhotographicReportImage[]>();

    (report?.images || []).forEach((image) => {
      const key = image.report_day_id || "unassigned";
      const current = groups.get(key) || [];
      current.push(image);
      groups.set(key, current);
    });

    const orderedKeys = [
      ...sortedDays.map((day) => day.id),
      ...(groups.has("unassigned") ? ["unassigned"] : []),
    ];

    return orderedKeys.map((key) => ({
      day: key === "unassigned" ? null : dayMap.get(key) || null,
      items: (groups.get(key) || []).sort((a, b) => a.image_order - b.image_order),
    }));
  }, [report?.images, sortedDays]);

  // ── Form helpers ─────────────────────────────────────────────────────────
  function updateForm<K extends keyof ReportFormState>(key: K, value: ReportFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateImageInState(
    imageId: string,
    updater: (current: PhotographicReportImage) => PhotographicReportImage,
  ) {
    setReport((current) => {
      if (!current) return current;
      return { ...current, images: current.images.map((img) => img.id === imageId ? updater(img) : img) };
    });
  }

  // ── Upload helpers ───────────────────────────────────────────────────────
  const revokePendingPreviews = () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
  };

  const handleSelectedImages = async (files: File[]) => {
    processingControllerRef.current?.abort();
    const generation = ++processingGenerationRef.current;
    revokePendingPreviews();
    const controller = new AbortController();
    processingControllerRef.current = controller;
    const entries: PendingPhoto[] = files.map((original, index) => ({
      id: `photo-${generation}-${index}`,
      original,
      status: "processing",
      // Capturado AQUI, antes do processamento: processMobileImage re-encoda
      // via canvas e destrói o EXIF. `lastModified` sobrevive e, em câmera de
      // celular, é a hora em que a foto foi tirada.
      capturedAt: original.lastModified
        ? new Date(original.lastModified).toISOString()
        : undefined,
    }));
    activePendingIdsRef.current = new Set(entries.map((e) => e.id));
    setPendingPhotos(entries);
    setSelectedFiles([]);
    setProcessingProgress({ completed: 0, total: files.length });
    if (!files.length) return;

    const result = await processMobileImages(files, {
      signal: controller.signal,
      onProgress: (completed, total) => {
        if (mountedRef.current && processingGenerationRef.current === generation) {
          setProcessingProgress({ completed, total });
        }
      },
    });
    if (!mountedRef.current || processingGenerationRef.current !== generation) return;

    const successes = new Map(result.processed.map((item) => [item.sourceFile, item]));
    const failures = new Map(result.rejected.map((item) => [item.file, item]));
    const next = entries.flatMap((entry): PendingPhoto[] => {
      if (!activePendingIdsRef.current.has(entry.id)) return [];
      const processed = successes.get(entry.original);
      if (processed) {
        const previewUrl = URL.createObjectURL(processed.file);
        previewUrlsRef.current.add(previewUrl);
        return [{ ...entry, processed, previewUrl, status: "ready" }];
      }
      const failure = failures.get(entry.original);
      return [{
        ...entry,
        status: failure?.code === "cancelled" ? "cancelled" : "error",
        error: failure?.message || "Imagem não processada.",
      }];
    });
    setPendingPhotos(next);
    setSelectedFiles(next.flatMap((e) => e.processed ? [e.processed.file] : []));
    if (result.rejected.length) {
      toast.warning(`${result.rejected.length} foto(s) rejeitada(s); as demais continuam disponíveis.`);
    }
  };

  const retryPendingPhoto = async (id: string) => {
    const entry = pendingPhotos.find((item) => item.id === id);
    if (!entry || !activePendingIdsRef.current.has(id)) return;
    const retryGeneration = (retryGenerationRef.current.get(id) || 0) + 1;
    retryGenerationRef.current.set(id, retryGeneration);
    setPendingPhotos((current) =>
      current.map((item) =>
        item.id === id && item.original === entry.original
          ? { ...item, status: "processing", error: undefined }
          : item,
      ),
    );
    try {
      const processed = await processMobileImage(entry.original);
      if (!mountedRef.current || !activePendingIdsRef.current.has(id) || retryGenerationRef.current.get(id) !== retryGeneration) return;
      const previewUrl = URL.createObjectURL(processed.file);
      previewUrlsRef.current.add(previewUrl);
      setPendingPhotos((current) =>
        current.map((item) =>
          item.id === id && item.original === entry.original
            ? { ...item, processed, previewUrl, status: "ready" }
            : item,
        ),
      );
      setSelectedFiles((current) => {
        const without = entry.processed ? current.filter((f) => f !== entry.processed?.file) : current;
        return [...without, processed.file];
      });
    } catch (err) {
      if (!mountedRef.current || !activePendingIdsRef.current.has(id) || retryGenerationRef.current.get(id) !== retryGeneration) return;
      setPendingPhotos((current) =>
        current.map((item) =>
          item.id === id && item.original === entry.original
            ? { ...item, status: "error", error: err instanceof Error ? err.message : "Falha ao processar imagem." }
            : item,
        ),
      );
    }
  };

  const removePendingPhoto = (id: string) => {
    activePendingIdsRef.current.delete(id);
    retryGenerationRef.current.set(id, (retryGenerationRef.current.get(id) || 0) + 1);
    const entry = pendingPhotos.find((item) => item.id === id);
    if (entry?.previewUrl) {
      URL.revokeObjectURL(entry.previewUrl);
      previewUrlsRef.current.delete(entry.previewUrl);
    }
    setPendingPhotos((current) => current.filter((item) => item.id !== id));
    if (entry?.processed) setSelectedFiles((current) => current.filter((f) => f !== entry.processed?.file));
  };

  // ── API handlers ──────────────────────────────────────────────────────────

  async function handleCreateReport() {
    try {
      setSaving(true);
      const created = await photographicReportsService.create(formToCreatePayload(form));
      toast.success("Relatório fotográfico criado.");
      router.push(`/dashboard/relatorios/fotografico/${created.id}?step=2`);
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível criar o relatório fotográfico."));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDraft() {
    if (!report) return;
    try {
      setSaving(true);
      const updated = await photographicReportsService.saveDraft(report.id, formToUpdatePayload(form));
      setReport(updated);
      setForm(reportToForm(updated));
      toast.success("Rascunho salvo.");
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível salvar o rascunho."));
    } finally {
      setSaving(false);
    }
  }

  async function handleUploadImages() {
    if (!report) return;
    const readyFiles = pendingPhotos.flatMap((e) =>
      e.status === "ready" && e.processed ? [e.processed.file] : [],
    );
    if (pendingPhotos.some((e) => e.status === "processing")) {
      toast.error("Aguarde o processamento das fotos.");
      return;
    }
    if (!readyFiles.length) {
      toast.error("Selecione ao menos uma foto.");
      return;
    }
    try {
      setUploading(true);

      // A geolocalização nunca bloqueia o envio: ela é buscada aqui e o que
      // tiver retornado até o POST é o que segue. Negada ou indisponível, o
      // upload acontece igual — só com a evidência mais fraca.
      const geo = await captureUploadGeoContext();

      const updated = await photographicReportsService.uploadImages(
        report.id,
        readyFiles,
        {
          report_day_id: uploadDayId || null,
          activity_date: uploadDayId ? null : toNullableString(uploadActivityDate),
          manual_caption: toNullableString(uploadManualCaption),
          latitude: geo.latitude,
          longitude: geo.longitude,
          accuracy_m: geo.accuracy_m,
          // `processMobileImage` sempre re-encoda neste fluxo. A flag faz o
          // PDF declarar que o hash não comprova autoria da captura.
          client_reencoded: true,
          captured_at_list: buildCapturedAtList(pendingPhotos),
        } satisfies UploadPhotographicReportImagesDto,
      );
      setReport(updated);
      setSelectedFiles([]);
      setPendingPhotos([]);
      revokePendingPreviews();
      setProcessingProgress({ completed: 0, total: 0 });
      setUploadManualCaption("");

      // Degradação silenciosa derrotaria o propósito: o usuário precisa saber
      // que o manifesto sairá sem localização.
      if (geo.denied) {
        setGeoDenied(true);
        toast.success(
          "Fotos enviadas. Localização não registrada — o navegador negou ou não suporta geolocalização.",
        );
      } else {
        setGeoDenied(false);
        toast.success("Fotos enviadas com sucesso.");
      }
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível enviar as fotos."));
    } finally {
      setUploading(false);
    }
  }

  async function handleSaveImage(imageId: string, payload: PhotoCardSavePayload) {
    if (!report) return;
    const dto: UpdatePhotographicReportImageDto = {
      report_day_id: payload.report_day_id,
      manual_caption: payload.manual_caption,
      ai_title: payload.ai_title ?? null,
      ai_description: payload.ai_description ?? null,
      ai_positive_points: payload.ai_positive_points ?? undefined,
      ai_technical_assessment: payload.ai_technical_assessment ?? null,
      ai_condition_classification: payload.ai_condition_classification,
      ai_recommendations: payload.ai_recommendations ?? undefined,
      // `?? undefined` aqui é intencional: enviar `null` limparia o campo, e
      // o backend só grava o que vem definido no payload.
      photo_conditions: payload.photo_conditions ?? undefined,
      is_nonconformity: payload.is_nonconformity,
      recommended_action: payload.recommended_action ?? null,
      action_deadline: payload.action_deadline ?? null,
      action_responsible: payload.action_responsible ?? null,
    };
    try {
      setSavingImageId(imageId);
      const updated = await photographicReportsService.updateImage(report.id, imageId, dto);
      updateImageInState(imageId, (current) => ({ ...current, ...updated }));
      toast.success("Foto atualizada.");
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível atualizar a foto."));
    } finally {
      setSavingImageId(null);
    }
  }

  async function handleAnalyzeImage(imageId: string) {
    if (!report) return;
    try {
      setSavingImageId(imageId);
      const updated = await photographicReportsService.analyzeImage(report.id, imageId);
      updateImageInState(imageId, (current) => ({ ...current, ...updated }));
      toast.success("Descrição gerada pela IA.");
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível analisar a foto."));
    } finally {
      setSavingImageId(null);
    }
  }

  async function handleAnalyzeAllImages() {
    if (!report) return;
    try {
      setAnalyzing(true);
      const updated = await photographicReportsService.analyzeAllImages(report.id);
      setReport(updated);
      setForm(reportToForm(updated));
      toast.success("Fotos analisadas com sucesso.");
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível analisar as fotos."));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleGenerateSummary() {
    if (!report) return;
    try {
      setAnalyzing(true);
      const updated = await photographicReportsService.generateReportSummary(report.id);
      setReport(updated);
      setForm(reportToForm(updated));
      toast.success("Relatório completo gerado.");
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível gerar o relatório completo."));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleFinalize() {
    if (!report) return;
    try {
      setSaving(true);
      const updated = await photographicReportsService.finalize(report.id);
      setReport(updated);
      setForm(reportToForm(updated));
      toast.success("Relatório finalizado.");
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível finalizar o relatório."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteImage(imageId: string) {
    if (!report) return;
    if (!window.confirm("Deseja excluir esta foto do relatório?")) return;
    try {
      setSavingImageId(imageId);
      const updated = await photographicReportsService.removeImage(report.id, imageId);
      setReport(updated);
      toast.success("Foto removida.");
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível remover a foto."));
    } finally {
      setSavingImageId(null);
    }
  }

  async function handleExport(type: "pdf" | "word") {
    if (!report) return;
    try {
      setExporting(type);
      const blob =
        type === "pdf"
          ? await photographicReportsService.exportPdf(report.id)
          : await photographicReportsService.exportWord(report.id);
      downloadBlob(blob, buildExportFileName(report, type));
      toast.success(`Exportação em ${type === "pdf" ? "PDF" : "Word"} concluída.`);
      await reloadReport(report.id);
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, `Não foi possível exportar em ${type === "pdf" ? "PDF" : "Word"}.`));
    } finally {
      setExporting(null);
    }
  }

  async function handleDownloadExport(entry: PhotographicReportExport) {
    if (!report) return;
    try {
      if (entry.download_url) {
        openSafeExternalUrlInNewTab(entry.download_url);
        return;
      }
      const blob = await photographicReportsService.downloadExport(report.id, entry.id);
      downloadBlob(blob, entry.file_url.split("/").pop() || buildExportFileName(report, entry.export_type));
    } catch (err) {
      toast.error(await extractApiErrorMessage(err, "Não foi possível baixar a exportação."));
    }
  }

  // ── Step navigation ───────────────────────────────────────────────────────

  async function handleStep1Next() {
    if (mode === "create" || !report) {
      await handleCreateReport();
      // navigation handled inside handleCreateReport (router.push with ?step=2)
    } else {
      await handleSaveDraft();
      setCurrentStep(2);
    }
  }

  async function handleStep2Next() {
    if (report) {
      await handleSaveDraft();
    }
    setCurrentStep(3);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center text-[var(--ds-color-text-muted)]">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <Card tone="muted" padding="lg">
        <CardHeader>
          <CardTitle>Relatório fotográfico</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const isCreateMode = mode === "create" || !report;

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-start gap-3">
        <Badge variant="primary">
          <FileText className="h-3.5 w-3.5" />
          Relatório Fotográfico
        </Badge>
        {!isCreateMode && (
          <Badge variant="neutral">{report?.status || "Rascunho"}</Badge>
        )}
      </div>

      {/* Wizard progress bar */}
      {!isCreateMode && (
        <WizardProgressBar
          currentStep={currentStep}
          onStepClick={(step) => setCurrentStep(step)}
        />
      )}

      {/* Step content */}
      {isCreateMode ? (
        <WizardStep1BasicData
          form={form}
          onFormChange={updateForm}
          canManage={canManage}
          mode="create"
          onNext={() => void handleStep1Next()}
          saving={saving}
        />
      ) : currentStep === 1 ? (
        <WizardStep1BasicData
          form={form}
          onFormChange={updateForm}
          canManage={canManage}
          mode="edit"
          onNext={() => void handleStep1Next()}
          saving={saving}
        />
      ) : currentStep === 2 ? (
        <WizardStep2Photos
          report={report!}
          sortedDays={sortedDays}
          groupedImages={groupedImages}
          canManage={canManage}
          canUseAi={canUseAi}
          savingImageId={savingImageId}
          uploading={uploading}
          geoDenied={geoDenied}
          analyzing={analyzing}
          pendingPhotos={pendingPhotos}
          processingProgress={processingProgress}
          selectedFiles={selectedFiles}
          uploadDayId={uploadDayId}
          uploadActivityDate={uploadActivityDate}
          uploadManualCaption={uploadManualCaption}
          processingControllerRef={processingControllerRef}
          onFilesSelected={(files) => void handleSelectedImages(files)}
          onRemovePending={removePendingPhoto}
          onRetryPending={(id) => void retryPendingPhoto(id)}
          onCancelProcessing={() => processingControllerRef.current?.abort()}
          onUploadDayIdChange={setUploadDayId}
          onUploadActivityDateChange={setUploadActivityDate}
          onUploadManualCaptionChange={setUploadManualCaption}
          onUpload={() => void handleUploadImages()}
          onSaveImage={(id, payload) => void handleSaveImage(id, payload)}
          onAnalyzeImage={(id) => void handleAnalyzeImage(id)}
          onAnalyzeAll={() => void handleAnalyzeAllImages()}
          onDeleteImage={(id) => void handleDeleteImage(id)}
          onNext={() => void handleStep2Next()}
          onBack={() => setCurrentStep(1)}
          saving={saving}
        />
      ) : (
        <WizardStep3Review
          report={report!}
          form={{ ai_summary: form.ai_summary, final_conclusion: form.final_conclusion }}
          onFormChange={(key, value) => updateForm(key, value)}
          canManage={canManage}
          canUseAi={canUseAi}
          canFinalize={canFinalize}
          canExportPdf={canExportPdf}
          canExportWord={canExportWord}
          saving={saving}
          analyzing={analyzing}
          exporting={exporting}
          onSaveDraft={() => void handleSaveDraft()}
          onGenerateSummary={() => void handleGenerateSummary()}
          onFinalize={() => void handleFinalize()}
          onExportPdf={() => void handleExport("pdf")}
          onExportWord={() => void handleExport("word")}
          onDownloadExport={(entry) => void handleDownloadExport(entry)}
          onBack={() => setCurrentStep(2)}
        />
      )}
    </div>
  );
}
