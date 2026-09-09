"use client";
import { logger } from "@/lib/logger";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutTemplate,
  Mail,
  PenTool,
  PlayCircle,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListPageLayout } from "@/components/layout";
import { PaginationControls } from "@/components/PaginationControls";
import { StatusPill } from "@/components/ui/status-pill";

import { EmptyState, InlineLoadingState } from "@/components/ui/state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { checklistModuleAreas, type ChecklistModuleArea } from "@/lib/checklist-modules";
import { cn } from "@/lib/utils";
import { checklistsService, type Checklist } from "@/services/checklistsService";
import { signaturesService } from "@/services/signaturesService";
import { TableRowSkeleton } from "@/components/ui/skeleton";
import { ResponsiveDataList } from "@/components/ui/responsive-data-list";
import { useAuth } from "@/context/AuthContext";
import { Permission } from "@/lib/permissions";
import { runWithMutationLock } from "@/lib/mutation-lock";

const SendMailModal = dynamic(
  () =>
    import("@/components/SendMailModal").then(
      (module) => module.SendMailModal,
    ),
  { ssr: false },
);

const loadChecklistPdfGenerator = async () =>
  import("@/lib/pdf/checklistGenerator");

interface ChecklistModelsViewProps {
  area: ChecklistModuleArea;
  showBootstrapAction?: boolean;
}

