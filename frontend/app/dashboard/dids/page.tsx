'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback } from 'react';
import { ptBR } from 'date-fns/locale';
import {
  ClipboardList,
  Mail,
  Pencil,
  Plus,
  Printer,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { ListPageLayout } from '@/components/layout';
import { PaginationControls } from '@/components/PaginationControls';
import { Button, buttonVariants } from '@/components/ui/button';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import {
  EmptyState,
  ErrorState,
  InlineLoadingState,
} from '@/components/ui/state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DID_STATUS_COLORS,
  DID_STATUS_LABEL,
  type DidStatus,
} from '@/services/didsService';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/usePermissions';
import { Permission } from '@/lib/permissions';
import { safeFormatDate } from '@/lib/date/safeFormat';
import { getDidTurnoLabel } from './didMeta';
import { useDids } from './hooks/useDids';
import { getGovernedDocumentActionPolicy } from '../components/documentActionPolicy';

const SendMailModal = dynamic(
  () => import('@/components/SendMailModal').then((module) => module.SendMailModal),
  { ssr: false },
);

const inputClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--component-field-border-subtle)] bg-[color:var(--component-field-bg-subtle)] px-3 py-2.5 text-sm text-[var(--component-field-text)] motion-safe:transition-colors focus:border-[var(--component-field-border-focus)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]';

