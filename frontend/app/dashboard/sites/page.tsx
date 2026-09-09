'use client';
import { logger } from '@/lib/logger';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Building2, MapPinned, Pencil, Plus, QrCode, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { QRCodeCanvas } from 'qrcode.react';
import { sitesService, Site } from '@/services/sitesService';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button, buttonVariants } from '@/components/ui/button';

import { EmptyState, ErrorState, InlineLoadingState } from '@/components/ui/state';
import { PaginationControls } from '@/components/PaginationControls';
import { ListPageLayout } from '@/components/layout';
import { cn } from '@/lib/utils';
import { safeToLocaleDateString } from '@/lib/date/safeFormat';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { ModalBody, ModalFrame, ModalHeader } from '@/components/ui/modal-frame';
import { CatalogMobileCard, catalogMobileActionClassName } from '../components/CatalogMobileCard';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { useSelectedTenantId } from '@/hooks/useSelectedTenantId';
import { canDeleteSites, canWriteSites } from '@/lib/role-access';

const inputClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]';

export default function SitesPage() {
  const { hasPermission, isAdminGeral, roles, user } = useAuth();
  const tenantId = useSelectedTenantId();
  const activeCompanyId = tenantId || user?.company_id || undefined;
  const canManageSites = hasPermission(Permission.CAN_MANAGE_SITES);
  const canWrite = canManageSites && canWriteSites(roles, isAdminGeral);
  const canDelete = canManageSites && canDeleteSites(roles, isAdminGeral);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [qrSiteId, setQrSiteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const requestSeqRef = useRef(0);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);

  const loadSites = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const scope = activeCompanyId ?? null;
    try {
      setLoading(true);
      setLoadError(null);
      const response = await sitesService.findPaginated({
        page,
        limit: 10,
        search: deferredSearchTerm || undefined,
        companyId: activeCompanyId,
      });
      if (seq !== requestSeqRef.current) return;
      setSites(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
      setLoadedScope(scope);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      logger.error('Erro ao carregar sites:', error);
      setLoadError('Nao foi possivel carregar a lista de obras/setores.');
      toast.error('Erro ao carregar lista de obras/setores.');
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [activeCompanyId, deferredSearchTerm, page]);

  useEffect(() => {
    requestSeqRef.current += 1;
    setSites([]);
    setTotal(0);
    setLastPage(1);
    setLoadedScope(null);
    setLoading(true);
    setPage(1);
    setQrSiteId(null);
  }, [tenantId]);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);

  async function handleDelete(id: string) {
    if (!confirm('Tem certeza que deseja excluir esta obra/setor?')) {
      return;
    }

    try {
      await sitesService.delete(id);
      toast.success('Obra/Setor excluido com sucesso');
      if (sites.length === 1 && page > 1) {
        setPage((current) => current - 1);
        return;
      }
      void loadSites();
    } catch (error) {
      logger.error('Erro ao excluir site:', error);
      toast.error('Erro ao excluir obra/setor. Verifique dependencias e tente novamente.');
    }
  }

  const summary = useMemo(
    () => ({
      total: loadedScope === (activeCompanyId ?? null) ? total : 0,
      visiveis: loadedScope === (activeCompanyId ?? null) ? sites.length : 0,
      comCidade:
        loadedScope === (activeCompanyId ?? null)
          ? sites.filter((site) => Boolean(site.cidade)).length
          : 0,
    }),
    [activeCompanyId, loadedScope, sites, total],
  );
  const visibleSites = loadedScope === (activeCompanyId ?? null) ? sites : [];

  const qrUrl = qrSiteId
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/verify?siteId=${qrSiteId}&flow=dds`
    : '';

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar obras/setores"
        description={loadError}
        action={
          <Button type="button" onClick={() => void loadSites()}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ListPageLayout
        eyebrow="Estrutura de campo"
        title="Obras/Setores"
        description="Gerencie as obras e setores usados nos fluxos de campo, mobilizacao e DDS."
        icon={<MapPinned className="h-5 w-5" />}
        actions={
          canWrite ? (
            <Link href="/dashboard/sites/new" className={buttonVariants()}>
              <Plus className="mr-2 h-4 w-4" />
              Nova obra/setor
            </Link>
          ) : undefined
        }
        metrics={
          loading && visibleSites.length === 0
            ? []
            : [
                {
                  label: 'Total cadastrado',
                  value: summary.total,
                  note: 'Obras e setores disponiveis no ambiente.',
                },
                {
                  label: 'Resultados visiveis',
                  value: summary.visiveis,
                  note: 'Registros no recorte atual da busca.',
                  tone: 'primary',
                },
                {
                  label: 'Com cidade informada',
                  value: summary.comCidade,
                  note: 'Estruturas com localizacao mais completa.',
                  tone: 'success',
                },
              ]
        }
        toolbarTitle="Base de obras/setores"
        toolbarDescription={`${summary.total} obra(s)/setor(es) encontrada(s) com busca por nome, cidade e UF.`}
        toolbarContent={
          <div className="ds-list-search">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
            <input
              type="text"
              placeholder="Buscar obras/setores..."
              aria-label="Buscar obras ou setores por nome ou cidade"
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
          !loading && summary.total > 0 ? (
            <PaginationControls
              page={page}
              lastPage={lastPage}
              total={summary.total}
              onPrev={handlePrevPage}
              onNext={handleNextPage}
            />
          ) : null
        }
      >
        {loading && visibleSites.length === 0 ? (
          <div className="p-6">
            <InlineLoadingState label="Carregando obras e setores..." />
          </div>
        ) : visibleSites.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="Nenhuma obra/setor encontrada"
              description={
                deferredSearchTerm
                  ? 'Nenhum resultado corresponde ao filtro aplicado.'
                  : 'Ainda nao existem obras/setores cadastrados para este tenant.'
              }
              action={
                !deferredSearchTerm && canWrite ? (
                  <Link
                    href="/dashboard/sites/new"
                    className={cn(buttonVariants(), 'inline-flex items-center')}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Nova obra/setor
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ResponsiveDataList
            items={visibleSites}
            getKey={(site) => site.id}
            mobileClassName="grid min-w-0 gap-3 p-3"
            desktop={() => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Cidade/Estado</TableHead>
                    <TableHead>Data de criacao</TableHead>
                    <TableHead className="text-right">Acoes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleSites.map((site) => (
                    <TableRow key={site.id}>
                      <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-[var(--ds-color-action-primary)]" />
                          <span>{site.nome}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {site.cidade && site.estado
                          ? `${site.cidade}/${site.estado}`
                          : site.cidade || site.estado || '-'}
                      </TableCell>
                      <TableCell>
                        {safeToLocaleDateString(site.created_at, 'pt-BR', undefined, '—')}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {canWrite ? (
                            <Link
                              href={`/dashboard/sites/edit/${site.id}`}
                              className={buttonVariants({ size: 'icon', variant: 'ghost' })}
                              title="Editar obra/setor"
                            >
                              <Pencil className="h-4 w-4" />
                            </Link>
                          ) : null}
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => setQrSiteId(site.id)}
                            className="text-[var(--ds-color-text-secondary)]"
                            title="QR Code da obra"
                          >
                            <QrCode className="h-4 w-4" />
                          </Button>
                          {canDelete ? (
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => handleDelete(site.id)}
                              className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                              title="Excluir obra/setor"
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
            mobile={(site) => (
              <CatalogMobileCard
                title={site.nome}
                description={
                  site.cidade && site.estado
                    ? `${site.cidade}/${site.estado}`
                    : site.cidade || site.estado || 'Localização não informada'
                }
                fields={[
                  {
                    label: 'Data de criação',
                    value: safeToLocaleDateString(site.created_at, 'pt-BR', undefined, '—'),
                  },
                ]}
                actionsLabel={`Ações da obra ou setor ${site.nome}`}
                actions={
                  <>
                    {canWrite ? (
                      <Link
                        href={`/dashboard/sites/edit/${site.id}`}
                        className={cn(
                          buttonVariants({ size: 'sm', variant: 'outline' }),
                          catalogMobileActionClassName,
                          'min-h-11',
                        )}
                      >
                        <Pencil className="h-4 w-4" /> Editar
                      </Link>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setQrSiteId(site.id)}
                      className={cn(catalogMobileActionClassName, 'min-h-11')}
                    >
                      <QrCode className="h-4 w-4" /> QR Code
                    </Button>
                    {canDelete ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleDelete(site.id)}
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

      <ModalFrame
        isOpen={Boolean(qrSiteId)}
        onClose={() => setQrSiteId(null)}
        shellClassName="max-w-md"
      >
        <ModalHeader
          title="QR Code da obra"
          description="Escaneie para acessar o fluxo de DDS/Checklist sem login."
          icon={<QrCode className="h-5 w-5" />}
          onClose={() => setQrSiteId(null)}
        />
        <ModalBody className="flex flex-col items-center gap-4">
          <QRCodeCanvas value={qrUrl} size={220} includeMargin className="max-w-full" />
          <div className="w-full min-w-0 break-all rounded-[var(--ds-radius-md)] bg-[color:var(--ds-color-surface-muted)]/45 p-3 text-xs text-[var(--ds-color-text-secondary)]">
            {qrUrl}
          </div>
        </ModalBody>
      </ModalFrame>
    </>
  );
}
