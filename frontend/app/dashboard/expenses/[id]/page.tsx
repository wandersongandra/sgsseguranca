'use client';
import { logger } from '@/lib/logger';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Download, ExternalLink, Lock, Plus, Receipt, Trash2, WalletCards } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { ErrorState, InlineLoadingState } from '@/components/ui/state';
import { PageHeader } from '@/components/layout';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { openSafeExternalUrlInNewTab } from '@/lib/security/safe-external-url';
import {
  expensesService,
  EXPENSE_ADVANCE_METHOD_LABEL,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_STATUS_LABEL,
  type ExpenseAdvanceMethod,
  type ExpenseCategory,
  type ExpenseReport,
} from '@/services/expensesService';

const inputClassName =
  'min-h-11 w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60';

function formatMoney(value: string | number | undefined) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(value || 0));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function safeDownloadName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export default function ExpenseReportDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { hasPermission, isAdminGeral } = useAuth();
  const [report, setReport] = useState<ExpenseReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [advanceForm, setAdvanceForm] = useState({
    amount: '',
    advance_date: todayIso(),
    method: 'pix' as ExpenseAdvanceMethod,
    description: '',
  });
  const [itemForm, setItemForm] = useState({
    category: 'transporte' as ExpenseCategory,
    amount: '',
    expense_date: todayIso(),
    description: '',
    vendor: '',
    location: '',
    file: null as File | null,
  });

  const canClose =
    isAdminGeral || hasPermission(Permission.CAN_CLOSE_EXPENSES);
  const canManage = isAdminGeral || hasPermission(Permission.CAN_MANAGE_EXPENSES);
  const canView = isAdminGeral || canManage || hasPermission(Permission.CAN_VIEW_EXPENSES);
  const isClosed = report?.status !== 'aberta';

  const categoryRows = useMemo(() => {
    if (!report) return [];
    return EXPENSE_CATEGORIES.map((category) => ({
      category,
      total: report.totals.totalsByCategory[category] || '0',
    })).filter((row) => Number(row.total) > 0);
  }, [report]);

  const loadReport = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      setReport(await expensesService.findOne(id));
    } catch (error) {
      logger.error('Erro ao carregar prestação:', error);
      setLoadError('Não foi possível carregar a prestação de despesas.');
      toast.error('Erro ao carregar prestação.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  async function handleAddAdvance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!report) return;
    try {
      setSubmitting(true);
      const next = await expensesService.addAdvance(report.id, {
        amount: Number(advanceForm.amount),
        advance_date: advanceForm.advance_date,
        method: advanceForm.method,
        description: advanceForm.description || undefined,
      });
      setReport(next);
      setAdvanceForm({
        amount: '',
        advance_date: todayIso(),
        method: 'pix',
        description: '',
      });
      toast.success('Adiantamento lançado.');
    } catch (error) {
      logger.error('Erro ao lançar adiantamento:', error);
      toast.error('Erro ao lançar adiantamento.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!report || !itemForm.file) {
      toast.error('Comprovante obrigatório para lançar despesa.');
      return;
    }
    try {
      setSubmitting(true);
      const next = await expensesService.addItem(report.id, {
        category: itemForm.category,
        amount: Number(itemForm.amount),
        expense_date: itemForm.expense_date,
        description: itemForm.description,
        vendor: itemForm.vendor || undefined,
        location: itemForm.location || undefined,
        file: itemForm.file,
      });
      setReport(next);
      setItemForm({
        category: 'transporte',
        amount: '',
        expense_date: todayIso(),
        description: '',
        vendor: '',
        location: '',
        file: null,
      });
      toast.success('Despesa lançada.');
    } catch (error) {
      logger.error('Erro ao lançar despesa:', error);
      toast.error('Erro ao lançar despesa.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleReceiptFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      toast.error('Formato não suportado. Use PDF, PNG, JPEG ou WebP.');
      event.target.value = '';
      setItemForm((current) => ({ ...current, file: null }));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Comprovante muito grande. O limite é 5 MB.');
      event.target.value = '';
      setItemForm((current) => ({ ...current, file: null }));
      return;
    }
    setItemForm((current) => ({ ...current, file }));
  }

  async function handleRemoveItem(itemId: string) {
    if (!report || !confirm('Remover esta despesa da prestação?')) return;
    try {
      const next = await expensesService.removeItem(report.id, itemId);
      setReport(next);
      toast.success('Despesa removida.');
    } catch (error) {
      logger.error('Erro ao remover despesa:', error);
      toast.error('Erro ao remover despesa.');
    }
  }

  async function handleOpenReceipt(itemId: string) {
    if (!report) return;
    try {
      const access = await expensesService.getReceiptAccess(report.id, itemId);
      openSafeExternalUrlInNewTab(access.url);
    } catch (error) {
      logger.error('Erro ao abrir comprovante:', error);
      toast.error('Erro ao abrir comprovante.');
    }
  }

  async function handleExport() {
    if (!report) return;
    try {
      const blob = await expensesService.exportReport(report.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `despesas-${safeDownloadName(report.site?.nome || report.id) || report.id}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      logger.error('Erro ao exportar relatório:', error);
      toast.error('Erro ao exportar relatório.');
    }
  }

  async function handleClose() {
    if (!report || !confirm('Fechar prestação? Após o fechamento não será possível alterar despesas ou adiantamentos.')) {
      return;
    }
    try {
      const next = await expensesService.close(report.id);
      setReport(next);
      toast.success('Prestação fechada.');
    } catch (error) {
      logger.error('Erro ao fechar prestação:', error);
      toast.error('Erro ao fechar prestação.');
    }
  }

  if (!canView) {
    return <ErrorState title="Acesso restrito" description="Você não possui permissão para visualizar despesas." />;
  }

  if (loading && !report) {
    return <div className="p-6"><InlineLoadingState label="Carregando prestação..." /></div>;
  }

  if (loadError || !report) {
    return (
      <ErrorState
        title="Falha ao carregar prestação"
        description={loadError || 'Prestação não encontrada.'}
        action={<Button onClick={() => void loadReport()}>Tentar novamente</Button>}
      />
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">

      <PageHeader
        eyebrow="Despesas por obra"
        title={report.site?.nome || 'Prestação de despesas'}
        description={`${report.period_start} a ${report.period_end} · ${EXPENSE_STATUS_LABEL[report.status]}`}
        icon={<WalletCards className="h-5 w-5" />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/dashboard/expenses" className={buttonVariants({ variant: 'outline' })}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Voltar
            </Link>
            <Button type="button" variant="outline" onClick={() => void handleExport()}>
              <Download className="mr-2 h-4 w-4" />
              Exportar
            </Button>
            {!isClosed && canClose ? (
              <Button type="button" onClick={() => void handleClose()}>
                <Lock className="mr-2 h-4 w-4" />
                Fechar
              </Button>
            ) : null}
          </div>
        }
      />

      <section className="grid gap-3 md:grid-cols-4">
        {[
          ['Adiantado', report.totals.totalAdvances],
          ['Despesas', report.totals.totalExpenses],
          ['Saldo', report.totals.balance],
          ['Itens', String(report.items?.length || 0)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4">
            <p className="text-xs font-semibold uppercase text-[var(--ds-color-text-muted)]">{label}</p>
            <p className="mt-2 text-xl font-bold text-[var(--ds-color-text-primary)]">
              {label === 'Itens' ? value : formatMoney(value)}
            </p>
          </div>
        ))}
      </section>

      {isClosed ? (
        <div className="rounded-lg border border-[var(--ds-color-warning)]/35 bg-[var(--ds-color-warning)]/10 p-4 text-sm text-[var(--ds-color-text-primary)]">
          Prestação fechada em {report.closed_at ? new Date(report.closed_at).toLocaleString('pt-BR') : 'data não informada'}. Os lançamentos ficam somente para consulta e exportação.
        </div>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]">
          <div className="border-b border-[var(--ds-color-border-subtle)] p-4">
            <h2 className="text-base font-semibold">Despesas lançadas</h2>
          </div>
          <ResponsiveDataList
            items={report.items || []}
            getKey={(item) => item.id}
            mobileClassName="space-y-3 p-3"
            mobile={(item) => (
              <article className="rounded-lg border border-[var(--ds-color-border-subtle)] p-4">
                <div className="flex justify-between gap-3"><div><h3 className="font-semibold">{item.description}</h3><p className="text-sm text-[var(--ds-color-text-secondary)]">{EXPENSE_CATEGORY_LABEL[item.category]} · {item.expense_date}</p></div><strong>{formatMoney(item.amount)}</strong></div>
                <p className="mt-2 text-xs text-[var(--ds-color-text-muted)]">{[item.vendor, item.location].filter(Boolean).join(' · ') || 'Sem fornecedor/local'}</p>
                <div className="mt-3 grid grid-cols-2 gap-2"><Button type="button" variant="outline" className="min-h-11" onClick={() => void handleOpenReceipt(item.id)}><ExternalLink className="mr-2 h-4 w-4" />Comprovante</Button>{!isClosed && canManage ? <Button type="button" variant="outline" className="min-h-11 text-[var(--ds-color-danger)]" onClick={() => void handleRemoveItem(item.id)}><Trash2 className="mr-2 h-4 w-4" />Remover</Button> : null}</div>
              </article>
            )}
            desktop={() => <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Comprovante</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(report.items || []).map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.expense_date}</TableCell>
                  <TableCell>{EXPENSE_CATEGORY_LABEL[item.category]}</TableCell>
                  <TableCell>
                    <div className="font-medium">{item.description}</div>
                    <div className="text-xs text-[var(--ds-color-text-muted)]">
                      {[item.vendor, item.location].filter(Boolean).join(' · ') || 'Sem fornecedor/local'}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{formatMoney(item.amount)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button type="button" size="icon" variant="ghost" title="Abrir comprovante" aria-label={`Abrir comprovante de ${item.description}`} onClick={() => void handleOpenReceipt(item.id)}>
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                      {!isClosed && canManage ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title="Remover despesa"
                          aria-label={`Remover despesa ${item.description}`}
                          className="text-[var(--ds-color-danger)]"
                          onClick={() => void handleRemoveItem(item.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>}
          />
          {(report.items || []).length === 0 ? (
            <div className="p-6 text-sm text-[var(--ds-color-text-muted)]">Nenhuma despesa lançada.</div>
          ) : null}
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4">
            <h2 className="text-base font-semibold">Totais por categoria</h2>
            <div className="mt-3 space-y-2">
              {categoryRows.length === 0 ? (
                <p className="text-sm text-[var(--ds-color-text-muted)]">Sem despesas categorizadas.</p>
              ) : (
                categoryRows.map((row) => (
                  <div key={row.category} className="flex justify-between text-sm">
                    <span>{EXPENSE_CATEGORY_LABEL[row.category]}</span>
                    <strong>{formatMoney(row.total)}</strong>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4">
            <h2 className="text-base font-semibold">Adiantamentos</h2>
            <div className="mt-3 space-y-2">
              {(report.advances || []).length === 0 ? (
                <p className="text-sm text-[var(--ds-color-text-muted)]">Nenhum adiantamento lançado.</p>
              ) : (
                (report.advances || []).map((advance) => (
                  <div key={advance.id} className="rounded-md border border-[var(--ds-color-border-subtle)] p-3 text-sm">
                    <div className="flex justify-between font-semibold">
                      <span>{EXPENSE_ADVANCE_METHOD_LABEL[advance.method]}</span>
                      <span>{formatMoney(advance.amount)}</span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">{advance.advance_date} · {advance.description || 'Sem descrição'}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {!isClosed && canManage ? (
        <section className="grid gap-6 lg:grid-cols-2">
          <form onSubmit={(event) => void handleAddItem(event)} className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Receipt className="h-4 w-4" />
              Nova despesa
            </h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <select className={inputClassName} value={itemForm.category} onChange={(event) => setItemForm((current) => ({ ...current, category: event.target.value as ExpenseCategory }))}>
                {EXPENSE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>{EXPENSE_CATEGORY_LABEL[category]}</option>
                ))}
              </select>
              <input className={inputClassName} type="number" min="0.01" step="0.01" placeholder="Valor" value={itemForm.amount} onChange={(event) => setItemForm((current) => ({ ...current, amount: event.target.value }))} required />
              <input className={inputClassName} type="date" value={itemForm.expense_date} onChange={(event) => setItemForm((current) => ({ ...current, expense_date: event.target.value }))} required />
              <input className={inputClassName} type="text" placeholder="Fornecedor" value={itemForm.vendor} onChange={(event) => setItemForm((current) => ({ ...current, vendor: event.target.value }))} />
              <input className={inputClassName} type="text" placeholder="Local" value={itemForm.location} onChange={(event) => setItemForm((current) => ({ ...current, location: event.target.value }))} />
              <input className={inputClassName} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => handleReceiptFileChange(event)} required />
              <textarea className={cn(inputClassName, 'md:col-span-2')} rows={3} placeholder="Descrição da despesa" value={itemForm.description} onChange={(event) => setItemForm((current) => ({ ...current, description: event.target.value }))} required />
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={submitting}>
                <Plus className="mr-2 h-4 w-4" />
                Lançar despesa
              </Button>
            </div>
          </form>

          <form onSubmit={(event) => void handleAddAdvance(event)} className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <WalletCards className="h-4 w-4" />
              Novo adiantamento
            </h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <input className={inputClassName} type="number" min="0.01" step="0.01" placeholder="Valor" value={advanceForm.amount} onChange={(event) => setAdvanceForm((current) => ({ ...current, amount: event.target.value }))} required />
              <input className={inputClassName} type="date" value={advanceForm.advance_date} onChange={(event) => setAdvanceForm((current) => ({ ...current, advance_date: event.target.value }))} required />
              <select className={inputClassName} value={advanceForm.method} onChange={(event) => setAdvanceForm((current) => ({ ...current, method: event.target.value as ExpenseAdvanceMethod }))}>
                {Object.entries(EXPENSE_ADVANCE_METHOD_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <input className={inputClassName} type="text" placeholder="Descrição" value={advanceForm.description} onChange={(event) => setAdvanceForm((current) => ({ ...current, description: event.target.value }))} />
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={submitting}>
                <Plus className="mr-2 h-4 w-4" />
                Lançar adiantamento
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </main>
  );
}
