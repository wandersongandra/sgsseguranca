"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  ArrowUp,
  BrainCircuit,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SendMailModal } from "@/components/SendMailModal";
import { extractApiErrorMessage } from "@/lib/error-handler";
import { Permission } from "@/lib/permissions";
import { openSafeExternalUrlInNewTab, safeExternalArtifactUrl } from "@/lib/security/safe-external-url";
import {
  processMobileImage,
  processMobileImages,
  type ProcessedMobileImage,
} from "@/lib/images/process-mobile-image";
import {
  photographicReportsService,
  type CreatePhotographicReportDto,
  type PhotographicReport,
  type PhotographicReportAreaStatus,
  type PhotographicReportExport,
  type PhotographicReportImage,
  type PhotographicReportShift,
  type PhotographicReportStatus,
  type PhotographicReportTone,
  type UpdatePhotographicReportDayDto,
  type UpdatePhotographicReportDto,
  type UpdatePhotographicReportImageDto,
  type UploadPhotographicReportImagesDto,
} from "@/services/photographicReportsService";

type WorkspaceMode = "create" | "edit";

type ReportFormState = {
  client_id: string;
  project_id: string;
  client_name: string;
  project_name: string;
  unit_name: string;
  location: string;
  activity_type: string;
  report_tone: PhotographicReportTone;
  area_status: PhotographicReportAreaStatus;
  shift: PhotographicReportShift;
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  responsible_name: string;
  contractor_company: string;
  general_observations: string;
  ai_summary: string;
  final_conclusion: string;
  status: PhotographicReportStatus;
};

type PendingPhoto = {
  id: string;
  original: File;
  processed?: ProcessedMobileImage;
  previewUrl?: string;
  status: "processing" | "ready" | "error" | "cancelled";
  error?: string;
};

const PHOTO_CLASSIFICATIONS = [
  "Satisfatória",
  "Positiva",
  "Muito satisfatória",
  "Ponto de atenção preventivo",
] as const;

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
  contractor_company: "",
  general_observations: "",
  ai_summary: "",
  final_conclusion: "",
  status: "Rascunho",
};

