"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileSpreadsheet,
  Folder,
  Link2,
  Printer,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, InlineLoadingState } from "@/components/ui/state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { openPdfForPrint, preparePdfPrintWindow, resolveSafeBrowserUrl } from "@/lib/print-utils";
import { safeFormatDate } from "@/lib/date/safeFormat";
import { logger } from "@/lib/logger";
import api from "@/lib/api";

/**
 * O link de download é assinado e de uso único, vinculado à sessão que o
 * emitiu (backend exige o header Authorization na requisição que consome o
 * token — ver document-download-grant.service.ts). Uma navegação crua
 * (window.open direto na URL) nunca carrega esse header, então o token é
 * sempre rejeitado. Por isso buscamos com o client autenticado (`api`,
 * que anexa o Bearer token) e trabalhamos com o PDF como blob local.
 */
async function fetchPdfBlob(url: string): Promise<{ blob: Blob; filename: string | null }> {
  const response = await api.get<Blob>(url, { responseType: "blob" });
  const contentDisposition = response.headers?.["content-disposition"];
  const match =
    typeof contentDisposition === "string" ? contentDisposition.match(/filename="([^"]+)"/) : null;
  let filename: string | null = null;
  if (match?.[1]) {
    try {
      filename = decodeURIComponent(match[1]);
    } catch {
      filename = match[1];
    }
  }
  return { blob: response.data, filename };
}

export interface StoredFileItem {
  entityId: string;
  title: string;
  date: string | Date;
  companyId: string;
  fileKey: string;
  folderPath: string;
  originalName: string;
}

interface StoredFilesPanelProps {
  title: string;
  description: string;
  listStoredFiles: (filters?: {
    company_id?: string;
    year?: number;
    week?: number;
  }) => Promise<StoredFileItem[]>;
  getPdfAccess: (id: string) => Promise<{
    message?: string | null;
    url: string | null;
  }>;
  downloadWeeklyBundle?: (filters: {
    company_id?: string;
    year: number;
    week: number;
  }) => Promise<Blob>;
  companyOptions?: Array<{ id: string; name: string }>;
}

const inputClassName =
  "w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] transition-all duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]";

function parseYearFilter(value: string) {
  if (!value || !/^\d{4}$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 2020 || parsed > 2100) {
    return undefined;
  }
  return parsed;
}

function parseWeekFilter(value: string) {
  if (!value || !/^\d{1,2}$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 53) {
    return undefined;
  }
  return parsed;
}

