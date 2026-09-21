'use client';
import { logger } from '@/lib/logger';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import Link from 'next/link';
import { Building2, Mail, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { companiesService, Company } from '@/services/companiesService';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState, ErrorState, InlineLoadingState } from '@/components/ui/state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PaginationControls } from '@/components/PaginationControls';
import { ListPageLayout } from '@/components/layout';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { CompanyInviteModal } from '@/components/CompanyInviteModal';
import { cn } from '@/lib/utils';
import { StatusPill } from '@/components/ui/status-pill';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { canManageCompanies as hasCompanyMutationRole } from '@/lib/role-access';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { CatalogMobileCard, catalogMobileActionClassName } from '../components/CatalogMobileCard';

type AccountStatusTone = 'success' | 'primary' | 'warning' | 'danger' | 'neutral';

function getAccountStatusTone(status?: string): AccountStatusTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'trialing':
      return 'primary';
    case 'trial_expired':
      return 'warning';
    case 'suspended':
      return 'danger';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function getAccountStatusLabel(status?: string): string {
  switch (status) {
    case 'active':
      return 'Ativa';
    case 'trialing':
      return 'Trial';
    case 'trial_expired':
      return 'Trial expirado';
    case 'suspended':
      return 'Suspensa';
    case 'cancelled':
      return 'Cancelada';
    default:
      return 'Indefinido';
  }
}

const inputClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]';