function splitLines(value: string | null | undefined): string[] {
  return String(value || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function joinLines(value: string[] | null | undefined): string {
  return (value || []).join("\n");
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
    start_time: report.start_time || "",
    end_time: report.end_time || "",
    responsible_name: report.responsible_name || "",
    contractor_company: report.contractor_company || "",
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
    start_time: form.start_time.trim().slice(0, 5),
    end_time: form.end_time.trim().slice(0, 5),
    responsible_name: form.responsible_name.trim(),
    contractor_company: form.contractor_company.trim(),
    general_observations: toNullableString(form.general_observations),
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
    start_time: form.start_time.trim().slice(0, 5),
    end_time: form.end_time.trim().slice(0, 5),
    responsible_name: form.responsible_name.trim(),
    contractor_company: form.contractor_company.trim(),
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
  const base = [
    report.client_name,
    report.project_name,
    report.activity_type,
  ]
    .map((value) =>
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    )
    .filter(Boolean)
    .join("_")
    .slice(0, 80);

  const stamp = format(new Date(), "yyyyMMdd_HHmm");
  return `RELATORIO_FOTOGRAFICO_${base || "documento"}_${stamp}.${exportType === "pdf" ? "pdf" : "docx"}`;
}

export function PhotographicReportWorkspace({
  mode,
  reportId,
}: {
  mode: WorkspaceMode;
  reportId?: string;
}) {
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(Permission.CAN_MANAGE_PHOTOGRAPHIC_REPORTS);
  const canUseAi = hasPermission(
    Permission.CAN_GENERATE_PHOTOGRAPHIC_REPORT_AI,
  );
  const canFinalize = hasPermission(
    Permission.CAN_FINALIZE_PHOTOGRAPHIC_REPORT,
  );
  const canExportPdf = hasPermission(
    Permission.CAN_EXPORT_PHOTOGRAPHIC_REPORT_PDF,
  );
  const canExportWord = hasPermission(
    Permission.CAN_EXPORT_PHOTOGRAPHIC_REPORT_WORD,
  );

  const [report, setReport] = useState<PhotographicReport | null>(null);
  const [form, setForm] = useState<ReportFormState>(DEFAULT_FORM_STATE);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [savingImageId, setSavingImageId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "word" | null>(null);
  const [isMailModalOpen, setIsMailModalOpen] = useState(false);
  const [newDayDate, setNewDayDate] = useState("");
  const [newDaySummary, setNewDaySummary] = useState("");
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
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reloadReport = async (currentReportId = reportId) => {
    if (!currentReportId) {
      return;
    }

    const data = await photographicReportsService.findOne(currentReportId);
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
      })
      .catch(async (err) => {
        if (!mounted) return;
        setError(
          await extractApiErrorMessage(
            err,
            "Não foi possível carregar o relatório fotográfico.",
          ),
        );
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
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
    }));
    activePendingIdsRef.current = new Set(entries.map((entry) => entry.id));
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
      // A remoção durante o decode é definitiva: não cria URL nem ressurge.
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
    setSelectedFiles(next.flatMap((entry) => entry.processed ? [entry.processed.file] : []));
    if (result.rejected.length) toast.warning(`${result.rejected.length} foto(s) rejeitada(s); as demais continuam disponíveis.`);
  };

  const retryPendingPhoto = async (id: string) => {
    const entry = pendingPhotos.find((item) => item.id === id);
    if (!entry || !activePendingIdsRef.current.has(id)) return;
    const retryGeneration = (retryGenerationRef.current.get(id) || 0) + 1;
    retryGenerationRef.current.set(id, retryGeneration);
    setPendingPhotos((current) => current.map((item) => item.id === id && item.original === entry.original ? { ...item, status: "processing", error: undefined } : item));
    try {
      const processed = await processMobileImage(entry.original);
      if (!mountedRef.current || !activePendingIdsRef.current.has(id) || retryGenerationRef.current.get(id) !== retryGeneration) return;
      const previewUrl = URL.createObjectURL(processed.file);
      previewUrlsRef.current.add(previewUrl);
      setPendingPhotos((current) => current.map((item) => item.id === id && item.original === entry.original ? { ...item, processed, previewUrl, status: "ready" } : item));
      setSelectedFiles((current) => {
        const withoutPreviousIdentity = entry.processed
          ? current.filter((file) => file !== entry.processed?.file)
          : current;
        return [...withoutPreviousIdentity, processed.file];
      });
    } catch (retryError) {
      if (!mountedRef.current || !activePendingIdsRef.current.has(id) || retryGenerationRef.current.get(id) !== retryGeneration) return;
      setPendingPhotos((current) => current.map((item) => item.id === id && item.original === entry.original ? {
        ...item,
        status: "error",
        error: retryError instanceof Error ? retryError.message : "Falha ao processar imagem.",
      } : item));
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
    if (entry?.processed) setSelectedFiles((current) => current.filter((file) => file !== entry.processed?.file));
  };

  const sortedDays = useMemo(
    () =>
      [...(report?.days || [])].sort((left, right) =>
        left.activity_date.localeCompare(right.activity_date),
      ),
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
      items: (groups.get(key) || []).sort(
        (left, right) => left.image_order - right.image_order,
      ),
    }));
  }, [report?.images, sortedDays]);

  function updateForm<K extends keyof ReportFormState>(
    key: K,
    value: ReportFormState[K],
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function updateImageField(
    imageId: string,
    updater: (current: PhotographicReportImage) => PhotographicReportImage,
  ) {
    setReport((current) => {
      if (!current) return current;
      return {
        ...current,
        images: current.images.map((image) =>
          image.id === imageId ? updater(image) : image,
        ),
      };
    });
  }

  async function handleCreateReport() {
    try {
      setSaving(true);
      const created = await photographicReportsService.create(
        formToCreatePayload(form),
      );
      toast.success("Relatório fotográfico criado.");
      router.push(`/dashboard/photographic-reports/${created.id}`);
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível criar o relatório fotográfico.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDraft() {
    if (!report) return;

    try {
      setSaving(true);
      const updated = await photographicReportsService.saveDraft(
        report.id,
        formToUpdatePayload(form),
      );
      setReport(updated);
      setForm(reportToForm(updated));
      toast.success("Rascunho salvo.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível salvar o rascunho do relatório.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateDay() {
    if (!report) return;
    if (!newDayDate.trim()) {
      toast.error("Informe uma data para a nova frente de serviço.");
      return;
    }

    try {
      setSaving(true);
      const updated = await photographicReportsService.createDay(report.id, {
        activity_date: newDayDate,
        day_summary: toNullableString(newDaySummary),
      });
      setReport(updated);
      setNewDayDate("");
      setNewDaySummary("");
      toast.success("Data adicionada ao relatório.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível adicionar a data ao relatório.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDay(dayId: string) {
    if (!report) return;
    const day = report.days.find((item) => item.id === dayId);
    if (!day) return;

    const dayDateInput = document.getElementById(
      `day-date-${dayId}`,
    ) as HTMLInputElement | null;
    const daySummaryInput = document.getElementById(
      `day-summary-${dayId}`,
    ) as HTMLTextAreaElement | null;

    const payload: UpdatePhotographicReportDayDto = {
      activity_date: dayDateInput?.value || day.activity_date,
      day_summary: toNullableString(daySummaryInput?.value || ""),
    };

    try {
      setSaving(true);
      const updated = await photographicReportsService.updateDay(
        report.id,
        dayId,
        payload,
      );
      setReport(updated);
      toast.success("Data atualizada.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível atualizar a data.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteDay(dayId: string) {
    if (!report) return;
    if (!window.confirm("Deseja excluir esta data e manter as fotos vinculadas?")) {
      return;
    }

    try {
      setSaving(true);
      const updated = await photographicReportsService.removeDay(report.id, dayId);
      setReport(updated);
      toast.success("Data removida.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível remover a data.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleUploadImages() {
    if (!report) return;
    const readyFiles = pendingPhotos.flatMap((entry) =>
      entry.status === "ready" && entry.processed ? [entry.processed.file] : [],
    );
    if (pendingPhotos.some((entry) => entry.status === "processing")) {
      toast.error("Aguarde o processamento das fotos.");
      return;
    }
    if (!readyFiles.length) {
      toast.error("Selecione ao menos uma foto.");
      return;
    }

    try {
      setUploading(true);
      const updated = await photographicReportsService.uploadImages(
        report.id,
        readyFiles,
        {
          report_day_id: uploadDayId || null,
          activity_date: uploadDayId ? null : toNullableString(uploadActivityDate),
          manual_caption: toNullableString(uploadManualCaption),
        } satisfies UploadPhotographicReportImagesDto,
      );
      setReport(updated);
      setSelectedFiles([]);
      setPendingPhotos([]);
      revokePendingPreviews();
      setProcessingProgress({ completed: 0, total: 0 });
      setUploadManualCaption("");
      toast.success("Fotos enviadas com sucesso.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível enviar as fotos.",
        ),
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleSaveImage(imageId: string) {
    if (!report) return;
    const image = report.images.find((item) => item.id === imageId);
    if (!image) return;

    const daySelect = document.getElementById(
      `image-day-${imageId}`,
    ) as HTMLSelectElement | null;
    const captionInput = document.getElementById(
      `image-caption-${imageId}`,
    ) as HTMLTextAreaElement | null;
    const titleInput = document.getElementById(
      `image-title-${imageId}`,
    ) as HTMLInputElement | null;
    const descInput = document.getElementById(
      `image-description-${imageId}`,
    ) as HTMLTextAreaElement | null;
    const pointsInput = document.getElementById(
      `image-points-${imageId}`,
    ) as HTMLTextAreaElement | null;
    const assessmentInput = document.getElementById(
      `image-assessment-${imageId}`,
    ) as HTMLTextAreaElement | null;
    const classificationInput = document.getElementById(
      `image-classification-${imageId}`,
    ) as HTMLSelectElement | null;
    const recommendationsInput = document.getElementById(
      `image-recommendations-${imageId}`,
    ) as HTMLTextAreaElement | null;

    const payload: UpdatePhotographicReportImageDto = {
      report_day_id: daySelect?.value || null,
      manual_caption: toNullableString(captionInput?.value || ""),
      ai_title: toNullableString(titleInput?.value || ""),
      ai_description: toNullableString(descInput?.value || ""),
      ai_positive_points: splitLines(pointsInput?.value || ""),
      ai_technical_assessment: toNullableString(assessmentInput?.value || ""),
      ai_condition_classification: classificationInput?.value || null,
      ai_recommendations: splitLines(recommendationsInput?.value || ""),
    };

    try {
      setSavingImageId(imageId);
      const updated = await photographicReportsService.updateImage(
        report.id,
        imageId,
        payload,
      );
      updateImageField(imageId, (current) => ({
        ...current,
        ...updated,
      }));
      toast.success("Foto atualizada.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(err, "Não foi possível atualizar a foto."),
      );
    } finally {
      setSavingImageId(null);
    }
  }

  async function handleAnalyzeImage(imageId: string) {
    if (!report) return;

    try {
      setSavingImageId(imageId);
      const updated = await photographicReportsService.analyzeImage(
        report.id,
        imageId,
      );
      updateImageField(imageId, (current) => ({
        ...current,
        ...updated,
      }));
      toast.success("Descrição gerada pela IA.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível analisar a foto.",
        ),
      );
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
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível analisar as fotos.",
        ),
      );
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleGenerateSummary() {
    if (!report) return;

    try {
      setAnalyzing(true);
      const updated = await photographicReportsService.generateReportSummary(
        report.id,
      );
      setReport(updated);
      setForm(reportToForm(updated));
      toast.success("Relatório completo gerado.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível gerar o relatório completo.",
        ),
      );
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
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível finalizar o relatório.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteImage(imageId: string) {
    if (!report) return;
    if (!window.confirm("Deseja excluir esta foto do relatório?")) {
      return;
    }

    try {
      setSavingImageId(imageId);
      const updated = await photographicReportsService.removeImage(
        report.id,
        imageId,
      );
      setReport(updated);
      toast.success("Foto removida.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(err, "Não foi possível remover a foto."),
      );
    } finally {
      setSavingImageId(null);
    }
  }

  async function handleReorderImages() {
    if (!report) return;

    try {
      setSaving(true);
      const ordered = [...report.images]
        .map((image) => {
          const orderInput = document.getElementById(
            `image-order-${image.id}`,
          ) as HTMLInputElement | null;
          return {
            id: image.id,
            order: Number(orderInput?.value || image.image_order || 0),
          };
        })
        .sort((left, right) => left.order - right.order)
        .map((item) => item.id);
      const updated = await photographicReportsService.reorderImages(
        report.id,
        { imageIds: ordered },
      );
      setReport(updated);
      toast.success("Ordem das fotos salva.");
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          "Não foi possível salvar a ordem das fotos.",
        ),
      );
    } finally {
      setSaving(false);
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
      const fileName = buildExportFileName(report, type);
      downloadBlob(blob, fileName);
      toast.success(`Exportação em ${type === "pdf" ? "PDF" : "Word"} concluída.`);
      await reloadReport(report.id);
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(
          err,
          `Não foi possível exportar em ${type === "pdf" ? "PDF" : "Word"}.`,
        ),
      );
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

      const blob = await photographicReportsService.downloadExport(
        report.id,
        entry.id,
      );
      downloadBlob(
        blob,
        entry.file_url.split("/").pop() || buildExportFileName(report, entry.export_type),
      );
    } catch (err) {
      toast.error(
        await extractApiErrorMessage(err, "Não foi possível baixar a exportação."),
      );
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center text-[var(--color-text-secondary)]">
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
    <div className="space-y-6">
      <Card tone="default" padding="lg">
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="primary">
                <FileText className="h-3.5 w-3.5" />
                Relatório Fotográfico
              </Badge>
              {!isCreateMode ? (
                <Badge variant="neutral">{report?.status || "Rascunho"}</Badge>
              ) : null}
            </div>
            <CardTitle className="text-2xl">
              {isCreateMode ? "Novo relatório fotográfico" : report?.client_name}
            </CardTitle>
            <CardDescription>
              {isCreateMode
                ? "Crie o relatório e depois organize fotos, datas, análises e exportações."
                : "Edite os dados gerais, carregue fotos, gere textos com IA e exporte o documento final."}
            </CardDescription>
          </div>

          <div className="flex flex-wrap gap-2">
            {isCreateMode ? (
              <Button
                type="button"
                onClick={() => void handleCreateReport()}
                loading={saving}
                leftIcon={!saving ? <Plus className="h-4 w-4" /> : undefined}
                disabled={!canManage}
              >
                Criar relatório
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleSaveDraft()}
                  loading={saving}
                  leftIcon={!saving ? <Save className="h-4 w-4" /> : undefined}
                  disabled={!canManage}
                >
                  Salvar rascunho
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleGenerateSummary()}
                  loading={analyzing}
                  leftIcon={!analyzing ? <BrainCircuit className="h-4 w-4" /> : undefined}
                  disabled={!canUseAi}
                >
                  Gerar relatório completo
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleAnalyzeAllImages()}
                  loading={analyzing}
                  leftIcon={!analyzing ? <RefreshCw className="h-4 w-4" /> : undefined}
                  disabled={!canUseAi}
                >
                  Analisar fotos
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleFinalize()}
                  loading={saving}
                  leftIcon={!saving ? <Save className="h-4 w-4" /> : undefined}
                  disabled={!canFinalize}
                >
                  Finalizar relatório
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleExport("word")}
                  loading={exporting === "word"}
                  leftIcon={!exporting ? <Download className="h-4 w-4" /> : undefined}
                  disabled={!canExportWord}
                >
                  Exportar Word
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleExport("pdf")}
                  loading={exporting === "pdf"}
                  leftIcon={!exporting ? <Download className="h-4 w-4" /> : undefined}
                  disabled={!canExportPdf}
                >
                  Exportar PDF
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsMailModalOpen(true)}
                  leftIcon={<Mail className="h-4 w-4" />}
                  disabled={!canManage || !report?.exports?.some((e) => e.export_type === "pdf")}
                  title={
                    !report?.exports?.some((e) => e.export_type === "pdf")
                      ? "Exporte o relatório em PDF antes de enviar por e-mail"
                      : undefined
                  }
                >
                  Enviar por e-mail
                </Button>
              </>
            )}
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <Card tone="default" padding="lg">
          <CardHeader>
            <CardTitle className="text-lg">Dados da obra e atividade</CardTitle>
            <CardDescription>
              Preencha os campos de contexto antes de publicar ou exportar.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Cliente"
              value={form.client_name}
              onChange={(value) => updateForm("client_name", value)}
            />
            <Field
              label="Obra"
              value={form.project_name}
              onChange={(value) => updateForm("project_name", value)}
            />
            <Field
              label="Unidade"
              value={form.unit_name}
              onChange={(value) => updateForm("unit_name", value)}
            />
            <Field
              label="Local específico"
              value={form.location}
              onChange={(value) => updateForm("location", value)}
            />
            <Field
              label="Tipo de atividade executada"
              value={form.activity_type}
              onChange={(value) => updateForm("activity_type", value)}
              className="md:col-span-2"
            />
            <SelectField
              label="Tom do relatório"
              value={form.report_tone}
              onChange={(value) => updateForm("report_tone", value as PhotographicReportTone)}
              options={["Positivo", "Técnico", "Preventivo"]}
            />
            <SelectField
              label="Condição da área"
              value={form.area_status}
              onChange={(value) => updateForm("area_status", value as PhotographicReportAreaStatus)}
              options={["Loja aberta", "Loja fechada", "Área controlada", "Área isolada"]}
            />
            <SelectField
              label="Turno"
              value={form.shift}
              onChange={(value) => updateForm("shift", value as PhotographicReportShift)}
              options={["Diurno", "Noturno", "Integral"]}
            />
            <Field
              label="Data inicial"
              type="date"
              value={form.start_date}
              onChange={(value) => updateForm("start_date", value)}
            />
            <Field
              label="Data final"
              type="date"
              value={form.end_date}
              onChange={(value) => updateForm("end_date", value)}
            />
            <Field
              label="Horário de início"
              type="time"
              value={form.start_time}
              onChange={(value) => updateForm("start_time", value)}
            />
            <Field
              label="Horário de término"
              type="time"
              value={form.end_time}
              onChange={(value) => updateForm("end_time", value)}
            />
            <Field
              label="Responsável pelo relatório"
              value={form.responsible_name}
              onChange={(value) => updateForm("responsible_name", value)}
              className="md:col-span-2"
            />
            <Field
              label="Empresa executora"
              value={form.contractor_company}
              onChange={(value) => updateForm("contractor_company", value)}
              className="md:col-span-2"
            />
            <Field
              label="Código cliente"
              value={form.client_id}
              onChange={(value) => updateForm("client_id", value)}
            />
            <Field
              label="Código obra"
              value={form.project_id}
              onChange={(value) => updateForm("project_id", value)}
            />
            <TextAreaField
              label="Observações gerais"
              value={form.general_observations}
              onChange={(value) => updateForm("general_observations", value)}
              className="md:col-span-2"
            />
            <TextAreaField
              label="Síntese da IA"
              value={form.ai_summary}
              onChange={(value) => updateForm("ai_summary", value)}
              className="md:col-span-2"
            />
            <TextAreaField
              label="Conclusão final"
              value={form.final_conclusion}
              onChange={(value) => updateForm("final_conclusion", value)}
              className="md:col-span-2"
            />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card tone="default" padding="lg">
            <CardHeader>
              <CardTitle className="text-lg">Datas da atividade</CardTitle>
              <CardDescription>
                Separe as fotos por dia, evento ou frente de serviço.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3">
                <Field
                  label="Nova data"
                  type="date"
                  value={newDayDate}
                  onChange={(value) => setNewDayDate(value)}
                />
                <TextAreaField
                  label="Resumo do dia"
                  value={newDaySummary}
                  onChange={(value) => setNewDaySummary(value)}
                />
                <Button
                  type="button"
                  onClick={() => void handleCreateDay()}
                  loading={saving}
                  leftIcon={<Plus className="h-4 w-4" />}
                  disabled={!canManage}
                >
                  Adicionar data
                </Button>
              </div>

              <div className="space-y-3">
                {sortedDays.length === 0 ? (
                  <div className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--color-border-subtle)] px-4 py-6 text-sm text-[var(--color-text-secondary)]">
                    Nenhuma data cadastrada ainda.
                  </div>
                ) : (
                  sortedDays.map((day) => (
                    <div
                      key={`${day.id}-${day.updated_at}`}
                      className="rounded-[var(--ds-radius-lg)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)]/70 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-[var(--color-text)]">
                            {format(new Date(day.activity_date), "dd/MM/yyyy")}
                          </p>
                          <p className="text-xs text-[var(--color-text-secondary)]">
                            {day.image_count || 0} foto(s)
                          </p>
                        </div>
                        <button
                          type="button"
                          className="text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]"
                          onClick={() => void handleDeleteDay(day.id)}
                          title="Excluir data"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-3 grid gap-3">
                        <Field
                          label="Data"
                          type="date"
                          value={day.activity_date}
                          defaultValue={day.activity_date}
                          id={`day-date-${day.id}`}
                          onChange={undefined}
                        />
                        <TextAreaField
                          label="Resumo"
                          value={day.day_summary || ""}
                          defaultValue={day.day_summary || ""}
                          id={`day-summary-${day.id}`}
                          onChange={undefined}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void handleSaveDay(day.id)}
                          loading={saving}
                          leftIcon={<Save className="h-4 w-4" />}
                          disabled={!canManage}
                        >
                          Salvar data
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card tone="default" padding="lg">
            <CardHeader>
              <CardTitle className="text-lg">Upload das fotos</CardTitle>
              <CardDescription>
                Adicione imagens, organize depois e gere as análises com IA.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--color-border-subtle)] bg-[color:var(--color-surface)]/70 p-4"
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const files = Array.from(event.dataTransfer.files || []).filter((file) =>
                    file.type.startsWith("image/"),
                  );
                  if (files.length > 0) {
                    void handleSelectedImages(files);
                  }
                }}
              >
                <div className="flex flex-col items-center gap-3 text-center">
                  <Upload className="h-8 w-8 text-[var(--color-primary)]" />
                  <div>
                    <p className="text-sm font-semibold text-[var(--color-text)]">
                      Arraste e solte imagens aqui
                    </p>
                    <p className="text-sm text-[var(--color-text-secondary)]">
                      ou use o botão abaixo para selecionar arquivos.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    leftIcon={<ImageIcon className="h-4 w-4" />}
                  >
                    Adicionar fotos
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      void handleSelectedImages(files);
                      event.target.value = "";
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <Field
                  label="Vincular a uma data existente"
                  value={uploadDayId}
                  onChange={(value) => setUploadDayId(value)}
                  type="select"
                  options={[""]}
                  selectOptions={[
                    { label: "Sem vinculação", value: "" },
                    ...sortedDays.map((day) => ({
                      label: format(new Date(day.activity_date), "dd/MM/yyyy"),
                      value: day.id,
                    })),
                  ]}
                />
                {!uploadDayId ? (
                  <Field
                    label="Data da foto"
                    type="date"
                    value={uploadActivityDate}
                    onChange={(value) => setUploadActivityDate(value)}
                  />
                ) : null}
                <TextAreaField
                  label="Legenda manual padrão"
                  value={uploadManualCaption}
                  onChange={(value) => setUploadManualCaption(value)}
                />
              </div>

              {pendingPhotos.length > 0 ? (
                <div className="space-y-3 rounded-[var(--ds-radius-lg)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)]/70 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-[var(--color-text)]">
                      {selectedFiles.length} pronta(s) de {pendingPhotos.length}
                    </p>
                    {pendingPhotos.some((photo) => photo.status === "processing") ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => processingControllerRef.current?.abort()} leftIcon={<X className="h-3.5 w-3.5" />}>
                        Cancelar
                      </Button>
                    ) : null}
                  </div>
                  {processingProgress.total > 0 ? (
                    <div aria-label="Progresso do processamento" role="progressbar" aria-valuemin={0} aria-valuemax={processingProgress.total} aria-valuenow={processingProgress.completed} className="h-2 overflow-hidden rounded-full bg-[var(--color-border-subtle)]">
                      <div className="h-full bg-[var(--color-primary)] transition-all" style={{ width: `${Math.round((processingProgress.completed / processingProgress.total) * 100)}%` }} />
                    </div>
                  ) : null}
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {pendingPhotos.map((photo) => (
                      <li key={photo.id} className="flex gap-3 rounded-lg border border-[var(--color-border-subtle)] p-2">
                        {photo.previewUrl ? (
                          // URL local temporária, liberada ao trocar seleção/desmontar.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={photo.previewUrl} alt={`Prévia de ${photo.original.name}`} className="h-16 w-16 rounded object-cover" />
                        ) : (
                          <div className="flex h-16 w-16 items-center justify-center rounded bg-[var(--color-surface-elevated)]"><ImageIcon className="h-5 w-5" /></div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{photo.original.name}</p>
                          <p className="text-xs text-[var(--color-text-secondary)]">
                            {photo.status === "processing" ? "Otimizando…" : photo.status === "ready" ? `${Math.round((photo.processed?.outputBytes || 0) / 1024)} KB · pronta` : photo.error}
                          </p>
                          {(photo.status === "error" || photo.status === "cancelled") ? (
                            <button type="button" className="mt-1 text-xs font-semibold text-[var(--color-primary)]" onClick={() => void retryPendingPhoto(photo.id)}>Tentar novamente</button>
                          ) : null}
                        </div>
                        <button type="button" aria-label={`Remover ${photo.original.name}`} onClick={() => removePendingPhoto(photo.id)}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <Button
                type="button"
                onClick={() => void handleUploadImages()}
                loading={uploading}
                leftIcon={<Upload className="h-4 w-4" />}
                disabled={!canManage || selectedFiles.length === 0 || pendingPhotos.some((photo) => photo.status === "processing")}
              >
                Enviar fotos
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {!isCreateMode && report ? (
        <>
          <Card tone="default" padding="lg">
            <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1.5">
                <CardTitle className="text-lg">Fotos e análise por imagem</CardTitle>
                <CardDescription>
                  Edite a legenda, a análise da IA e a classificação de cada foto.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleReorderImages()}
                loading={saving}
                leftIcon={<ArrowUp className="h-4 w-4" />}
              >
                Salvar ordem
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              {groupedImages.length === 0 ? (
                <div className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--color-border-subtle)] px-4 py-10 text-center text-sm text-[var(--color-text-secondary)]">
                  Nenhuma foto enviada ainda.
                </div>
              ) : (
                groupedImages.map((group) => (
                  <div key={group.day?.id || "unassigned"} className="space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[var(--color-text)]">
                          {group.day
                            ? `Data ${format(new Date(group.day.activity_date), "dd/MM/yyyy")}`
                            : "Fotos sem data vinculada"}
                        </p>
                        {group.day?.day_summary ? (
                          <p className="text-sm text-[var(--color-text-secondary)]">
                            {group.day.day_summary}
                          </p>
                        ) : null}
                      </div>
                      <Badge variant="neutral">{group.items.length} foto(s)</Badge>
                    </div>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                      {group.items.map((image) => (
                        <div
                          key={`${image.id}-${image.updated_at}`}
                          className="rounded-[var(--ds-radius-xl)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)]/80 p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-[var(--color-text)]">
                                Foto {String(image.image_order).padStart(2, "0")}
                              </p>
                              <p className="text-xs text-[var(--color-text-secondary)]">
                                {image.ai_condition_classification || "Sem análise"}
                              </p>
                            </div>
                            <button
                              type="button"
                              aria-label={`Excluir foto ${String(image.image_order).padStart(2, "0")}`}
                              onClick={() => void handleDeleteImage(image.id)}
                              className="text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </div>

                          <div className="mt-3 overflow-hidden rounded-[var(--ds-radius-lg)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface-elevated)]">
                            {(() => {
                              const imageSrc = safeExternalArtifactUrl(image.download_url || image.image_url);
                              return imageSrc ? (
                              <Image
                                src={imageSrc}
                                alt={image.ai_title || image.manual_caption || "Foto do relatório"}
                                width={800}
                                height={224}
                                className="h-56 w-full object-cover"
                                unoptimized
                              />
                              ) : (
                              <div className="flex h-56 items-center justify-center text-[var(--color-text-secondary)]">
                                <ImageIcon className="h-8 w-8" />
                              </div>
                              );
                            })()}
                          </div>

                          <div className="mt-4 grid grid-cols-1 gap-3">
                            <Field
                              label="Ordem"
                              type="number"
                              value={String(image.image_order)}
                              defaultValue={String(image.image_order)}
                              id={`image-order-${image.id}`}
                              onChange={undefined}
                            />
                            <Field
                              label="Data"
                              type="select"
                              value={image.report_day_id || ""}
                              defaultValue={image.report_day_id || ""}
                              id={`image-day-${image.id}`}
                              onChange={undefined}
                              selectOptions={[
                                { label: "Sem data", value: "" },
                                ...sortedDays.map((day) => ({
                                  label: format(new Date(day.activity_date), "dd/MM/yyyy"),
                                  value: day.id,
                                })),
                              ]}
                            />
                            <Field
                              label="Título"
                              value={image.ai_title || ""}
                              defaultValue={image.ai_title || ""}
                              id={`image-title-${image.id}`}
                              onChange={undefined}
                            />
                            <TextAreaField
                              label="Legenda manual"
                              value={image.manual_caption || ""}
                              defaultValue={image.manual_caption || ""}
                              id={`image-caption-${image.id}`}
                              onChange={undefined}
                            />
                            <TextAreaField
                              label="Descrição"
                              value={image.ai_description || ""}
                              defaultValue={image.ai_description || ""}
                              id={`image-description-${image.id}`}
                              onChange={undefined}
                            />
                            <TextAreaField
                              label="Pontos positivos observados"
                              value={joinLines(image.ai_positive_points)}
                              defaultValue={joinLines(image.ai_positive_points)}
                              id={`image-points-${image.id}`}
                              onChange={undefined}
                            />
                            <TextAreaField
                              label="Avaliação técnica"
                              value={image.ai_technical_assessment || ""}
                              defaultValue={image.ai_technical_assessment || ""}
                              id={`image-assessment-${image.id}`}
                              onChange={undefined}
                            />
                            <SelectField
                              label="Classificação"
                              value={image.ai_condition_classification || "Satisfatória"}
                              defaultValue={image.ai_condition_classification || "Satisfatória"}
                              id={`image-classification-${image.id}`}
                              onChange={undefined}
                              options={[...PHOTO_CLASSIFICATIONS]}
                            />
                            <TextAreaField
                              label="Recomendação preventiva"
                              value={joinLines(image.ai_recommendations)}
                              defaultValue={joinLines(image.ai_recommendations)}
                              id={`image-recommendations-${image.id}`}
                              onChange={undefined}
                            />
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void handleAnalyzeImage(image.id)}
                                loading={savingImageId === image.id}
                                leftIcon={<BrainCircuit className="h-4 w-4" />}
                                disabled={!canUseAi}
                              >
                                Regenerar descrição desta foto
                              </Button>
                              <Button
                                type="button"
                                onClick={() => void handleSaveImage(image.id)}
                                loading={savingImageId === image.id}
                                leftIcon={<Save className="h-4 w-4" />}
                                disabled={!canManage}
                              >
                                Salvar foto
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card tone="default" padding="lg">
              <CardHeader>
                <CardTitle className="text-lg">Resumo e conclusão</CardTitle>
                <CardDescription>
                  Ajuste o texto final antes da exportação.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <TextAreaField
                  label="Síntese da IA"
                  value={form.ai_summary}
                  onChange={(value) => updateForm("ai_summary", value)}
                />
                <TextAreaField
                  label="Conclusão final"
                  value={form.final_conclusion}
                  onChange={(value) => updateForm("final_conclusion", value)}
                />
                <Button
                  type="button"
                  onClick={() => void handleSaveDraft()}
                  loading={saving}
                  leftIcon={<Save className="h-4 w-4" />}
                  disabled={!canManage}
                >
                  Salvar edição
                </Button>
              </CardContent>
            </Card>

            <Card tone="default" padding="lg">
              <CardHeader>
                <CardTitle className="text-lg">Histórico de exportações</CardTitle>
                <CardDescription>
                  Word e PDF gerados ficam registrados aqui.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {report.exports.length === 0 ? (
                  <div className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--color-border-subtle)] px-4 py-6 text-sm text-[var(--color-text-secondary)]">
                    Nenhuma exportação registrada.
                  </div>
                ) : (
                  report.exports.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-[var(--ds-radius-lg)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)]/75 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-[var(--color-text)]">
                            {entry.export_type.toUpperCase()}
                          </p>
                          <p className="text-xs text-[var(--color-text-secondary)]">
                            {format(new Date(entry.generated_at), "dd/MM/yyyy HH:mm", {
                              locale: ptBR,
                            })}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleDownloadExport(entry)}
                          className="text-[var(--color-primary)] hover:underline"
                        >
                          Baixar
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}

      {report && (
        <SendMailModal
          isOpen={isMailModalOpen}
          onClose={() => setIsMailModalOpen(false)}
          documentName={`Relatório Fotográfico — ${report.client_name} / ${report.project_name}`}
          filename={buildExportFileName(report, "pdf")}
          storedDocument={{ documentId: report.id, documentType: "PHOTOGRAPHIC_REPORT" }}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  className,
  id,
  options,
  selectOptions,
  defaultValue,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  type?: "text" | "date" | "time" | "number" | "select";
  className?: string;
  id?: string;
  options?: string[];
  selectOptions?: Array<{ label: string; value: string }>;
  defaultValue?: string;
}) {
  return (
    <label className={`space-y-2 ${className || ""}`}>
      <span className="text-sm font-medium text-[var(--color-text)]">
        {label}
      </span>
      {type === "select" ? (
        <select
          id={id}
          value={onChange ? value : undefined}
          defaultValue={onChange ? undefined : defaultValue ?? value}
          onChange={
            onChange ? (event) => onChange(event.target.value) : undefined
          }
          className="w-full rounded-[var(--ds-radius-md)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--ds-color-action-primary)]"
        >
          {(selectOptions || options || []).map((option) =>
            typeof option === "string" ? (
              <option key={option} value={option}>
                {option}
              </option>
            ) : (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ),
          )}
        </select>
      ) : (
        <input
          id={id}
          type={type}
          value={onChange ? value : undefined}
          defaultValue={onChange ? undefined : defaultValue ?? value}
          onChange={
            onChange ? (event) => onChange(event.target.value) : undefined
          }
          className="w-full rounded-[var(--ds-radius-md)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--ds-color-action-primary)]"
        />
      )}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  className,
  id,
  options,
  defaultValue,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  className?: string;
  id?: string;
  options: string[];
  defaultValue?: string;
}) {
  return (
    <Field
      label={label}
      value={value}
      onChange={onChange}
      type="select"
      className={className}
      id={id}
      options={options}
      defaultValue={defaultValue}
    />
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  className,
  id,
  defaultValue,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  className?: string;
  id?: string;
  defaultValue?: string;
}) {
  return (
    <label className={`space-y-2 ${className || ""}`}>
      <span className="text-sm font-medium text-[var(--color-text)]">
        {label}
      </span>
      <textarea
        id={id}
        rows={4}
        value={onChange ? value : undefined}
        defaultValue={onChange ? undefined : defaultValue ?? value}
        onChange={
          onChange ? (event) => onChange(event.target.value) : undefined
        }
        className="w-full rounded-[var(--ds-radius-md)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--ds-color-action-primary)]"
      />
    </label>
  );
}