export function ChecklistModelsView({
  area,
  showBootstrapAction = false,
}: ChecklistModelsViewProps) {
  const { hasPermission } = useAuth();
  const canViewChecklists = hasPermission(Permission.CAN_VIEW_CHECKLISTS);
  const canManageChecklists = hasPermission(Permission.CAN_MANAGE_CHECKLISTS);

  const [models, setModels] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [isMailModalOpen, setIsMailModalOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{
    name: string;
    filename: string;
    base64: string;
  } | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const deleteMutationLock = useRef(false);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage]);

  const loadModels = useCallback(async () => {
    try {
      setLoading(true);
      const response = await checklistsService.findPaginated({
        onlyTemplates: true,
        category: area.category,
        segment: area.segment,
        page,
        limit: 10,
      });
      setModels(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      logger.error("Erro ao carregar modelos:", error);
      toast.error("Não foi possível carregar os modelos de checklist.");
    } finally {
      setLoading(false);
    }
  }, [area.category, area.segment, page]);

  useEffect(() => {
    if (canViewChecklists || canManageChecklists) {
      void loadModels();
    } else {
      setLoading(false);
      setModels([]);
    }
  }, [loadModels, canViewChecklists, canManageChecklists]);

  async function handleDelete(id: string) {
    if (!confirm("Excluir este modelo?")) {
      return;
    }

    await runWithMutationLock(deleteMutationLock, async () => {
      try {
        await checklistsService.delete(id);
        if (models.length === 1 && page > 1) {
          setPage((current) => current - 1);
        } else {
          await loadModels();
        }
        toast.success("Modelo excluído com sucesso!");
      } catch (error) {
        logger.error("Erro ao excluir modelo:", error);
        toast.error("Erro ao excluir modelo.");
      }
    });
  }

  async function handleBootstrapTemplates() {
    if (!canManageChecklists) {
      toast.error("Você não tem permissão para sincronizar os modelos padrão.");
      return;
    }

    try {
      setBootstrapping(true);
      const result = await checklistsService.bootstrapPresetModels();
      toast.success(
        `Modelos padrão processados. Criados: ${result.created}. Ignorados: ${result.skipped}.`,
      );
      setPage(1);
      await loadModels();
    } catch (error) {
      logger.error("Erro ao sincronizar os modelos padrão:", error);
      toast.error("Não foi possível sincronizar os modelos padrão.");
    } finally {
      setBootstrapping(false);
    }
  }

  const handleSendEmail = useCallback(async (checklist: Checklist) => {
    try {
      setPrintingId(checklist.id);
      const signatures = await signaturesService.findByChecklist(checklist.id);
      const { generateChecklistPdf } = await loadChecklistPdfGenerator();
      const pdfData = await generateChecklistPdf(checklist, signatures, {
        save: false,
        output: "base64",
        draftWatermark: false,
      });

      if (pdfData?.base64) {
        setSelectedDoc({
          name: checklist.titulo,
          filename: pdfData.filename,
          base64: pdfData.base64,
        });
        setIsMailModalOpen(true);
      }
    } catch (error) {
      logger.error("Erro ao enviar e-mail:", error);
      toast.error("Erro ao enviar e-mail.");
    } finally {
      setPrintingId(null);
    }
  }, []);

  const filteredModels = useMemo(
    () =>
      models.filter((model) =>
        (
          model.titulo +
          (model.descricao || "") +
          (model.equipamento || "") +
          (model.maquina || "") +
          (model.categoria || "")
        )
          .toLowerCase()
          .includes(searchTerm.toLowerCase()),
      ),
    [models, searchTerm],
  );

  if (!canViewChecklists && !canManageChecklists) {
    return (
      <EmptyState
        title="Acesso restrito"
        description="Sem permissão para visualizar modelos de checklist."
      />
    );
  }

  return (
    <>
      <ListPageLayout
      eyebrow="Modelos de checklist"
      title={area.title}
      description={area.description}
      icon={<LayoutTemplate className="h-5 w-5" />}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {area.category ? (
            <StatusPill tone="primary">{area.category}</StatusPill>
          ) : (
            <StatusPill tone="info">Biblioteca central</StatusPill>
          )}
          {showBootstrapAction && canManageChecklists ? (
            <Button
              type="button"
              onClick={handleBootstrapTemplates}
              disabled={bootstrapping}
              variant="secondary"
              leftIcon={<Plus className="h-4 w-4" />}
              title="Sincronizar modelos padrão"
            >
              <span>{bootstrapping ? "Sincronizando..." : "Modelos padrão"}</span>
            </Button>
          ) : null}
          {canManageChecklists ? (
            <Link
              href={area.newHref}
              className={cn(buttonVariants({ variant: "primary" }), "gap-2")}
              title="Novo modelo"
            >
              <Plus className="h-4 w-4" />
              <span>Novo modelo</span>
            </Link>
          ) : null}
        </div>
      }
      metrics={[
        {
          label: "Visíveis",
          value: filteredModels.length,
          note: "Itens localizados na página atual.",
          tone: "primary",
        },
        {
          label: "Catálogo",
          value: total,
          note: "Modelos disponíveis no recorte ativo.",
          tone: "success",
        },
        {
          label: "Categoria",
          value: area.category ?? "Todas",
          note: area.segment ? `Segmento ${area.segment}` : "Biblioteca central",
        },
      ]}
      toolbarTitle="Biblioteca reutilizável"
      toolbarDescription="Busque por título, categoria, equipamento ou máquina antes de editar, publicar ou disparar um checklist."
      toolbarContent={
        <div className="ds-list-search ds-list-search--wide">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
          <Input
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Buscar por título, categoria, equipamento ou máquina..."
            aria-label="Buscar modelos de checklist por título, categoria, equipamento ou máquina"
            className="pl-9"
          />
        </div>
      }
      toolbarActions={
        <>
          <span className="ds-toolbar-chip">{filteredModels.length} visível(is)</span>
          <span className="ds-toolbar-chip">{total} total</span>
        </>
      }
      footer={
        !loading && total > 0 ? (
          <PaginationControls
            page={page}
            lastPage={lastPage}
            total={total}
            onPrev={handlePrevPage}
            onNext={handleNextPage}
          />
        ) : null
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 px-4 md:grid-cols-2 xl:grid-cols-4">
          {checklistModuleAreas.map((entry) => {
            const active = entry.slug === area.slug;

            return (
              <Link
                key={entry.slug}
                href={entry.href}
                className={cn(
                  "rounded-[var(--ds-radius-xl)] border px-4 py-4",
                  active
                    ? "border-[var(--ds-color-action-primary)] bg-[var(--ds-color-action-primary)]/8 shadow-[var(--ds-shadow-sm)]"
                    : "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] hover:border-[var(--ds-color-action-primary)]/30 hover:bg-[var(--ds-color-surface-muted)]/40",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                    {entry.label}
                  </span>
                  {active ? <Badge variant="accent">Atual</Badge> : null}
                </div>
                <p className="mt-2 text-xs text-[var(--ds-color-text-secondary)]">
                  {entry.description}
                </p>
              </Link>
            );
          })}
        </div>

        {filteredModels.length === 0 && !loading ? (
          <div className="p-6">
            <EmptyState
              title={
                area.category
                  ? `Nenhum modelo da categoria ${area.category} foi encontrado.`
                  : "Nenhum modelo encontrado."
              }
              description="Ajuste os filtros de busca ou crie um novo modelo para iniciar esta biblioteca."
              action={
                canManageChecklists ? (
                  <Link
                    href={area.newHref}
                    className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
                  >
                    <Plus className="h-4 w-4" />
                    Criar modelo
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ResponsiveDataList
            items={filteredModels}
            getKey={(model) => model.id}
            mobileClassName="space-y-3 p-3"
            loading={loading && filteredModels.length === 0 ? <div className="p-6"><InlineLoadingState label="Carregando modelos de checklist..." /></div> : undefined}
            mobile={(model) => (
              <article className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="font-semibold">{model.titulo}</h3><p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">{model.descricao || "Sem descrição"}</p></div>{model.is_modelo ? <Badge variant="accent">Modelo</Badge> : null}</div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Categoria</dt><dd>{model.categoria || "Sem categoria"}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Equipamento / máquina</dt><dd>{model.equipamento || "-"}{model.maquina ? ` / ${model.maquina}` : ""}</dd></div></dl>
                <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3"><Link href={area.segment ? `/dashboard/checklists/new?source=model&templateId=${model.id}&segment=${area.segment}&categoria=${encodeURIComponent(area.category || "")}` : `/dashboard/checklists/fill/${model.id}`} className={cn(buttonVariants({ variant: "outline" }), "min-h-11 justify-center text-[var(--ds-color-success)]")}><PlayCircle className="mr-2 h-4 w-4" />Preencher</Link>{canManageChecklists ? <Link href={`/dashboard/checklist-models/edit/${model.id}`} className={cn(buttonVariants({ variant: "outline" }), "min-h-11 justify-center")}><PenTool className="mr-2 h-4 w-4" />Editar</Link> : null}<Button type="button" variant="outline" className="min-h-11" onClick={() => void handleSendEmail(model)} disabled={printingId === model.id}><Mail className="mr-2 h-4 w-4" />E-mail</Button>{canManageChecklists ? <Button type="button" variant="outline" className="min-h-11 text-[var(--ds-color-danger)]" onClick={() => void handleDelete(model.id)}><Trash2 className="mr-2 h-4 w-4" />Excluir</Button> : null}</div>
              </article>
            )}
            desktop={() => <Table className="min-w-[1040px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[38%]">Título</TableHead>
                <TableHead className="w-[18%]">Categoria</TableHead>
                <TableHead className="w-[24%]">Equipamento / Máquina</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <TableRowSkeleton key={index} cols={4} />
                ))
              ) : (
                filteredModels.map((model) => (
                  <TableRow key={model.id}>
                    <TableCell className="px-6 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-medium text-[var(--ds-color-text-primary)]">
                          {model.titulo}
                        </div>
                        {model.is_modelo ? <Badge variant="accent">Modelo</Badge> : null}
                      </div>
                      <div className="text-xs text-[var(--ds-color-text-secondary)]">
                        {model.descricao}
                      </div>
                    </TableCell>
                    <TableCell className="px-6 py-4">
                      <Badge variant="neutral">{model.categoria || "Sem categoria"}</Badge>
                    </TableCell>
                    <TableCell className="px-6 py-4">
                      <div className="text-sm text-[var(--ds-color-text-secondary)]">
                        {model.equipamento || "-"}
                        {model.maquina ? ` / ${model.maquina}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="px-6 py-4">
                      <div className="flex items-center gap-1">
                        <Link
                          href={
                            area.segment
                              ? `/dashboard/checklists/new?source=model&templateId=${model.id}&segment=${area.segment}&categoria=${encodeURIComponent(area.category || "")}`
                              : `/dashboard/checklists/fill/${model.id}`
                          }
                          aria-label={`Preencher checklist a partir do modelo ${model.titulo}`}
                          className={cn(
                            buttonVariants({ size: "icon", variant: "ghost" }),
                            "text-[var(--ds-color-success)] hover:bg-[color:var(--ds-color-success)]/10 hover:text-[var(--ds-color-success)]",
                          )}
                          title="Preencher checklist"
                        >
                          <PlayCircle className="h-4 w-4" />
                        </Link>
                        {canManageChecklists ? (
                          <Link
                            href={`/dashboard/checklist-models/edit/${model.id}`}
                            aria-label={`Editar modelo ${model.titulo}`}
                            className={cn(buttonVariants({ size: "icon", variant: "ghost" }))}
                            title="Editar modelo"
                          >
                            <PenTool className="h-4 w-4" />
                          </Link>
                        ) : null}
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => void handleSendEmail(model)}
                          disabled={printingId === model.id}
                          aria-label={`Enviar modelo ${model.titulo} por e-mail`}
                          title="Enviar por e-mail"
                        >
                          <Mail className="h-4 w-4" />
                        </Button>
                        {canManageChecklists ? (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => void handleDelete(model.id)}
                            aria-label={`Excluir modelo ${model.titulo}`}
                            className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                            title="Excluir modelo"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>}
          />
        )}
      </div>
    </ListPageLayout>

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
        />
      ) : null}
    </>
  );
}
