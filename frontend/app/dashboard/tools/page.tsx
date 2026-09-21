'use client';
import { logger } from '@/lib/logger';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ClipboardList, Pencil, Plus, Search, Trash2, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { toolsService, Tool } from '@/services/toolsService';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/PaginationControls';
import { ListPageLayout } from '@/components/layout';
import { cn } from '@/lib/utils';
import { safeToLocaleDateString } from '@/lib/date/safeFormat';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { CatalogMobileCard, catalogMobileActionClassName } from '../components/CatalogMobileCard';
import { runWithMutationLock } from '@/lib/mutation-lock';

const inputClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]';

export default function ToolsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const deleteMutationLock = useRef(false);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);

  const loadTools = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const response = await toolsService.findPaginated({
        page,
        limit: 10,
        search: deferredSearchTerm || undefined,
      });
      setTools(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      logger.error('Erro ao carregar ferramentas:', error);
      setLoadError('Nao foi possivel carregar a lista de ferramentas.');
      toast.error('Erro ao carregar lista de ferramentas.');
    } finally {
      setLoading(false);
    }
  }, [deferredSearchTerm, page]);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  async function handleDelete(id: string) {
    if (!confirm('Tem certeza que deseja excluir esta ferramenta?')) {
      return;
    }

    await runWithMutationLock(deleteMutationLock, async () => {
      try {
        await toolsService.delete(id);
        toast.success('Ferramenta excluida com sucesso');
        if (tools.length === 1 && page > 1) {
          setPage((current) => current - 1);
          return;
        }
        void loadTools();
      } catch (error) {
        logger.error('Erro ao excluir ferramenta:', error);
        toast.error('Erro ao excluir ferramenta. Verifique dependencias e tente novamente.');
      }
    });
  }

  const summary = useMemo(
    () => ({
      total,
      visiveis: tools.length,
      comSerie: tools.filter((tool) => Boolean(tool.numero_serie)).length,
    }),
    [tools, total],
  );

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar ferramentas"
        description={loadError}
        action={
          <Button type="button" onClick={() => void loadTools()}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <ListPageLayout
      eyebrow="Inventario de ferramentas"
      title="Ferramentas"
      description="Gerencie o inventario de ferramentas e acesse rapidamente o fluxo de checklist por equipamento."
      icon={<Wrench className="h-5 w-5" />}
      actions={
        <Link href="/dashboard/tools/new" className={buttonVariants()}>
          <Plus className="mr-2 h-4 w-4" />
          Nova ferramenta
        </Link>
      }
      metrics={
        loading && tools.length === 0
          ? []
          : [
        {
          label: 'Total cadastrado',
          value: summary.total,
          note: 'Ferramentas registradas no inventario.',
        },
        {
          label: 'Resultados visiveis',
          value: summary.visiveis,
          note: 'Retorno atual da listagem operacional.',
          tone: 'primary',
        },
        {
          label: 'Com numero de serie',
          value: summary.comSerie,
          note: 'Itens prontos para rastreabilidade patrimonial.',
          tone: 'success',
        },
          ]
      }
      toolbarTitle="Base de ferramentas"
      toolbarDescription={`${total} ferramenta(s) encontrada(s) com busca por nome e número de série.`}
      toolbarContent={
        <div className="ds-list-search">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
          <input
            type="text"
            placeholder="Buscar ferramentas..."
            aria-label="Buscar ferramentas por nome ou numero de serie"
            className={cn(inputClassName, 'pl-10')}
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value);
              setPage(1);
            }}
          />
        </div>
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
      {loading && tools.length === 0 ? (
        <div className="p-6 text-center text-sm text-[var(--ds-color-text-muted)]">
          Carregando ferramentas...
        </div>
      ) : tools.length === 0 ? (
        <div className="p-6">
          <EmptyState
            title="Nenhuma ferramenta encontrada"
            description={
              deferredSearchTerm
                ? 'Nenhum resultado corresponde ao filtro aplicado.'
                : 'Ainda nao existem ferramentas cadastradas para este tenant.'
            }
            action={
              !deferredSearchTerm ? (
                <Link
                  href="/dashboard/tools/new"
                  className={cn(buttonVariants(), 'inline-flex items-center')}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Nova ferramenta
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ResponsiveDataList
          items={tools}
          getKey={(tool) => tool.id}
          mobileClassName="grid min-w-0 gap-3 p-3"
          desktop={() => (
            <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Numero de serie</TableHead>
              <TableHead>Data de criacao</TableHead>
              <TableHead className="text-right">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tools.map((tool) => (
              <TableRow key={tool.id}>
                <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                  {tool.nome}
                </TableCell>
                <TableCell className="text-[var(--ds-color-text-secondary)]">
                  {tool.numero_serie || '-'}
                </TableCell>
                <TableCell>{safeToLocaleDateString(tool.created_at, 'pt-BR', undefined, '—')}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Link
                      href={`/dashboard/checklist-models/new?equipamento=${encodeURIComponent(tool.nome)}&company_id=${tool.company_id}`}
                      className={buttonVariants({ size: 'icon', variant: 'ghost' })}
                      title="Montar checklist"
                    >
                      <ClipboardList className="h-4 w-4" />
                    </Link>
                    <Link
                      href={`/dashboard/tools/edit/${tool.id}`}
                      className={buttonVariants({ size: 'icon', variant: 'ghost' })}
                      title="Editar ferramenta"
                    >
                      <Pencil className="h-4 w-4" />
                    </Link>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => handleDelete(tool.id)}
                      className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                      title="Excluir ferramenta"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
            </Table>
          )}
          mobile={(tool) => (
            <CatalogMobileCard
              title={tool.nome}
              fields={[
                { label: 'Número de série', value: tool.numero_serie || '—' },
                { label: 'Data de criação', value: safeToLocaleDateString(tool.created_at, 'pt-BR', undefined, '—') },
              ]}
              actionsLabel={`Ações da ferramenta ${tool.nome}`}
              actions={
                <>
                  <Link href={`/dashboard/checklist-models/new?equipamento=${encodeURIComponent(tool.nome)}&company_id=${tool.company_id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), catalogMobileActionClassName)}>
                    <ClipboardList className="h-4 w-4" /> Checklist
                  </Link>
                  <Link href={`/dashboard/tools/edit/${tool.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), catalogMobileActionClassName)}>
                    <Pencil className="h-4 w-4" /> Editar
                  </Link>
                  <Button type="button" size="sm" variant="outline" onClick={() => handleDelete(tool.id)} className={cn(catalogMobileActionClassName, 'text-[var(--ds-color-danger)]')}>
                    <Trash2 className="h-4 w-4" /> Excluir
                  </Button>
                </>
              }
            />
          )}
        />
      )}
    </ListPageLayout>
  );
}



