'use client';
import { logger } from '@/lib/logger';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { episService, Epi } from '@/services/episService';
import { Plus, Pencil, Trash2, Search, AlertCircle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { addDays } from 'date-fns';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { PaginationControls } from '@/components/PaginationControls';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { safeFormatDate } from '@/lib/date/safeFormat';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { CatalogMobileCard, catalogMobileActionClassName } from '../components/CatalogMobileCard';
import { runWithMutationLock } from '@/lib/mutation-lock';

const panelClassName =
  'rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-sm)]';

type ValidityStatus = 'expired' | 'warning' | 'valid' | 'none';

function ValidityBadge({ status }: { status: ValidityStatus }) {
  if (status === 'expired') return <Badge variant="danger"><AlertCircle className="h-3 w-3" /> Expirado</Badge>;
  if (status === 'warning') return <Badge variant="warning"><AlertCircle className="h-3 w-3" /> Vence em breve</Badge>;
  if (status === 'valid') return <Badge variant="success"><CheckCircle2 className="h-3 w-3" /> Válido</Badge>;
  return <Badge variant="neutral">Não informado</Badge>;
}

export default function EpisPage() {
  const [epis, setEpis] = useState<Epi[]>([]);
  const [loading, setLoading] = useState(true);
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

  const loadEpis = useCallback(async () => {
    try {
      setLoading(true);
      const response = await episService.findPaginated({
        page,
        limit: 10,
        search: deferredSearchTerm || undefined,
      });
      setEpis(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      logger.error('Erro ao carregar EPIs:', error);
      toast.error('Erro ao carregar EPIs.');
    } finally {
      setLoading(false);
    }
  }, [deferredSearchTerm, page]);

  useEffect(() => {
    void loadEpis();
  }, [loadEpis]);

  async function handleDelete(id: string) {
    if (confirm('Tem certeza que deseja excluir este EPI?')) {
      await runWithMutationLock(deleteMutationLock, async () => {
        try {
          await episService.delete(id);
          toast.success('EPI excluído com sucesso!');
          if (epis.length === 1 && page > 1) {
            setPage((current) => current - 1);
            return;
          }
          void loadEpis();
        } catch (error) {
          logger.error('Erro ao excluir EPI:', error);
          toast.error('Erro ao excluir EPI. Verifique se existem dependências e tente novamente.');
        }
      });
    }
  }

  const getValidityStatus = (date: string | null) => {
    if (!date) return 'none';
    const validityDate = new Date(date);
    if (Number.isNaN(validityDate.getTime())) return 'none';
    const today = new Date();
    const warningDate = addDays(today, 30);

    if (validityDate.getTime() < today.getTime()) return 'expired';
    if (validityDate.getTime() < warningDate.getTime()) return 'warning';
    return 'valid';
  };

  const summary = useMemo(
    () => ({
      total,
      visible: epis.length,
    }),
    [epis.length, total],
  );

  return (
    <div className="space-y-6">
      <div className={`${panelClassName} p-4`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--ds-color-text-primary)]">EPIs</h1>
            <p className="text-[var(--ds-color-text-muted)]">Gerencie os Equipamentos de Proteção Individual e validades de C.A.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="primary" className="px-3 py-1">
              {summary.total} resultado(s)
            </Badge>
            <Link
              href="/dashboard/epis/new"
              className={cn(buttonVariants({ variant: 'primary' }), 'gap-2')}
            >
              <Plus className="h-4 w-4" />
              Novo EPI
            </Link>
          </div>
        </div>
      </div>

      <div className={panelClassName}>
        <div className="border-b border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/18 p-4">
          <div className="relative max-w-sm">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3">
              <Search className="h-4 w-4 text-[var(--ds-color-text-muted)]" />
            </span>
            <Input
              type="text"
              placeholder="Buscar por nome ou C.A..."
              aria-label="Buscar EPIs por nome ou CA"
              className="pl-10"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>

        <ResponsiveDataList
          items={epis}
          getKey={(epi) => epi.id}
          mobileClassName="grid min-w-0 gap-3 p-3"
          loading={loading ? <div className="p-6 text-center text-sm text-[var(--ds-color-text-muted)]">Carregando EPIs...</div> : null}
          empty={<div className="p-6 text-center text-sm text-[var(--ds-color-text-muted)]">Nenhum EPI encontrado.</div>}
          desktop={() => (
            <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>C.A.</TableHead>
              <TableHead>Validade C.A.</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-[var(--ds-color-text-muted)]">
                  Carregando EPIs...
                </TableCell>
              </TableRow>
            ) : epis.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-[var(--ds-color-text-muted)]">
                  Nenhum EPI encontrado.
                </TableCell>
              </TableRow>
            ) : (
              epis.map((epi) => {
                const status = getValidityStatus(epi.validade_ca);
                return (
                  <TableRow key={epi.id}>
                    <TableCell>
                      <div className="font-medium text-[var(--ds-color-text-primary)]">{epi.nome}</div>
                      <div className="max-w-xs truncate text-xs text-[var(--ds-color-text-muted)]">{epi.descricao}</div>
                    </TableCell>
                    <TableCell>{epi.ca || '-'}</TableCell>
                    <TableCell>
                      {safeFormatDate(epi.validade_ca, 'dd/MM/yyyy')}
                    </TableCell>
                    <TableCell>
                      <ValidityBadge status={status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end space-x-2">
                        <Link
                          href={`/dashboard/epis/edit/${epi.id}`}
                          className="rounded p-1 text-[var(--ds-color-action-primary)] motion-safe:transition-colors hover:bg-[var(--ds-color-primary-subtle)]/36"
                          title="Editar EPI"
                        >
                          <Pencil className="h-4 w-4" />
                        </Link>
                        <button
                          type="button"
                          onClick={() => handleDelete(epi.id)}
                          className="rounded p-1 text-[var(--ds-color-danger)] motion-safe:transition-colors hover:bg-[var(--ds-color-danger-subtle)]"
                          title="Excluir EPI"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
            </Table>
          )}
          mobile={(epi) => {
            const status = getValidityStatus(epi.validade_ca);
            return (
              <CatalogMobileCard
                title={epi.nome}
                description={epi.descricao || 'Sem descrição'}
                fields={[
                  { label: 'C.A.', value: epi.ca || '—' },
                  { label: 'Validade C.A.', value: safeFormatDate(epi.validade_ca, 'dd/MM/yyyy') },
                  { label: 'Status', value: <ValidityBadge status={status} /> },
                ]}
                actionsLabel={`Ações do EPI ${epi.nome}`}
                actions={
                  <>
                    <Link href={`/dashboard/epis/edit/${epi.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), catalogMobileActionClassName)}>
                      <Pencil className="h-4 w-4" /> Editar
                    </Link>
                    <button type="button" onClick={() => handleDelete(epi.id)} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), catalogMobileActionClassName, 'text-[var(--ds-color-danger)]')}>
                      <Trash2 className="h-4 w-4" /> Excluir
                    </button>
                  </>
                }
              />
            );
          }}
        />
        {!loading && total > 0 ? (
          <PaginationControls
            page={page}
            lastPage={lastPage}
            total={total}
            onPrev={handlePrevPage}
            onNext={handleNextPage}
          />
        ) : null}
      </div>
    </div>
  );
}