export default function CompaniesPage() {
  const { hasPermission, roles } = useAuth();
  const canManageCompanies =
    hasPermission(Permission.CAN_MANAGE_COMPANIES) && hasCompanyMutationRole(roles);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDebounce(searchTerm, 300);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const requestSeqRef = useRef(0);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);

  const loadCompanies = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      setLoading(true);
      setLoadError(null);
      const response = await companiesService.findPaginated({
        page,
        limit: 10,
        search: deferredSearchTerm || undefined,
      });
      if (seq !== requestSeqRef.current) return;
      setCompanies(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      logger.error('Erro ao carregar empresas:', error);
      setLoadError('Nao foi possivel carregar a lista de empresas.');
      toast.error('Erro ao carregar lista de empresas.');
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [deferredSearchTerm, page]);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  async function confirmDelete() {
    if (!confirmDeleteId) return;
    setDeleteLoading(true);
    try {
      await companiesService.delete(confirmDeleteId);
      toast.success('Empresa excluida com sucesso');
      setConfirmDeleteId(null);
      if (companies.length === 1 && page > 1) {
        setPage((current) => current - 1);
        return;
      }
      void loadCompanies();
    } catch (error) {
      logger.error('Erro ao excluir empresa:', error);
      toast.error('Erro ao excluir empresa. Verifique dependencias e tente novamente.');
    } finally {
      setDeleteLoading(false);
    }
  }

  const summary = useMemo(
    () => ({
      total,
      visiveis: companies.length,
      ativas: companies.filter((company) => company.status).length,
    }),
    [companies, total],
  );

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar empresas"
        description={loadError}
        action={
          <Button type="button" onClick={() => void loadCompanies()}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ListPageLayout
        eyebrow="Governanca corporativa"
        title="Empresas"
        description="Gerencie as empresas vinculadas ao ambiente multi-tenant do sistema."
        icon={<Building2 className="h-5 w-5" />}
        actions={
          canManageCompanies ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => setIsInviteModalOpen(true)}
                leftIcon={<Mail className="h-4 w-4" />}
              >
                Convidar empresa
              </Button>
              <Link href="/dashboard/companies/new" className={buttonVariants()}>
                <Plus className="mr-2 h-4 w-4" />
                Nova empresa
              </Link>
            </div>
          ) : undefined
        }
        metrics={
          loading && companies.length === 0
            ? []
            : [
                {
                  label: 'Total cadastrado',
                  value: summary.total,
                  note: 'Empresas disponiveis no tenant.',
                },
                {
                  label: 'Resultados visiveis',
                  value: summary.visiveis,
                  note: 'Correspondencias da busca atual.',
                  tone: 'primary',
                },
                {
                  label: 'Empresas ativas',
                  value: summary.ativas,
                  note: 'Estruturas prontas para operar.',
                  tone: 'success',
                },
              ]
        }
        toolbarTitle="Base de empresas"
        toolbarDescription={`${total} empresa(s) encontrada(s) com busca por razão social, CNPJ e responsável.`}
        toolbarContent={
          <div className="ds-list-search">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
            <input
              type="text"
              placeholder="Buscar empresas..."
              aria-label="Buscar empresas por razão social ou CNPJ"
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
        {loading && companies.length === 0 ? (
          <div className="p-6">
            <InlineLoadingState label="Carregando empresas..." />
          </div>
        ) : companies.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="Nenhuma empresa encontrada"
              description={
                deferredSearchTerm
                  ? 'Nenhum resultado corresponde ao filtro aplicado.'
                  : 'Ainda nao existem empresas cadastradas para este tenant.'
              }
              action={
                !deferredSearchTerm && canManageCompanies ? (
                  <Link
                    href="/dashboard/companies/new"
                    className={cn(buttonVariants(), 'inline-flex items-center')}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Nova empresa
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ResponsiveDataList
            items={companies}
            getKey={(company) => company.id}
            mobileClassName="grid min-w-0 gap-3 p-3"
            desktop={() => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Razao social</TableHead>
                    <TableHead>CNPJ</TableHead>
                    <TableHead>Responsavel</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Acoes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companies.map((company) => (
                    <TableRow key={company.id}>
                      <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                        {company.razao_social}
                      </TableCell>
                      <TableCell>{company.cnpj}</TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {company.responsavel}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={getAccountStatusTone(company.account_status)}>
                          {getAccountStatusLabel(company.account_status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {canManageCompanies ? (
                            <Link
                              href={`/dashboard/companies/edit/${company.id}`}
                              className={buttonVariants({ size: 'icon', variant: 'ghost' })}
                              title="Editar empresa"
                            >
                              <Pencil className="h-4 w-4" />
                            </Link>
                          ) : null}
                          {canManageCompanies ? (
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => setConfirmDeleteId(company.id)}
                              className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                              title="Excluir empresa"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            mobile={(company) => (
              <CatalogMobileCard
                title={company.razao_social}
                description={company.cnpj || 'CNPJ não informado'}
                fields={[
                  { label: 'Responsável', value: company.responsavel || '—' },
                  {
                    label: 'Status',
                    value: (
                      <StatusPill tone={getAccountStatusTone(company.account_status)}>
                        {getAccountStatusLabel(company.account_status)}
                      </StatusPill>
                    ),
                  },
                ]}
                actionsLabel={`Ações da empresa ${company.razao_social}`}
                actions={
                  <>
                    {canManageCompanies ? (
                      <Link
                        href={`/dashboard/companies/edit/${company.id}`}
                        className={cn(
                          buttonVariants({ size: 'sm', variant: 'outline' }),
                          catalogMobileActionClassName,
                          'min-h-11',
                        )}
                      >
                        <Pencil className="h-4 w-4" /> Editar
                      </Link>
                    ) : null}
                    {canManageCompanies ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmDeleteId(company.id)}
                        className={cn(
                          catalogMobileActionClassName,
                          'min-h-11 text-[var(--ds-color-danger)]',
                        )}
                      >
                        <Trash2 className="h-4 w-4" /> Excluir
                      </Button>
                    ) : null}
                  </>
                }
              />
            )}
          />
        )}
      </ListPageLayout>

      <ConfirmModal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => void confirmDelete()}
        title="Excluir empresa"
        description="Esta acao e irreversivel. A empresa e todos os vinculos associados serao removidos permanentemente."
        confirmLabel="Excluir"
        loading={deleteLoading}
      />

      <CompanyInviteModal isOpen={isInviteModalOpen} onClose={() => setIsInviteModalOpen(false)} />
    </>
  );
}
