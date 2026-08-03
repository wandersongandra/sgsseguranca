"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Calendar, FileText, Loader2, Search, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { extractApiErrorMessage } from "@/lib/error-handler";
import { Permission } from "@/lib/permissions";
import {
  photographicReportsService,
  type PhotographicReportListItem,
  type PhotographicReportStatus,
} from "@/services/photographicReportsService";

const STATUS_OPTIONS: Array<{ value: PhotographicReportStatus | ""; label: string }> = [
  { value: "", label: "Todos os status" },
  { value: "Rascunho", label: "Rascunho" },
  { value: "Aguardando fotos", label: "Aguardando fotos" },
  { value: "Aguardando análise", label: "Aguardando análise" },
  { value: "Analisado", label: "Analisado" },
  { value: "Em edição", label: "Em edição" },
  { value: "Finalizado", label: "Finalizado" },
  { value: "Exportado", label: "Exportado" },
  { value: "Cancelado", label: "Cancelado" },
];

function statusVariant(status: PhotographicReportStatus) {
  switch (status) {
    case "Finalizado":
    case "Exportado":
      return "success" as const;
    case "Aguardando análise":
    case "Aguardando fotos":
      return "warning" as const;
    case "Cancelado":
      return "danger" as const;
    case "Analisado":
    case "Em edição":
      return "info" as const;
    default:
      return "neutral" as const;
  }
}

export default function PhotographicReportsPage() {
  const { hasPermission } = useAuth();
  const router = useRouter();
  const [reports, setReports] = useState<PhotographicReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PhotographicReportStatus | "">("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);

  const canView = hasPermission(Permission.CAN_VIEW_PHOTOGRAPHIC_REPORTS);
  const canCreate = hasPermission(Permission.CAN_MANAGE_PHOTOGRAPHIC_REPORTS);

  const loadReports = useCallback(async () => {
    if (!canView) {
      setReports([]);
      setTotal(0);
      setLastPage(1);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const response = await photographicReportsService.findPaginated({
        page,
        limit: 12,
        search,
        ...(status ? { status } : {}),
      });
      setReports(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      toast.error(
        await extractApiErrorMessage(
          error,
          "Não foi possível carregar os relatórios fotográficos.",
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [canView, page, search, status]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const summary = useMemo(
    () => ({
      total,
      finalized: reports.filter((item) => item.status === "Finalizado").length,
      drafts: reports.filter((item) => item.status === "Rascunho").length,
    }),
    [reports, total],
  );

  return (
    <div className="space-y-6">
      <Card tone="default" padding="lg">
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="primary">
                <FileText className="h-3.5 w-3.5" />
                Relatório Fotográfico
              </Badge>
            </div>
            <CardTitle className="text-2xl">Central de relatórios fotográficos</CardTitle>
            <CardDescription>
              Registre fotos de obra, manutenção, instalação, organização e acompanhamento operacional.
            </CardDescription>
          </div>

          {canCreate ? (
            <Button
              type="button"
              onClick={() => router.push("/dashboard/photographic-reports/new")}
              leftIcon={<Plus className="h-4 w-4" />}
            >
              Novo relatório
            </Button>
          ) : null}
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <SummaryCard title="Total" value={summary.total} description="Relatórios cadastrados" />
        <SummaryCard title="Rascunhos" value={summary.drafts} description="Relatórios em edição" />
        <SummaryCard title="Finalizados" value={summary.finalized} description="Prontos para exportação" />
      </div>

      <Card tone="default" padding="lg">
        <CardHeader className="gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-lg">Lista</CardTitle>
            <CardDescription>
              Use a busca por cliente, obra, unidade, local ou tipo de atividade.
            </CardDescription>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium text-[var(--color-text)]">Buscar</span>
              <div className="flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)] px-3 py-2">
                <Search className="h-4 w-4 text-[var(--color-text-secondary)]" />
                <input
                  value={search}
                  onChange={(event) => {
                    setPage(1);
                    setSearch(event.target.value);
                  }}
                  placeholder="Cliente, obra, local..."
                  className="w-full bg-transparent text-sm outline-none"
                />
              </div>
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium text-[var(--color-text)]">Status</span>
              <select
                value={status}
                onChange={(event) => {
                  setPage(1);
                  setStatus(event.target.value as PhotographicReportStatus | "");
                }}
                className="w-full rounded-[var(--ds-radius-md)] border border-[var(--color-border-subtle)] bg-[color:var(--color-surface)] px-3 py-2 text-sm outline-none"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canView ? (
            <div className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--color-border-subtle)] px-4 py-8 text-sm text-[var(--color-text-secondary)]">
              Você não tem permissão para visualizar relatórios fotográficos.
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-12 text-[var(--color-text-secondary)]">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : reports.length === 0 ? (
            <div className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--color-border-subtle)] px-4 py-8 text-sm text-[var(--color-text-secondary)]">
              Nenhum relatório fotográfico encontrado.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {reports.map((report) => (
                <Card key={report.id} tone="muted" padding="md" interactive>
                  <CardHeader className="gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-1">
                        <Badge variant={statusVariant(report.status)}>{report.status}</Badge>
                        <CardTitle className="text-base">
                          {report.client_name} · {report.project_name}
                        </CardTitle>
                      </div>
                      <Calendar className="h-4 w-4 text-[var(--color-text-secondary)]" />
                    </div>
                    <CardDescription>
                      {report.activity_type} · {report.unit_name || "Sem unidade"} · {report.location || "Sem local"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-sm text-[var(--color-text-secondary)]">
                      <MiniStat label="Data inicial" value={format(new Date(report.start_date), "dd/MM/yyyy", { locale: ptBR })} />
                      <MiniStat label="Fotos" value={String(report.image_count)} />
                      <MiniStat label="Datas" value={String(report.day_count)} />
                      <MiniStat label="Exportações" value={String(report.export_count)} />
                    </div>
                    <p className="line-clamp-3 text-sm text-[var(--color-text-secondary)]">
                      {report.general_observations || report.ai_summary || "Sem observações registradas."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => router.push(`/dashboard/photographic-reports/${report.id}`)}
                      >
                        Abrir
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {total > 0 ? (
            <div className="flex items-center justify-between gap-3 pt-2">
              <p className="text-sm text-[var(--color-text-secondary)]">
                Página {page} de {lastPage} · {total} registro(s)
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page <= 1}
                  leftIcon={<ChevronLeft className="h-4 w-4" />}
                >
                  Anterior
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
                  disabled={page >= lastPage}
                  rightIcon={<ChevronRight className="h-4 w-4" />}
                >
                  Próxima
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  description,
}: {
  title: string;
  value: string | number;
  description: string;
}) {
  return (
    <Card interactive padding="md">
      <CardHeader className="gap-2">
        <CardTitle className="text-3xl">{value}</CardTitle>
        <CardDescription>{title} · {description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[color:var(--color-surface-elevated)]/80 p-2.5">
      <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[var(--color-text)]">{value}</p>
    </div>
  );
}