function StoredFilesPanelComponent({
  title,
  description,
  listStoredFiles,
  getPdfAccess,
  downloadWeeklyBundle,
  companyOptions = [],
}: StoredFilesPanelProps) {
  const [files, setFiles] = useState<StoredFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [year, setYear] = useState("");
  const [week, setWeek] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const requestSequenceRef = useRef(0);
  const deferredYear = useDeferredValue(year);
  const deferredWeek = useDeferredValue(week);
  const deferredCompanyId = useDeferredValue(companyId);
  const parsedYear = useMemo(() => parseYearFilter(deferredYear), [deferredYear]);
  const parsedWeek = useMemo(() => parseWeekFilter(deferredWeek), [deferredWeek]);

  const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
  const paged = useMemo(
    () => files.slice((page - 1) * pageSize, page * pageSize),
    [files, page, pageSize],
  );
  const canBuildWeeklyBundle = Boolean(downloadWeeklyBundle && parsedYear && parsedWeek);

  useEffect(() => {
    setPage(1);
  }, [year, week, companyId, pageSize]);

  useEffect(() => {
    let mounted = true;

    async function fetchFiles() {
      const requestId = ++requestSequenceRef.current;
      try {
        setLoading(true);
        const data = await listStoredFiles({
          company_id: deferredCompanyId || undefined,
          year: parsedYear,
          week: parsedWeek,
        });

        if (mounted && requestId === requestSequenceRef.current) {
          setFiles((data || []).map((file) => normalizeStoredFileItem(file)));
        }
      } catch (error) {
        if (requestId === requestSequenceRef.current) {
          logger.error("Erro ao carregar arquivos do storage:", error);
          toast.error("Erro ao carregar arquivos salvos.");
        }
      } finally {
        if (mounted && requestId === requestSequenceRef.current) {
          setLoading(false);
        }
      }
    }

    fetchFiles();

    return () => {
      mounted = false;
    };
  }, [deferredCompanyId, parsedWeek, parsedYear, listStoredFiles]);

  const handleDownload = useCallback(
    async (entityId: string) => {
      try {
        const access = await getPdfAccess(entityId);
        if (!access.url) {
          throw new Error(access.message || "PDF indisponível para download.");
        }
        const { blob, filename } = await fetchPdfBlob(access.url);
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename || "documento.pdf";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(objectUrl);
      } catch (error) {
        logger.error("Erro ao abrir PDF:", error);
        toast.error("Não foi possível abrir o PDF.");
      }
    },
    [getPdfAccess],
  );

  const handleCopyFolder = useCallback(async (folderPath: string) => {
    try {
      await navigator.clipboard.writeText(folderPath);
      toast.success("Caminho da pasta copiado.");
    } catch (error) {
      logger.error("Erro ao copiar caminho:", error);
      toast.error("Não foi possível copiar o caminho.");
    }
  }, []);

  const handleCopyLink = useCallback(
    async (entityId: string) => {
      try {
        const access = await getPdfAccess(entityId);
        if (!access.url) {
          throw new Error(access.message || "Link indisponível para este PDF.");
        }
        await navigator.clipboard.writeText(resolveSafeBrowserUrl(access.url));
        toast.success("Link do PDF copiado.");
      } catch (error) {
        logger.error("Erro ao copiar link:", error);
        toast.error("Não foi possível copiar o link do PDF.");
      }
    },
    [getPdfAccess],
  );

  const handlePrint = useCallback(
    async (entityId: string) => {
      const printWindow = preparePdfPrintWindow();
      try {
        const access = await getPdfAccess(entityId);
        if (!access.url) {
          throw new Error(access.message || "PDF indisponível para impressão.");
        }
        const { blob } = await fetchPdfBlob(access.url);
        const objectUrl = URL.createObjectURL(blob);
        openPdfForPrint(
          objectUrl,
          () => {
            toast.error("Pop-up bloqueado. Permita pop-ups para imprimir sem sair do sistema.");
          },
          printWindow,
        );
      } catch (error) {
        printWindow?.close();
        logger.error("Erro ao imprimir PDF arquivado:", error);
        toast.error("Não foi possível abrir o PDF para impressão.");
      }
    },
    [getPdfAccess],
  );

  const handleExportCsv = useCallback(() => {
    if (files.length === 0) {
      toast.error("Não há arquivos para exportar.");
      return;
    }

    const headers = [
      "entity_id",
      "date",
      "title",
      "company_id",
      "folder_path",
      "file_key",
      "original_name",
    ];
    const escapeCsv = (value: string) => {
      const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value;
      return `"${safeValue.replace(/"/g, '""')}"`;
    };
    const rows = files.map((file) =>
      [
        file.entityId,
        safeFormatDate(file.date, "yyyy-MM-dd", undefined, ""),
        file.title,
        file.companyId,
        file.folderPath,
        file.fileKey,
        file.originalName,
      ]
        .map((item) => escapeCsv(String(item ?? "")))
        .join(","),
    );
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `storage-files-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success("CSV exportado com sucesso.");
  }, [files]);

  const handleDownloadWeeklyBundle = useCallback(async () => {
    if (!downloadWeeklyBundle || !parsedYear || !parsedWeek) {
      toast.error("Selecione ano e semana para gerar o pacote.");
      return;
    }

    try {
      const blob = await downloadWeeklyBundle({
        company_id: companyId || undefined,
        year: parsedYear,
        week: parsedWeek,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${slugify(title)}-semana-${parsedYear}-${String(parsedWeek).padStart(2, "0")}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success("Pacote semanal gerado com sucesso.");
    } catch (error) {
      logger.error("Erro ao baixar pacote semanal:", error);
      toast.error("Não foi possível gerar o pacote semanal.");
    }
  }, [companyId, downloadWeeklyBundle, parsedWeek, parsedYear, title]);

  const handlePrintWeeklyBundle = useCallback(async () => {
    if (!downloadWeeklyBundle || !parsedYear || !parsedWeek) {
      toast.error("Selecione ano e semana para imprimir o pacote.");
      return;
    }

    const printWindow = preparePdfPrintWindow();
    try {
      const blob = await downloadWeeklyBundle({
        company_id: companyId || undefined,
        year: parsedYear,
        week: parsedWeek,
      });
      const url = URL.createObjectURL(blob);
      openPdfForPrint(
        url,
        () => {
          toast.error("Pop-up bloqueado. Permita pop-ups para imprimir sem sair do sistema.");
        },
        printWindow,
      );
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      printWindow?.close();
      logger.error("Erro ao imprimir pacote semanal:", error);
      toast.error("Não foi possível abrir o pacote semanal para impressão.");
    }
  }, [companyId, downloadWeeklyBundle, parsedWeek, parsedYear]);

  return (
    <section className="ds-list-shell mt-6">
      <div className="ds-list-toolbar md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-[var(--ds-color-text-primary)]">{title}</h2>
            <span className="ds-badge">Storage</span>
            <span className="ds-badge ds-badge--info">{files.length} arquivo(s)</span>
            {year && week ? (
              <span className="ds-badge ds-badge--warning">
                Semana {String(week).padStart(2, "0")} / {year}
              </span>
            ) : null}
          </div>
          <p className="max-w-3xl text-sm text-[var(--ds-color-text-secondary)]">{description}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            leftIcon={<FileSpreadsheet className="h-4 w-4 text-[var(--ds-color-success)]" />}
            onClick={handleExportCsv}
          >
            Exportar CSV
          </Button>
          {downloadWeeklyBundle ? (
            <>
              <Button
                type="button"
                variant="outline"
                leftIcon={<Download className="h-4 w-4" />}
                onClick={handleDownloadWeeklyBundle}
                disabled={!canBuildWeeklyBundle}
              >
                Baixar semana
              </Button>
              <Button
                type="button"
                variant="outline"
                leftIcon={<Printer className="h-4 w-4" />}
                onClick={handlePrintWeeklyBundle}
                disabled={!canBuildWeeklyBundle}
              >
                Imprimir semana
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="border-t border-[var(--ds-color-border-subtle)] px-4 py-4 sm:px-5">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr),0.7fr,0.7fr,0.7fr]">
          <select
            aria-label="Filtrar arquivos por empresa"
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            className={inputClassName}
          >
            <option value="">Todas empresas</option>
            {companyOptions.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={2020}
            max={2100}
            placeholder="Ano"
            aria-label="Filtrar arquivos por ano"
            value={year}
            onChange={(event) => setYear(event.target.value)}
            className={inputClassName}
          />
          <input
            type="number"
            min={1}
            max={53}
            placeholder="Semana ISO"
            aria-label="Filtrar arquivos por semana ISO"
            value={week}
            onChange={(event) => setWeek(event.target.value)}
            className={inputClassName}
          />
          <select
            aria-label="Quantidade de arquivos por página"
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value))}
            className={inputClassName}
          >
            <option value={10}>10 / página</option>
            <option value={25}>25 / página</option>
            <option value={50}>50 / página</option>
          </select>
        </div>
      </div>

      <div className="ds-list-body">
        {loading ? (
          <div className="p-6">
            <InlineLoadingState label="Carregando arquivos salvos" />
          </div>
        ) : paged.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="Nenhum arquivo encontrado"
              description="Não há arquivos armazenados para o filtro aplicado."
              compact
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Título</TableHead>
                  <TableHead>Pasta</TableHead>
                  <TableHead>Arquivo</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((file) => (
                  <TableRow key={`${file.entityId}-${file.fileKey}`}>
                    <TableCell>{safeFormatDate(file.date, "dd/MM/yyyy")}</TableCell>
                    <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                      {file.title}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 text-xs text-[var(--ds-color-text-secondary)]">
                        <Folder className="h-3 w-3" />
                        <span className="max-w-[18rem] truncate">{file.folderPath}</span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => handleCopyFolder(file.folderPath)}
                          title="Copiar caminho"
                          className="h-6 w-6"
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="text-[var(--ds-color-text-secondary)]">
                      {file.originalName}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          leftIcon={<Download className="h-3.5 w-3.5" />}
                          onClick={() => handleDownload(file.entityId)}
                        >
                          Baixar
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          leftIcon={<Printer className="h-3.5 w-3.5" />}
                          onClick={() => handlePrint(file.entityId)}
                        >
                          Imprimir
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          leftIcon={<Link2 className="h-3.5 w-3.5" />}
                          onClick={() => handleCopyLink(file.entityId)}
                        >
                          Copiar link
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </div>

      {paged.length > 0 ? (
        <div className="ds-list-footer">
          <div className="flex flex-col gap-3 text-sm text-[var(--ds-color-text-muted)] md:flex-row md:items-center md:justify-between">
            <span>
              Página{" "}
              <span className="font-semibold text-[var(--ds-color-text-primary)]">{page}</span> de{" "}
              <span className="font-semibold text-[var(--ds-color-text-primary)]">
                {totalPages}
              </span>{" "}
              • {files.length} arquivo(s)
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                leftIcon={<ChevronLeft className="h-4 w-4" />}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
              >
                Anterior
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                rightIcon={<ChevronRight className="h-4 w-4" />}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page >= totalPages}
              >
                Próxima
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const areCompanyOptionsEqual = (
  prev: Array<{ id: string; name: string }>,
  next: Array<{ id: string; name: string }>,
) => {
  if (prev === next) {
    return true;
  }

  if (prev.length !== next.length) {
    return false;
  }

  return prev.every(
    (item, index) => item.id === next[index]?.id && item.name === next[index]?.name,
  );
};

const areStoredFilesPanelPropsEqual = (prev: StoredFilesPanelProps, next: StoredFilesPanelProps) =>
  prev.title === next.title &&
  prev.description === next.description &&
  prev.listStoredFiles === next.listStoredFiles &&
  prev.getPdfAccess === next.getPdfAccess &&
  prev.downloadWeeklyBundle === next.downloadWeeklyBundle &&
  areCompanyOptionsEqual(prev.companyOptions || [], next.companyOptions || []);

export const StoredFilesPanel = memo(StoredFilesPanelComponent, areStoredFilesPanelPropsEqual);

function normalizeStoredFileItem(file: unknown): StoredFileItem {
  const record = (file ?? {}) as Record<string, unknown>;
  return {
    entityId: String(
      record.entityId ??
        record.id ??
        record.ddsId ??
        record.aprId ??
        record.ptId ??
        record.checklistId ??
        "",
    ),
    title: String(
      record.title ??
        record.titulo ??
        record.tema ??
        record.numero ??
        record.codigo_nc ??
        "Documento",
    ),
    date:
      (record.date as string | Date | undefined) ??
      (record.data as string | Date | undefined) ??
      (record.data_inicio as string | Date | undefined) ??
      (record.data_hora_inicio as string | Date | undefined) ??
      (record.data_identificacao as string | Date | undefined) ??
      new Date().toISOString(),
    companyId: String(record.companyId ?? record.company_id ?? ""),
    fileKey: String(record.fileKey ?? ""),
    folderPath: String(record.folderPath ?? ""),
    originalName: String(record.originalName ?? record.fileKey ?? "documento.pdf"),
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
