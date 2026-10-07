"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  FileCheck,
  FileText,
  Info,
  Loader2,
  Search,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import { useAiConsent } from "@/hooks/useAiConsent";
import { Permission } from '@/lib/permissions';
import { PageHeader } from "@/components/layout";
import { StatusPill } from "@/components/ui/status-pill";
import {
  documentImportService,
  type CreateDdsDraftFromImportInput,
  type DocumentImportDomainStatus,
  type DocumentImportEnqueueResponse,
  type DocumentImportJobSnapshot,
  type DocumentImportStatusResponse,
} from "@/services/documentImportService";
import { ddsService, type DdsPerson } from "@/services/ddsService";
import { sitesService, type Site } from "@/services/sitesService";
import { safeToLocaleDateString } from "@/lib/date/safeFormat";
import {
  ACCEPTED_IMPORT_FILE_TYPES,
  ALLOWED_IMPORT_EXTENSIONS,
  isAllowedImportFile,
} from "./importFileValidation";

const DOCUMENT_LABELS: Record<string, string> = {
  apr: "APR",
  pt: "PT",
  checklist: "Checklist",
  dds: "DDS",
  nc: "Não Conformidade",
};

const DOCUMENT_TYPE_UPLOAD_MAP: Record<string, string> = {
  apr: "APR",
  pt: "PT",
  checklist: "CHECKLIST",
  dds: "DDS",
  nc: "NC",
};

const POLLING_INTERVAL_MS = 2500;

const TERMINAL_STATUSES = new Set<string>([
  "COMPLETED",
  "FAILED",
  "DEAD_LETTER",
  "CANCELLED",
]);

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "CanceledError" || candidate.code === "ERR_CANCELED"
  );
}