export default function DidsPage() {
  const { hasPermission } = usePermissions();
  const canManageDids = hasPermission(Permission.CAN_MANAGE_DIDS);
  const {
    dids,
    loading,
    loadError,
    searchTerm,
    setSearchTerm,
    deferredSearchTerm,
    statusFilter,
    setStatusFilter,
    page,
    setPage,
    total,
    lastPage,
    summary,
    busyDidId,
    isMailModalOpen,
    setIsMailModalOpen,
    selectedDoc,
    setSelectedDoc,
    loadDids,
    handleDelete,
    handlePrint,
    handleEmail,
    handleOpenGovernedPdf,
    handleStatusChange,
    getAllowedStatusTransitions,
    formattedToolbarDescription,
    createdAtLabel,
  } = useDids({ canManageDids });

  const handlePrevPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, [setPage]);

  const handleNextPage = useCallback(() => {
    setPage((current) => Math.min(lastPage, current + 1));
  }, [lastPage, setPage]);

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar Início do Dia"
        description={loadError}
        action={
          <Button type="button" onClick={loadDids}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <ListPageLayout
      eyebrow="Formalização operacional"
      title="Diálogo do Início do Dia"
      description="Acompanhe os alinhamentos diários, participantes, status e PDFs finais do turno."
      icon={<ClipboardList className="h-5 w-5" />}
      className="pb-6"
      panelClassName="overflow-hidden"
      actions={
        canManageDids ? (
          <Link
            href="/dashboard/dids/new"
            className={cn(buttonVariants(), 'inline-flex items-center')}
          >
            <Plus className="mr-2 h-4 w-4" />
            Novo DID
          </Link>
        ) : null
      }
      metrics={[
        {
          label: 'Total',
          value: summary.total,
          note: `${total} registro(s) no resultado atual`,
          tone: 'primary',
        },
        {
          label: 'Alinhados',
          value: summary.alinhados,
          note: 'contagem da página visível',
          tone: 'warning',
        },
        {
          label: 'Executados',
          value: summary.executados,
          note: 'documentos já concluídos',
          tone: 'success',
        },
        {
          label: 'PDFs finais',
          value: summary.pdfs,
          note: 'emitidos e disponíveis',
          tone: 'neutral',
        },
      ]}
      toolbarTitle="Registros operacionais"
      toolbarDescription={formattedToolbarDescription}
      toolbarActions={<span className="ds-badge ds-badge--info">Filtros</span>}
      toolbarContent={
        <>
          <div className="ds-list-search">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
            <input
              type="text"
              placeholder="Pesquisar DID"
              aria-label="Pesquisar Documento de Identificação"
              className={cn(inputClassName, 'pl-10')}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
          <select
            className={cn(inputClassName, 'w-full sm:w-auto sm:min-w-[180px]')}
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as 'all' | DidStatus)
            }
          >
            <option value="all">Todos os status</option>
            <option value="rascunho">Rascunho</option>
            <option value="alinhado">Alinhado</option>
            <option value="executado">Executado</option>
            <option value="arquivado">Arquivado</option>
          </select>
        </>
      }
      footer={
        total > 0 ? (
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
      {loading && dids.length === 0 ? (
        <div className="p-6">
          <InlineLoadingState label="Carregando registros operacionais do dia..." />
        </div>
      ) : null}

      {loading && dids.length > 0 ? (
        <InlineLoadingState label="Atualizando registros do Início do Dia..." />
      ) : null}

      {!loading && dids.length === 0 ? (
        <div className="p-6">
          <EmptyState
            title="Nenhum registro encontrado"
            description={
              deferredSearchTerm || statusFilter !== 'all'
                ? 'Nenhum resultado corresponde aos filtros aplicados.'
                : 'Ainda não existem Diálogos do Início do Dia no escopo atual.'
            }
            action={
              !deferredSearchTerm && statusFilter === 'all' && canManageDids ? (
                <Link
                  href="/dashboard/dids/new"
                  className={cn(buttonVariants(), 'inline-flex items-center')}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Novo DID
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ResponsiveDataList
          items={dids}
          getKey={(did) => did.id}
          mobileClassName="space-y-3 p-3"
          mobile={(did) => {
            const isBusy = busyDidId === did.id;
            const isEditLocked = Boolean(did.pdf_file_key) || did.status === 'arquivado';
            const transitions = getAllowedStatusTransitions(did);
            const actions = getGovernedDocumentActionPolicy({
              canManage: canManageDids,
              hasFinalPdf: Boolean(did.pdf_file_key),
              isDraft: did.status === 'rascunho',
              isArchived: did.status === 'arquivado',
              hasStatusTransitions: transitions.length > 0,
            });
            return (
              <article className="ds-mobile-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><h3 className="font-semibold text-[var(--ds-color-text-primary)]">{did.titulo}</h3><p className="mt-1 text-sm text-[var(--ds-color-text-muted)]">{safeFormatDate(did.data, 'dd/MM/yyyy', { locale: ptBR })} · {did.site?.nome || did.site_id}</p></div>
                  <span className={cn('shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold', DID_STATUS_COLORS[did.status])}>{DID_STATUS_LABEL[did.status]}</span>
                </div>
                <dl className="ds-mobile-detail-grid mt-3 grid grid-cols-1 gap-3 text-sm min-[360px]:grid-cols-2"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Atividade</dt><dd>{did.atividade_principal}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Participantes</dt><dd>{did.participants?.length || 0} · {did.responsavel?.nome || 'Sem responsável'}</dd></div></dl>
                {actions.canChangeStatus ? <select aria-label={`Mover status de ${did.titulo}`} className={cn(inputClassName, 'mt-3')} value="" disabled={isBusy} onChange={(event) => event.target.value && void handleStatusChange(did, event.target.value as DidStatus)}><option value="">Mover para...</option>{transitions.map((status) => <option key={status} value={status}>{DID_STATUS_LABEL[status]}</option>)}</select> : null}
                <div className="ds-mobile-card__actions mt-4 grid grid-cols-1 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3 min-[360px]:grid-cols-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleOpenGovernedPdf(did)} disabled={isBusy || !actions.canOpenOrEmitFinalPdf} leftIcon={<ShieldCheck className="h-4 w-4" />}>{did.pdf_file_key ? 'Abrir PDF final' : 'Emitir PDF final'}</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void handlePrint(did)} disabled={isBusy || !actions.canPrintPdf} leftIcon={<Printer className="h-4 w-4" />}>Imprimir</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleEmail(did)} disabled={isBusy || !actions.canEmailPdf} leftIcon={<Mail className="h-4 w-4" />}>Enviar</Button>
                  {actions.canEdit && !isEditLocked ? <Link href={`/dashboard/dids/edit/${did.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'justify-center')}><Pencil className="mr-2 h-4 w-4" />Editar</Link> : null}
                  {actions.canDelete ? <Button type="button" size="sm" variant="destructive" onClick={() => void handleDelete(did.id)} loading={isBusy} leftIcon={<Trash2 className="h-4 w-4" />}>Excluir</Button> : null}
                </div>
              </article>
            );
          }}
          desktop={() => (
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Título</TableHead>
              <TableHead>Atividade</TableHead>
              <TableHead>Participantes</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dids.map((did) => {
              const transitions = getAllowedStatusTransitions(did);
              const isEditLocked =
                Boolean(did.pdf_file_key) || did.status === 'arquivado';
              const isBusy = busyDidId === did.id;
              const actions = getGovernedDocumentActionPolicy({
                canManage: canManageDids,
                hasFinalPdf: Boolean(did.pdf_file_key),
                isDraft: did.status === 'rascunho',
                isArchived: did.status === 'arquivado',
                hasStatusTransitions: transitions.length > 0,
              });
              const canEmitFinalPdf = actions.canOpenOrEmitFinalPdf && !did.pdf_file_key;

              return (
                <TableRow key={did.id} className="group">
                  <TableCell>
                    <div className="space-y-1">
                      <div className="font-medium text-[var(--ds-color-text-primary)]">
                        {safeFormatDate(did.data, 'dd/MM/yyyy', {
                          locale: ptBR,
                        })}
                      </div>
                      <div className="text-xs text-[var(--ds-color-text-muted)]">
                        {createdAtLabel(did)}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="font-medium text-[var(--ds-color-text-primary)]">
                        {did.titulo}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ds-color-text-muted)]">
                        <span>{did.site?.nome || did.site_id}</span>
                        {did.turno ? (
                          <span className="rounded-full border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] px-2 py-0.5">
                            {getDidTurnoLabel(did.turno)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="text-[var(--ds-color-text-secondary)]">
                        {did.atividade_principal}
                      </div>
                      <div className="text-xs text-[var(--ds-color-text-muted)]">
                        {did.frente_trabalho || 'Sem frente detalhada'}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 text-[var(--ds-color-text-secondary)]">
                      <Users className="h-4 w-4" />
                      <div className="space-y-0.5 text-left">
                        <div>{did.participants?.length || 0}</div>
                        <div className="text-xs text-[var(--ds-color-text-muted)]">
                          {did.responsavel?.nome || 'Sem responsável'}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
                          DID_STATUS_COLORS[did.status],
                        )}
                      >
                        {DID_STATUS_LABEL[did.status]}
                      </span>
                      {actions.canChangeStatus ? (
                        <select
                          className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-2.5 py-1.5 text-xs text-[var(--ds-color-text-muted)] shadow-sm"
                          value=""
                          disabled={isBusy}
                          onChange={(event) => {
                            if (event.target.value) {
                              void handleStatusChange(
                                did,
                                event.target.value as DidStatus,
                              );
                            }
                          }}
                        >
                          <option value="">Mover para...</option>
                          {transitions.map((status) => (
                            <option key={status} value={status}>
                              {DID_STATUS_LABEL[status]}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1 opacity-100 motion-safe:transition-opacity md:opacity-75 md:group-hover:opacity-100">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title={
                          did.pdf_file_key
                            ? 'Abrir PDF final governado'
                            : canEmitFinalPdf
                              ? 'Emitir PDF final governado'
                              : did.status === 'rascunho'
                                ? 'Mova para Alinhado antes de emitir o PDF final'
                                : did.status === 'arquivado'
                                  ? 'Somente usuarios com gestao podem emitir o PDF final arquivado'
                                  : 'Somente usuarios com gestao podem emitir o PDF final'
                        }
                        onClick={() => void handleOpenGovernedPdf(did)}
                        disabled={!actions.canOpenOrEmitFinalPdf}
                        loading={isBusy}
                      >
                        <ShieldCheck className="h-4 w-4 text-[var(--ds-color-success)]" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="Imprimir documento"
                        onClick={() => void handlePrint(did)}
                        disabled={isBusy || !actions.canPrintPdf}
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="Enviar por e-mail"
                        onClick={() => void handleEmail(did)}
                        disabled={isBusy || !actions.canEmailPdf}
                      >
                        <Mail className="h-4 w-4" />
                      </Button>
                      {canManageDids ? (
                        <>
                          <Link
                            href={isEditLocked ? '#' : `/dashboard/dids/edit/${did.id}`}
                            className={cn(
                              buttonVariants({ size: 'icon', variant: 'ghost' }),
                              isEditLocked ? 'cursor-not-allowed opacity-45' : '',
                            )}
                            onClick={(event) => {
                              if (isEditLocked) {
                                event.preventDefault();
                                toast.error(
                                  'Documento travado para edição. Gere um novo registro para alterar o conteúdo.',
                                );
                              }
                            }}
                            title={
                              isEditLocked
                                ? 'Documento travado para edição'
                                : 'Editar documento'
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </Link>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            title="Excluir documento"
                            className="text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]"
                            onClick={() => void handleDelete(did.id)}
                            loading={isBusy}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
          )}
        />
      )}

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
          storedDocument={selectedDoc.storedDocument}
        />
      ) : null}
    </ListPageLayout>
  );
}
