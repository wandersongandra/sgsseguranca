'use client';
import { logger } from '@/lib/logger';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ClipboardList, Pencil, Plus, Search, Trash2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { machinesService, Machine } from '@/services/machinesService';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/ui/state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/PaginationControls';
import { ListPageLayout } from '@/components/layout';
import { cn } from '@/lib/utils';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { CatalogMobileCard, catalogMobileActionClassName } from '../components/CatalogMobileCard';
import { runWithMutationLock } from '@/lib/mutation-lock';

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
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

  const loadMachines = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const response = await machinesService.findPaginated({
        page,
        limit: 10,
        search: deferredSearchTerm || undefined,
      });
      setMachines(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      logger.error('Erro ao carregar maquinas:', error);
      setLoadError('Nao foi possivel carregar a lista de maquinas.');
      toast.error('Erro ao carregar lista de maquinas.');
    } finally {
      setLoading(false);
    }
  }, [deferredSearchTerm, page]);

  useEffect(() => {
    void loadMachines();
  }, [loadMachines]);

  async function handleDelete(id: string) {
    if (!confirm('Tem certeza que deseja excluir esta maquina?')) {
      return;
    }

    await runWithMutationLock(deleteMutationLock, async () => {
      try {
        await machinesService.delete(id);
        toast.success('Maquina excluida com sucesso');
        if (machines.length === 1 && page > 1) {
          setPage((current) => current - 1);
          return;
        }
        void loadMachines();
      } catch (error) {
        logger.error('Erro ao excluir maquina:', error);
        toast.error('Erro ao excluir maquina. Verifique dependencias e tente novamente.');
      }
    });
  }

  const summary = useMemo(
    () => ({
      total,
      visiveis: machines.length,
      comPlaca: machines.filter((machine) => Boolean(machine.placa)).length,
    }),
    [machines, total],
  );

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar maquinas"
        description={loadError}
        action={
          <Button type="button" onClick={() => void loadMachines()}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <ListPageLayout
      eyebrow="Inventario de equipamentos"
      title="Maquinas"
      description="Gerencie o inventario de maquinas e acesse rapidamente o fluxo de checklist por equipamento."
      icon={<Truck className="h-5 w-5" />}
      actions={
        <Link href="/dashboard/machines/new" className={buttonVariants()}>
          <Plus className="mr-2 h-4 w-4" />
          Nova maquina
        </Link>
      }
      metrics={
        loading && machines.length === 0
          ? []
          : [
        {
          label: 'Total cadastrado',
          value: summary.total,
          note: 'Inventario total cadastrado por tenant.',
        },
        {
          label: 'Resultados visiveis',
          value: summary.visiveis,
          note: 'Equipamentos retornados pela busca atual.',
          tone: 'primary',
        },
        {
          label: 'Com placa',
          value: summary.comPlaca,
          note: 'Identificacao formal pronta para rastreio.',
          tone: 'success',
        },
          ]
      }
      toolbarTitle="Base de máquinas"
      toolbarDescription={`${total} máquina(s) encontrada(s) com busca por nome e placa.`}
      toolbarContent={
        <div className="ds-list-search">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
          <Input
            type="text"
            placeholder="Buscar maquinas..."
            aria-label="Buscar maquinas por nome ou placa"
            className="pl-10"
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
      {loading && machines.length === 0 ? (
        <div className="p-6 text-center text-sm text-[var(--ds-color-text-muted)]">
          Carregando máquinas...
        </div>
      ) : machines.length === 0 ? (
        <div className="p-6">
          <EmptyState
            title="Nenhuma maquina encontrada"
            description={
              deferredSearchTerm
                ? 'Nenhum resultado corresponde ao filtro aplicado.'
                : 'Ainda nao existem maquinas cadastradas para este tenant.'
            }
            action={
              !deferredSearchTerm ? (
                <Link
                  href="/dashboard/machines/new"
                  className={cn(buttonVariants(), 'inline-flex items-center')}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Nova maquina
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ResponsiveDataList
          items={machines}
          getKey={(machine) => machine.id}
          mobileClassName="grid min-w-0 gap-3 p-3"
          desktop={() => (
            <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Placa</TableHead>
              <TableHead>Horimetro atual</TableHead>
              <TableHead className="text-right">Acoes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machines.map((machine) => (
              <TableRow key={machine.id}>
                <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                  {machine.nome}
                </TableCell>
                <TableCell className="text-[var(--ds-color-text-secondary)]">
                  {machine.placa || '-'}
                </TableCell>
                <TableCell>{machine.horimetro_atual || '0'}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Link
                      href={`/dashboard/checklist-models/new?maquina=${encodeURIComponent(machine.nome)}&company_id=${machine.company_id}`}
                      className={buttonVariants({ size: 'icon', variant: 'ghost' })}
                      title="Montar checklist"
                    >
                      <ClipboardList className="h-4 w-4" />
                    </Link>
                    <Link
                      href={`/dashboard/machines/edit/${machine.id}`}
                      className={buttonVariants({ size: 'icon', variant: 'ghost' })}
                      title="Editar maquina"
                    >
                      <Pencil className="h-4 w-4" />
                    </Link>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => handleDelete(machine.id)}
                      className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                      title="Excluir maquina"
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
          mobile={(machine) => (
            <CatalogMobileCard
              title={machine.nome}
              description={machine.descricao}
              fields={[
                { label: 'Placa', value: machine.placa || '—' },
                { label: 'Horímetro atual', value: machine.horimetro_atual ?? 0 },
              ]}
              actionsLabel={`Ações da máquina ${machine.nome}`}
              actions={
                <>
                  <Link href={`/dashboard/checklist-models/new?maquina=${encodeURIComponent(machine.nome)}&company_id=${machine.company_id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), catalogMobileActionClassName)}>
                    <ClipboardList className="h-4 w-4" /> Checklist
                  </Link>
                  <Link href={`/dashboard/machines/edit/${machine.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), catalogMobileActionClassName)}>
                    <Pencil className="h-4 w-4" /> Editar
                  </Link>
                  <Button type="button" size="sm" variant="outline" onClick={() => handleDelete(machine.id)} className={cn(catalogMobileActionClassName, 'text-[var(--ds-color-danger)]')}>
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