function generateIdempotencyKey() {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }

  return `import-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function toDateInputValue(value?: string | null) {
  if (!value) {
    return new Date().toISOString().slice(0, 10);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value.slice(0, 10);
  }

  return parsed.toISOString().slice(0, 10);
}

function getProgressFromImportStatus(
  status: DocumentImportDomainStatus,
  queueState?: string | null,
) {
  if (status === "QUEUED") {
    return queueState === "delayed" ? 15 : 20;
  }

  switch (status) {
    case "UPLOADED":
      return 10;
    case "PROCESSING":
      return 45;
    case "INTERPRETING":
      return 65;
    case "VALIDATING":
      return 85;
    case "COMPLETED":
      return 100;
    case "FAILED":
    case "DEAD_LETTER":
      return 100;
    default:
      return 10;
  }
}

function getStatusLabel(status: DocumentImportDomainStatus) {
  switch (status) {
    case "UPLOADED":
      return "Recebido";
    case "QUEUED":
      return "Na fila";
    case "PROCESSING":
      return "Extraindo conteúdo";
    case "INTERPRETING":
      return "Interpretando";
    case "VALIDATING":
      return "Validando";
    case "COMPLETED":
      return "Concluído";
    case "FAILED":
      return "Falhou";
    case "DEAD_LETTER":
      return "Falha permanente";
    default:
      return status;
  }
}

function getQueueStateLabel(queueState?: string | null) {
  switch (queueState) {
    case "waiting":
      return "Aguardando worker";
    case "delayed":
      return "Aguardando retry";
    case "active":
      return "Em processamento";
    case "completed":
      return "Processado";
    case "failed":
      return "Falhou";
    case "retry_pending":
      return "Retry pendente";
    case "dead_letter":
      return "Direcionado ao DLQ";
    case "enqueue_failed":
      return "Falha ao enfileirar";
    case "unknown":
      return "Estado indefinido";
    case "uploaded":
      return "Recebido";
    default:
      return queueState || "Aguardando atualização";
  }
}

function extractErrorMessage(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "data" in error.response &&
    error.response.data &&
    typeof error.response.data === "object" &&
    "message" in error.response.data &&
    typeof error.response.data.message === "string"
  ) {
    return error.response.data.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Erro ao processar documento.";
}

export default function DocumentImportPage() {
  const { user, hasPermission } = useAuth();
  const { consentGiven, requestConsent, ConsentGate } = useAiConsent();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [enqueueResponse, setEnqueueResponse] =
    useState<DocumentImportEnqueueResponse | null>(null);
  const [statusResponse, setStatusResponse] =
    useState<DocumentImportStatusResponse | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [ddsPeople, setDdsPeople] = useState<DdsPerson[]>([]);
  const [loadingDdsReferences, setLoadingDdsReferences] = useState(false);
  const [creatingDdsDraft, setCreatingDdsDraft] = useState(false);
  const [createdDdsId, setCreatedDdsId] = useState<string | null>(null);
  const [ddsDraftForm, setDdsDraftForm] =
    useState<CreateDdsDraftFromImportInput>({
      tema: "",
      conteudo: "",
      data: "",
      site_id: "",
      facilitador_id: "",
      participants: [],
    });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const terminalToastRef = useRef<string | null>(null);
  const operationKeyRef = useRef<string | null>(null);
  const requestedDocumentType = searchParams.get("documentType") || "";
  const requestedDocumentLabel = DOCUMENT_LABELS[requestedDocumentType] || null;
  const canImportDocuments = hasPermission(Permission.CAN_IMPORT_DOCUMENTS);
  const canManageDds = hasPermission(Permission.CAN_MANAGE_DDS);

  const currentStatus =
    statusResponse?.status ?? enqueueResponse?.status ?? null;
  const currentJob: DocumentImportJobSnapshot | null =
    statusResponse?.job ?? enqueueResponse?.job ?? null;
  const currentMessage =
    statusResponse?.message ??
    enqueueResponse?.message ??
    "Documento recebido para processamento.";
  const showCompletedResult = Boolean(
    statusResponse?.completed &&
    statusResponse.analysis &&
    statusResponse.validation,
  );
  const analysis = statusResponse?.analysis;
  const validation = statusResponse?.validation;
  const isDdsImportResult = Boolean(
    showCompletedResult &&
    ((requestedDocumentType &&
      DOCUMENT_TYPE_UPLOAD_MAP[requestedDocumentType] === "DDS") ||
      statusResponse?.tipoDocumento === "DDS" ||
      analysis?.tipoDocumento === "DDS"),
  );

  useEffect(() => {
    const documentId = enqueueResponse?.documentId;
    if (!documentId) {
      return;
    }

    let isMounted = true;
    let inFlight = false;
    let reachedTerminal = TERMINAL_STATUSES.has(enqueueResponse.status);
    let timeoutRef: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    const stopPolling = () => {
      if (timeoutRef) {
        clearTimeout(timeoutRef);
        timeoutRef = null;
      }
    };

    const abortActiveRequest = () => {
      activeController?.abort();
      activeController = null;
    };

    const isPageVisible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";

    const syncStatus = async () => {
      if (!isMounted || inFlight || reachedTerminal || !isPageVisible()) {
        return;
      }

      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      try {
        const response = await documentImportService.getImportStatus(
          documentId,
          controller.signal,
        );

        if (!isMounted || controller.signal.aborted) {
          return;
        }

        setStatusResponse(response);
        setProgress(
          getProgressFromImportStatus(response.status, response.job.queueState),
        );

        if (TERMINAL_STATUSES.has(response.status)) {
          reachedTerminal = true;
          setPolling(false);
          stopPolling();

          if (terminalToastRef.current !== documentId) {
            terminalToastRef.current = documentId;

            if (response.completed) {
              toast.success(
                response.message || "Documento processado com sucesso.",
              );
            } else {
              toast.error(
                response.message ||
                  "A importação falhou e precisa de intervenção manual.",
              );
            }
          }
        } else {
          setPolling(true);
        }
      } catch (error) {
        if (!isMounted || controller.signal.aborted || isAbortError(error)) {
          return;
        }

        reachedTerminal = true;
        stopPolling();
        setPolling(false);
        setUploading(false);
        toast.error(extractErrorMessage(error));
      } finally {
        if (activeController === controller) {
          activeController = null;
        }
        inFlight = false;
        if (isMounted && !controller.signal.aborted) {
          setUploading(false);
        }
      }
    };

    const scheduleNext = () => {
      stopPolling();
      if (!isMounted || reachedTerminal) {
        return;
      }

      timeoutRef = setTimeout(async () => {
        if (!isMounted) {
          return;
        }

        if (!isPageVisible()) {
          scheduleNext();
          return;
        }

        await syncStatus();
        scheduleNext();
      }, POLLING_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (!isMounted) {
        return;
      }

      if (document.visibilityState === "visible") {
        void syncStatus();
        scheduleNext();
        return;
      }

      stopPolling();
    };

    void syncStatus();
    if (!reachedTerminal) {
      setPolling(true);
      scheduleNext();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isMounted = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      abortActiveRequest();
      stopPolling();
    };
  }, [enqueueResponse?.documentId, enqueueResponse?.status]);

  useEffect(() => {
    if (!isDdsImportResult || !analysis) {
      return;
    }

    setDdsDraftForm((current) => ({
      ...current,
      tema:
        current.tema ||
        analysis.tema ||
        analysis.resumo ||
        `DDS importado: ${file?.name || "documento"}`,
      conteudo: current.conteudo || analysis.conteudo || analysis.resumo || "",
      data: current.data || toDateInputValue(analysis.data),
    }));
  }, [analysis, file?.name, isDdsImportResult]);

  useEffect(() => {
    if (!isDdsImportResult || sites.length > 0) {
      return;
    }

    let cancelled = false;
    setLoadingDdsReferences(true);
    sitesService
      .findAll(user?.company_id)
      .then((items) => {
        if (!cancelled) {
          setSites(items);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(extractErrorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDdsReferences(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDdsImportResult, sites.length, user?.company_id]);

  useEffect(() => {
    if (!isDdsImportResult || !ddsDraftForm.site_id) {
      setDdsPeople([]);
      return;
    }

    let cancelled = false;
    setLoadingDdsReferences(true);
    ddsService
      .listAllPeople({
        companyId: user?.company_id,
        siteId: ddsDraftForm.site_id,
      })
      .then((items) => {
        if (!cancelled) {
          setDdsPeople(items);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(extractErrorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDdsReferences(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ddsDraftForm.site_id, isDdsImportResult, user?.company_id]);

  const resetFlowState = () => {
    setUploading(false);
    setPolling(false);
    setProgress(0);
    setEnqueueResponse(null);
    setStatusResponse(null);
    setCreatedDdsId(null);
    setDdsDraftForm({
      tema: "",
      conteudo: "",
      data: "",
      site_id: "",
      facilitador_id: "",
      participants: [],
    });
  };

  const reset = () => {
    setFile(null);
    setFileError(null);
    resetFlowState();
    terminalToastRef.current = null;
    operationKeyRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleFileSelection = (selectedFile?: File) => {
    if (!selectedFile) {
      return;
    }

    if (!isAllowedImportFile(selectedFile)) {
      const message =
        "Formato não suportado. Envie PDF, DOCX, XLSX, imagem, TXT ou CSV.";
      setFileError(message);
      toast.error(message);
      return;
    }

    setFileError(null);
    setFile(selectedFile);
    resetFlowState();
    terminalToastRef.current = null;
    operationKeyRef.current = generateIdempotencyKey();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();

    if (!canImportDocuments) {
      toast.error("Você não possui permissão para importar documentos.");
      return;
    }

    setIsDragging(false);
    handleFileSelection(e.dataTransfer.files[0]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canImportDocuments) {
      toast.error("Você não possui permissão para importar documentos.");
      return;
    }

    handleFileSelection(e.target.files?.[0]);
  };

  const handleUpload = async () => {
    if (!canImportDocuments) {
      toast.error("Você não possui permissão para importar documentos.");
      return;
    }

    if (!consentGiven) {
      toast.info("Confirme o consentimento para processamento por IA antes de importar.");
      requestConsent();
      return;
    }

    if (!file) {
      return;
    }

    setUploading(true);
    setPolling(false);
    setProgress(0);
    setEnqueueResponse(null);
    setStatusResponse(null);

    const idempotencyKey = operationKeyRef.current || generateIdempotencyKey();
    operationKeyRef.current = idempotencyKey;

    try {
      const response = await documentImportService.importDocument({
        file,
        empresaId: user?.company_id,
        tipoDocumento:
          requestedDocumentType &&
          DOCUMENT_TYPE_UPLOAD_MAP[requestedDocumentType]
            ? DOCUMENT_TYPE_UPLOAD_MAP[requestedDocumentType]
            : undefined,
        idempotencyKey,
        onUploadProgress: (percent) => setProgress(percent),
      });

      setEnqueueResponse(response);
      setProgress(
        getProgressFromImportStatus(response.status, response.job.queueState),
      );
      if (response.reused) {
        toast.info(
          response.message || "Operação reutilizada sem criar nova importação.",
        );
      } else {
        toast.success(
          response.message ||
            "Documento recebido e enviado para processamento.",
        );
      }
    } catch (error) {
      toast.error(extractErrorMessage(error));
      setUploading(false);
      setPolling(false);
      setProgress(0);
    }
  };

  const handleCreateDdsDraft = async () => {
    const documentId = statusResponse?.documentId;
    if (!documentId) {
      return;
    }

    if (!canManageDds) {
      toast.error("Você não possui permissão para criar DDS.");
      return;
    }

    if (
      !ddsDraftForm.tema.trim() ||
      !ddsDraftForm.data ||
      !ddsDraftForm.site_id ||
      !ddsDraftForm.facilitador_id
    ) {
      toast.error(
        "Preencha tema, data, obra e facilitador antes de criar DDS.",
      );
      return;
    }

    setCreatingDdsDraft(true);
    try {
      const result = await documentImportService.createDdsDraftFromImport(
        documentId,
        {
          ...ddsDraftForm,
          tema: ddsDraftForm.tema.trim(),
          conteudo: ddsDraftForm.conteudo?.trim(),
          participants: ddsDraftForm.participants?.filter(Boolean),
        },
      );
      setCreatedDdsId(result.ddsId);
      toast.success("Rascunho de DDS criado para validação final.");
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setCreatingDdsDraft(false);
    }
  };

  return (
    <div className="ds-form-page mx-auto max-w-6xl space-y-8 p-6">
      <ConsentGate />
      <PageHeader
        eyebrow="Importação assistida"
        title="Importação Inteligente de Documentos"
        description={
          requestedDocumentLabel
            ? `Fluxo preparado para anexar um arquivo (${ALLOWED_IMPORT_EXTENSIONS.join(", ")}) de ${requestedDocumentLabel} já emitido, sem refazer o preenchimento no sistema.`
            : "Faça upload de documentos SST para extração automática, validação técnica e acompanhamento assíncrono."
        }
        icon={
          <div className="rounded-full bg-[color:var(--ds-color-primary-subtle)] p-2.5 text-[var(--ds-color-text-primary)]">
            <Upload className="h-5 w-5" />
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="info">
              {requestedDocumentLabel || "Fluxo multiformato"}
            </StatusPill>
            <StatusPill tone={canImportDocuments ? "success" : "warning"}>
              {canImportDocuments ? "Importação liberada" : "Sem permissão"}
            </StatusPill>
            {currentStatus ? (
              <StatusPill
                tone={
                  currentStatus === "COMPLETED"
                    ? "success"
                    : currentStatus === "FAILED" ||
                        currentStatus === "DEAD_LETTER"
                      ? "danger"
                      : "primary"
                }
              >
                {getStatusLabel(currentStatus)}
              </StatusPill>
            ) : null}
          </div>
        }
      />

      <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.05em] text-[var(--ds-color-text-secondary)]">
          Importação de documento
        </p>
        <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
          Envie o PDF, acompanhe o processamento e confira o resultado da importação.
        </p>
        <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
          Quando houver pendências ou campos duvidosos, revise o documento antes de confirmar os dados.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            aria-describedby="document-import-instructions document-import-error"
            className={`
              relative flex flex-col items-center justify-center gap-4 rounded-[var(--ds-radius-lg)] border-2 border-dashed p-6 text-center motion-safe:transition-colors
              ${isDragging ? "border-primary bg-primary/5" : "border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] hover:border-[var(--ds-color-border-strong)]"}
              ${file ? "border-[var(--ds-color-success)] bg-[var(--ds-color-success-subtle)]" : ""}
            `}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept={ACCEPTED_IMPORT_FILE_TYPES}
              disabled={!canImportDocuments || uploading || polling}
              className="hidden"
              title="Upload de documento SST"
              aria-label="Upload de documento SST"
            />

            <div
              className={`rounded-full p-3.5 ${file ? "bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success)]" : "bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-text-primary)]"}`}
            >
              {file ? <FileCheck size={28} /> : <Upload size={28} />}
            </div>

            <div className="space-y-1">
              <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                {file ? file.name : "Arraste o documento aqui ou selecione abaixo"}
              </p>
              <p id="document-import-instructions" className="text-[13px] text-[var(--ds-color-text-secondary)]">
                Arraste um arquivo para esta área ou use o botão de seleção. PDF,
                DOCX, XLSX, imagens, TXT ou CSV até 10MB
              </p>
              <button
                type="button"
                disabled={!canImportDocuments || uploading || polling}
                onClick={() => fileInputRef.current?.click()}
                aria-describedby="document-import-instructions document-import-error"
                className="mt-3 rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-4 py-2 text-sm font-medium text-[var(--ds-color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Selecionar documento SST
              </button>
              <p
                id="document-import-error"
                role={fileError ? "alert" : undefined}
                aria-live="polite"
                className="text-[13px] font-medium text-[var(--ds-color-danger)]"
              >
                {fileError}
              </p>
            </div>

            {file &&
              !uploading &&
              !polling &&
              !enqueueResponse &&
              canImportDocuments && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleUpload();
                  }}
                  className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--ds-color-action-primary)] px-4 py-2 text-[13px] font-medium text-[var(--ds-color-action-primary-foreground)] motion-safe:transition-colors hover:bg-[var(--ds-color-action-primary-hover)]"
                >
                  Enviar para fila <ChevronRight size={18} />
                </button>
              )}

            {!canImportDocuments && (
              <div
                role="alert"
                className="mt-3.5 w-full rounded-lg border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] px-3 py-2"
              >
                <p className="text-[13px] font-semibold text-[var(--ds-color-warning-fg)]">
                  Importação bloqueada para este usuário
                </p>
                <p className="mt-1 text-[13px] text-[var(--ds-color-warning-fg)]">
                  Você não possui permissão <code>can_import_documents</code>{" "}
                  para este fluxo.
                </p>
              </div>
            )}

            {(uploading || polling || currentStatus) && (
              <div className="mt-4 w-full space-y-3">
                <div className="flex justify-between text-sm font-medium text-[var(--ds-color-text-secondary)]">
                  <span>
                    {currentStatus
                      ? getStatusLabel(currentStatus)
                      : "Recebendo documento..."}
                  </span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--ds-color-surface-muted)]">
                  <div
                    className="h-2 rounded-full bg-[var(--ds-color-action-primary)] motion-safe:transition-all motion-safe:duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex items-center justify-center gap-2 text-sm text-[var(--ds-color-text-primary)]">
                  {(uploading || polling) && (
                    <Loader2 size={16} className="motion-safe:animate-spin" />
                  )}
                  <span>{currentMessage}</span>
                </div>
              </div>
            )}

            {(enqueueResponse || statusResponse) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  reset();
                }}
                className="mt-3.5 w-full rounded-lg border border-[var(--ds-color-border-default)] px-4 py-2 text-[13px] font-medium text-[var(--ds-color-text-secondary)] motion-safe:transition-colors hover:bg-[var(--ds-color-surface-muted)]"
              >
                Importar outro arquivo
              </button>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-[var(--ds-color-info-border)] bg-[var(--ds-color-info-subtle)] p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--ds-color-info-fg)]">
              <Info size={16} /> Como funciona?
            </h3>
            <ul className="list-disc space-y-2 pl-4 text-xs text-[var(--ds-color-info-fg)]">
              <li>O request apenas recebe e valida o upload inicial.</li>
              <li>
                O documento segue para fila com retries automáticos e timeout
                controlado.
              </li>
              <li>
                Você pode consultar o status a qualquer momento usando o ID da
                importação.
              </li>
              <li>
                Em falha permanente, o processamento é marcado de forma
                auditável e não fica preso em request longa.
              </li>
            </ul>
          </div>
        </div>

        <div className="lg:col-span-2">
          {showCompletedResult && analysis && validation ? (
            <div className="motion-safe:animate-in slide-in-from-bottom-4 space-y-6 motion-safe:duration-500 fade-in">
              <div className="flex items-center justify-between rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-5 shadow-sm">
                <div className="flex items-center gap-4">
                  <div
                    className={`rounded-xl p-2.5 ${
                      validation.status === "VALIDO"
                        ? "bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success)]"
                        : validation.status === "INCOMPLETO"
                          ? "bg-[var(--ds-color-warning-subtle)] text-[var(--ds-color-warning)]"
                          : "bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger)]"
                    }`}
                  >
                    {validation.status === "VALIDO" ? (
                      <CheckCircle2 size={22} />
                    ) : (
                      <AlertCircle size={22} />
                    )}
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">
                      {statusResponse?.tipoDocumentoDescricao}
                    </h2>
                    <p className="text-[13px] text-[var(--ds-color-text-secondary)]">
                      Status da validação:{" "}
                      <span className="font-semibold">{validation.status}</span>
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="mb-1 text-[13px] text-[var(--ds-color-text-secondary)]">
                    Score de confiança
                  </div>
                  <div
                    className={`text-[1.5rem] font-black ${
                      validation.scoreConfianca > 0.8
                        ? "text-[var(--ds-color-success)]"
                        : validation.scoreConfianca > 0.5
                          ? "text-[var(--ds-color-text-primary)]"
                          : "text-[var(--ds-color-danger)]"
                    }`}
                  >
                    {(validation.scoreConfianca * 100).toFixed(0)}%
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-4 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-5 shadow-sm">
                  <h3 className="flex items-center gap-2 font-semibold text-[var(--ds-color-text-primary)]">
                    <Search
                      size={18}
                      className="text-[var(--ds-color-text-primary)]"
                    />{" "}
                    Informações extraídas
                  </h3>
                  <div className="space-y-3">
                    <DetailItem label="Empresa" value={analysis.empresa} />
                    <DetailItem label="CNPJ" value={analysis.cnpj} />
                    <DetailItem
                      label="Data"
                      value={
                        analysis.data
                          ? safeToLocaleDateString(
                              analysis.data,
                              "pt-BR",
                              undefined,
                              "Não encontrada",
                            )
                          : "Não encontrada"
                      }
                    />
                    <DetailItem
                      label="Resp. Técnico"
                      value={analysis.responsavelTecnico}
                    />
                  </div>
                </div>

                <div className="space-y-4 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-5 shadow-sm">
                  <h3 className="flex items-center gap-2 font-semibold text-[var(--ds-color-text-primary)]">
                    <ShieldCheck
                      size={18}
                      className="text-[var(--ds-color-text-primary)]"
                    />{" "}
                    Validação técnica
                  </h3>
                  {validation.pendencias.length > 0 ? (
                    <div className="space-y-2">
                      {validation.pendencias.map((pendencia, index) => (
                        <div
                          key={index}
                          className="flex gap-2 rounded-lg bg-[var(--ds-color-warning-subtle)] p-2 text-[13px] text-[var(--ds-color-warning)]"
                        >
                          <AlertCircle size={16} className="mt-0.5 shrink-0" />
                          {pendencia}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-6 text-center">
                      <CheckCircle2
                        size={32}
                        className="mb-2 text-[var(--ds-color-success)]"
                      />
                      <p className="text-[13px] font-medium text-[var(--ds-color-success)]">
                        Nenhuma pendência crítica identificada.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {isDdsImportResult && (
                <div className="space-y-4 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                        Criar rascunho DDS
                      </h3>
                      <p className="text-[13px] text-[var(--ds-color-text-secondary)]">
                        Valide os campos extraídos antes de abrir o DDS para o
                        fluxo governado.
                      </p>
                    </div>
                    <StatusPill tone={canManageDds ? "success" : "warning"}>
                      {canManageDds ? "Criação liberada" : "Sem permissão DDS"}
                    </StatusPill>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <label className="space-y-1.5 text-sm font-medium text-[var(--ds-color-text-primary)]">
                      Tema
                      <input
                        value={ddsDraftForm.tema}
                        onChange={(event) =>
                          setDdsDraftForm((current) => ({
                            ...current,
                            tema: event.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-primary)]"
                      />
                    </label>

                    <label className="space-y-1.5 text-sm font-medium text-[var(--ds-color-text-primary)]">
                      Data
                      <input
                        type="date"
                        value={ddsDraftForm.data}
                        onChange={(event) =>
                          setDdsDraftForm((current) => ({
                            ...current,
                            data: event.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-primary)]"
                      />
                    </label>

                    <label className="space-y-1.5 text-sm font-medium text-[var(--ds-color-text-primary)]">
                      Obra/setor
                      <select
                        value={ddsDraftForm.site_id}
                        onChange={(event) =>
                          setDdsDraftForm((current) => ({
                            ...current,
                            site_id: event.target.value,
                            facilitador_id: "",
                            participants: [],
                          }))
                        }
                        className="w-full rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-primary)]"
                      >
                        <option value="">Selecione</option>
                        {sites.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.nome}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1.5 text-sm font-medium text-[var(--ds-color-text-primary)]">
                      Facilitador
                      <select
                        value={ddsDraftForm.facilitador_id}
                        onChange={(event) =>
                          setDdsDraftForm((current) => ({
                            ...current,
                            facilitador_id: event.target.value,
                          }))
                        }
                        disabled={!ddsDraftForm.site_id}
                        className="w-full rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-primary)] disabled:opacity-60"
                      >
                        <option value="">Selecione</option>
                        {ddsPeople.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.nome}
                            {person.funcao ? ` - ${person.funcao}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="space-y-1.5 text-sm font-medium text-[var(--ds-color-text-primary)]">
                    Conteúdo
                    <textarea
                      value={ddsDraftForm.conteudo || ""}
                      onChange={(event) =>
                        setDdsDraftForm((current) => ({
                          ...current,
                          conteudo: event.target.value,
                        }))
                      }
                      rows={7}
                      className="w-full rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-primary)]"
                    />
                  </label>

                  <label className="space-y-1.5 text-sm font-medium text-[var(--ds-color-text-primary)]">
                    Participantes
                    <select
                      multiple
                      value={ddsDraftForm.participants || []}
                      onChange={(event) =>
                        setDdsDraftForm((current) => ({
                          ...current,
                          participants: Array.from(
                            event.currentTarget.selectedOptions,
                          ).map((option) => option.value),
                        }))
                      }
                      disabled={!ddsDraftForm.site_id}
                      className="min-h-28 w-full rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-primary)] disabled:opacity-60"
                    >
                      {ddsPeople.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.nome}
                          {person.funcao ? ` - ${person.funcao}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  {analysis.camposEstruturados &&
                    Array.isArray(analysis.camposEstruturados.participantes) &&
                    analysis.camposEstruturados.participantes.length > 0 && (
                      <div className="rounded-lg border border-[var(--ds-color-info-border)] bg-[var(--ds-color-info-subtle)] px-3 py-2 text-[13px] text-[var(--ds-color-info-fg)]">
                        Participantes citados no documento:{" "}
                        {analysis.camposEstruturados.participantes
                          .map((participant) => {
                            if (typeof participant === "string") {
                              return participant;
                            }
                            if (
                              participant &&
                              typeof participant === "object" &&
                              "nome" in participant &&
                              typeof participant.nome === "string"
                            ) {
                              return participant.nome;
                            }
                            return null;
                          })
                          .filter(Boolean)
                          .join(", ")}
                      </div>
                    )}

                  <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--ds-color-border-subtle)] pt-4">
                    {loadingDdsReferences && (
                      <span className="flex items-center gap-2 text-[13px] text-[var(--ds-color-text-secondary)]">
                        <Loader2
                          size={16}
                          className="motion-safe:animate-spin"
                        />
                        Carregando referências
                      </span>
                    )}
                    {createdDdsId ? (
                      <button
                        type="button"
                        onClick={() =>
                          router.push(`/dashboard/dds/edit/${createdDdsId}`)
                        }
                        className="rounded-lg bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-action-primary-foreground)]"
                      >
                        Abrir rascunho
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!canManageDds || creatingDdsDraft}
                        onClick={() => void handleCreateDdsDraft()}
                        className="rounded-lg bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-semibold text-[var(--ds-color-action-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {creatingDdsDraft
                          ? "Criando rascunho..."
                          : "Criar rascunho DDS"}
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-6 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-5 shadow-sm">
                <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                  <div>
                    <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--ds-color-text-secondary)]">
                      Riscos identificados
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {analysis.riscos.length > 0 ? (
                        analysis.riscos.map((risco, index) => (
                          <span
                            key={index}
                            className="rounded-md border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-2 py-1 text-xs font-medium text-[var(--ds-color-danger)]"
                          >
                            {risco}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-[var(--ds-color-text-secondary)]">
                          Nenhum risco detectado
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--ds-color-text-secondary)]">
                      EPIs citados
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {analysis.epis.length > 0 ? (
                        analysis.epis.map((epi, index) => (
                          <span
                            key={index}
                            className="rounded-md border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] px-2 py-1 text-xs font-medium text-[var(--ds-color-success)]"
                          >
                            {epi}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-[var(--ds-color-text-secondary)]">
                          Nenhum EPI detectado
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="border-t border-[var(--ds-color-border-subtle)] pt-4">
                  <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-[var(--ds-color-text-secondary)]">
                    Normas Regulamentadoras (NRs)
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {analysis.nrsCitadas.length > 0 ? (
                      analysis.nrsCitadas.map((nr, index) => (
                        <span
                          key={index}
                          className="rounded-md border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] px-2 py-1 text-xs font-medium text-[var(--ds-color-warning)]"
                        >
                          {nr}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-[var(--ds-color-text-secondary)]">
                        Nenhuma NR identificada
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : enqueueResponse || statusResponse ? (
            <div className="space-y-6">
              <div className="rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <div
                        className={`rounded-xl p-2.5 ${
                          currentStatus === "COMPLETED"
                            ? "bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success)]"
                            : currentStatus === "FAILED" ||
                                currentStatus === "DEAD_LETTER"
                              ? "bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger)]"
                              : "bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-text-primary)]"
                        }`}
                      >
                        {currentStatus === "FAILED" ||
                        currentStatus === "DEAD_LETTER" ? (
                          <AlertCircle size={22} />
                        ) : currentStatus === "COMPLETED" ? (
                          <CheckCircle2 size={22} />
                        ) : (
                          <Loader2
                            size={22}
                            className="motion-safe:animate-spin"
                          />
                        )}
                      </div>
                      <div>
                        <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">
                          {currentStatus
                            ? getStatusLabel(currentStatus)
                            : "Documento recebido"}
                        </h2>
                        <p className="text-[13px] text-[var(--ds-color-text-secondary)]">
                          {currentMessage}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 pt-2 text-[13px] text-[var(--ds-color-text-secondary)] md:grid-cols-2">
                      <StatusItem
                        label="ID da importação"
                        value={
                          enqueueResponse?.documentId ||
                          statusResponse?.documentId
                        }
                      />
                      <StatusItem
                        label="Queue state"
                        value={getQueueStateLabel(currentJob?.queueState)}
                      />
                      <StatusItem
                        label="Tentativas"
                        value={
                          currentJob?.maxAttempts
                            ? `${currentJob.attemptsMade || 0}/${currentJob.maxAttempts}`
                            : String(currentJob?.attemptsMade || 0)
                        }
                      />
                      <StatusItem
                        label="Status consultável"
                        value={
                          statusResponse?.statusUrl ||
                          enqueueResponse?.statusUrl
                        }
                      />
                      <StatusItem
                        label="Idempotência"
                        value={
                          enqueueResponse?.reused
                            ? enqueueResponse.dedupeSource === "idempotency_key"
                              ? "Reutilizado por chave"
                              : "Reutilizado por hash"
                            : "Nova operação"
                        }
                      />
                    </div>
                  </div>

                  <div className="min-w-[160px] rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] px-4 py-3 text-right">
                    <div className="text-[12px] uppercase tracking-wider text-[var(--ds-color-text-secondary)]">
                      Progresso
                    </div>
                    <div className="text-2xl font-black text-[var(--ds-color-text-primary)]">
                      {progress}%
                    </div>
                  </div>
                </div>
              </div>

              {currentStatus === "DEAD_LETTER" && (
                <div
                  role="alert"
                  className="rounded-xl border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] p-4"
                >
                  <p className="text-sm font-semibold text-[var(--ds-color-danger-fg)]">
                    Importação movida para falha permanente
                  </p>
                  <p className="mt-1 text-sm text-[var(--ds-color-danger-fg)]">
                    A importação esgotou as tentativas automáticas e foi marcada
                    como falha permanente. O documento permanece auditável para
                    investigação e reprocessamento controlado.
                  </p>
                </div>
              )}

              {currentStatus === "FAILED" && (
                <div
                  role="alert"
                  className="rounded-xl border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] p-4"
                >
                  <p className="text-sm font-semibold text-[var(--ds-color-warning-fg)]">
                    Processamento interrompido antes da conclusão
                  </p>
                  <p className="mt-1 text-sm text-[var(--ds-color-warning-fg)]">
                    O processamento falhou antes da conclusão. Acompanhe o
                    status novamente pelo endpoint informado ou reenvie o
                    documento após corrigir a causa.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center rounded-[var(--ds-radius-lg)] border-2 border-dashed border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] p-10 text-[var(--ds-color-text-secondary)]">
              <FileText size={64} className="mb-4 opacity-20" />
              <p className="text-base font-medium">
                Aguardando envio de arquivo para análise
              </p>
              <p className="text-[13px]">
                O documento será recebido, enviado para a fila e o status ficará
                consultável até a conclusão.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailItem({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs font-medium uppercase tracking-wider text-[var(--ds-color-text-secondary)]">
        {label}
      </span>
      <span className="text-sm font-semibold text-[var(--ds-color-text-secondary)]">
        {value || "---"}
      </span>
    </div>
  );
}

function StatusItem({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--ds-color-text-secondary)]">
        {label}
      </div>
      <div className="truncate text-sm font-semibold text-[var(--ds-color-text-secondary)]">
        {value || "---"}
      </div>
    </div>
  );
}
