'use client';
import { logger } from '@/lib/logger';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarDays, Plus, Receipt, Search, WalletCards } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState, ErrorState, InlineLoadingState } from '@/components/ui/state';
import { PaginationControls } from '@/components/PaginationControls';
import { ResponsiveDataList } from '@/components/ui/responsive-data-list';
import { ListPageLayout, type MetricItem } from '@/components/layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';
import { sitesService, type Site } from '@/services/sitesService';
import { usersService, type User } from '@/services/usersService';
import {
  expensesService,
  EXPENSE_STATUS_LABEL,
  type ExpenseReport,
  type ExpenseReportStatus,
} from '@/services/expensesService';

const inputClassName =
  'min-h-11 w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]';

function formatMoney(value: string | number | undefined) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(value || 0));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
}

export default function ExpensesPage() {
  const { hasPermission } = useAuth();
  const router = useRouter();
  const canViewExpenses = hasPermission(Permission.CAN_VIEW_EXPENSES);
  const canManageExpenses = hasPermission(Permission.CAN_MANAGE_EXPENSES);
  const [reports, setReports] = useState<ExpenseReport[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(() =>
    selectedTenantStore.get()?.companyId || sessionStore.get()?.companyId || null,
  );
  const [usersLoaded, setUsersLoaded] = useState(false);
  const usersLoadPromiseRef = useRef<Promise<void> | null>(null);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [siteFilter, setSiteFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<ExpenseReportStatus | ''>('');
  const [periodStartFilter, setPeriodStartFilter] = useState('');
  const [periodEndFilter, setPeriodEndFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    site_id: '',
    responsible_id: '',
    period_start: monthStartIso(),
    period_end: todayIso(),
    notes: '',
  });

  useEffect(() => {
    const syncActiveCompanyId = () => {
      setActiveCompanyId(
        selectedTenantStore.get()?.companyId ||
          sessionStore.get()?.companyId ||
          null,
      );
    };

    syncActiveCompanyId();
    const unsubscribe = selectedTenantStore.subscribe(syncActiveCompanyId);
    return () => {
      unsubscribe();
    };
  }, []);

  const metrics = useMemo<MetricItem[]>(() => {
    const totalAdvances = reports.reduce(
      (sum, report) => sum + Number(report.totals?.totalAdvances || report.total_advances || 0),
      0,
    );
    const totalExpenses = reports.reduce(
      (sum, report) => sum + Number(report.totals?.totalExpenses || report.total_expenses || 0),
      0,
    );
    return [
      { label: 'Prestações', value: String(total), tone: 'neutral' },
      { label: 'Adiantado', value: formatMoney(totalAdvances), tone: 'primary' },
      { label: 'Despesas', value: formatMoney(totalExpenses), tone: 'warning' },
      { label: 'Saldo', value: formatMoney(totalAdvances - totalExpenses), tone: totalAdvances - totalExpenses >= 0 ? 'success' : 'danger' },
    ];
  }, [reports, total]);

  const loadData = useCallback(async () => {
    try {
      setReportsLoading(true);
      setLoadError(null);
      if (!activeCompanyId) {
        setReports([]);
        setTotal(0);
        setLastPage(1);
        return;
      }
      const reportsPage = await expensesService.findPaginated({
        page,
        limit: 10,
        site_id: siteFilter || undefined,
        status: statusFilter || undefined,
        period_start: periodStartFilter || undefined,
        period_end: periodEndFilter || undefined,
      });
      setReports(reportsPage.data);
      setTotal(reportsPage.total);
      setLastPage(reportsPage.lastPage);
    } catch (error) {
      logger.error('Erro ao carregar despesas:', error);
      setLoadError('Não foi possível carregar o módulo de despesas.');
      toast.error('Erro ao carregar despesas.');
    } finally {
      setReportsLoading(false);
    }
  }, [activeCompanyId, page, periodEndFilter, periodStartFilter, siteFilter, statusFilter]);

  const loadSites = useCallback(async () => {
    try {
      setSitesLoading(true);
      if (!activeCompanyId) {
        setSites([]);
        return;
      }
      const sitesList = await sitesService.findAll(activeCompanyId);
      setSites(sitesList);
      setForm((current) => ({
        ...current,
        site_id: current.site_id || sitesList[0]?.id || '',
      }));
    } catch (error) {
      logger.error('Erro ao carregar obras para despesas:', error);
      toast.error('Não foi possível carregar as obras disponíveis.');
      setSites([]);
    } finally {
      setSitesLoading(false);
    }
  }, [activeCompanyId]);

  const ensureUsersLoaded = useCallback(async () => {
    if (!activeCompanyId) {
      setUsers([]);
      setUsersLoaded(false);
      return;
    }

    if (usersLoaded) {
      return;
    }
    if (usersLoadPromiseRef.current) {
      await usersLoadPromiseRef.current;
      return;
    }

    const loadPromise = (async () => {
      try {
        const usersList = await usersService.findAll(activeCompanyId);
        setUsers(usersList);
        setUsersLoaded(true);
        setForm((current) => ({
          ...current,
          responsible_id: current.responsible_id || usersList[0]?.id || '',
        }));
      } catch (error) {
        logger.error('Erro ao carregar responsáveis das despesas:', error);
        toast.error('Não foi possível carregar os responsáveis das despesas.');
        throw error;
      } finally {
        usersLoadPromiseRef.current = null;
      }
    })();

    usersLoadPromiseRef.current = loadPromise;
    await loadPromise;
  }, [activeCompanyId, usersLoaded]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCompanyId) {
      toast.error('Selecione uma empresa antes de criar uma prestação.');
      return;
    }
    if (!form.site_id || !form.responsible_id) {
      toast.error('Selecione obra e responsável.');
      return;
    }

    try {
      setSubmitting(true);
      const report = await expensesService.create(form);
      toast.success('Prestação de despesas criada.');
      setShowCreate(false);
      await loadData();
      router.push(`/dashboard/expenses/${report.id}`);
    } catch (error) {
      logger.error('Erro ao criar prestação:', error);
      toast.error('Erro ao criar prestação de despesas.');
    } finally {
      setSubmitting(false);
    }
  }

  const handleToggleCreate = useCallback(async () => {
    if (!activeCompanyId) {
      toast.error('Selecione uma empresa antes de criar uma prestação.');
      return;
    }

    if (showCreate) {
      setShowCreate(false);
      return;
    }

    try {
      await ensureUsersLoaded();
      setShowCreate(true);
    } catch {
      return;
    }
  }, [activeCompanyId, ensureUsersLoaded, showCreate]);

  if (!canViewExpenses && !canManageExpenses) {
    return <ErrorState title="Acesso restrito" description="Você não possui permissão para visualizar despesas." />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="Falha ao carregar despesas"
        description={loadError}
        action={<Button onClick={() => void loadData()}>Tentar novamente</Button>}
      />
    );
  }

  return (
    <ListPageLayout
      eyebrow="Campo e Operação"
      title="Despesas por obra"
      description="Controle adiantamentos, comprovantes e fechamento financeiro por obra."
      icon={<WalletCards className="h-5 w-5" />}
      metrics={reportsLoading && reports.length === 0 ? [] : metrics}
        actions={canManageExpenses ?
          <Button type="button" onClick={() => void handleToggleCreate()}>
            <Plus className="mr-2 h-4 w-4" />
            Nova prestação
          </Button> : null
        }
      toolbarContent={
        <div className="grid gap-3 md:grid-cols-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
            <select
              aria-label="Filtrar por obra"
              className={cn(inputClassName, 'pl-10')}
              value={siteFilter}
              onChange={(event) => {
                setSiteFilter(event.target.value);
                setPage(1);
              }}
              disabled={sitesLoading && sites.length === 0}
            >
              <option value="">Todas as obras</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.nome}
                </option>
              ))}
            </select>
          </div>
          <select
            aria-label="Filtrar por status"
            className={inputClassName}
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as ExpenseReportStatus | '');
              setPage(1);
            }}
          >
            <option value="">Todos os status</option>
            <option value="aberta">Aberta</option>
            <option value="fechada">Fechada</option>
            <option value="cancelada">Cancelada</option>
          </select>
          <input
            type="date"
            aria-label="Início do período"
            className={inputClassName}
            value={periodStartFilter}
            onChange={(event) => {
              setPeriodStartFilter(event.target.value);
              setPage(1);
            }}
          />
          <input
            type="date"
            aria-label="Fim do período"
            className={inputClassName}
            value={periodEndFilter}
            onChange={(event) => {
              setPeriodEndFilter(event.target.value);
              setPage(1);
            }}
          />
        </div>
      }
      footer={
        total > 0 ? (
          <PaginationControls
            page={page}
            lastPage={lastPage}
            total={total}
            onPrev={() => setPage((current) => Math.max(1, current - 1))}
            onNext={() => setPage((current) => Math.min(lastPage, current + 1))}
          />
        ) : null
      }
    >

      {showCreate ? (
        <form
          onSubmit={(event) => void handleCreate(event)}
          className="grid gap-3 border-b border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] p-4 md:grid-cols-2"
        >
          <select
            className={inputClassName}
            value={form.site_id}
            onChange={(event) => setForm((current) => ({ ...current, site_id: event.target.value }))}
            required
            disabled={sitesLoading && sites.length === 0}
          >
            <option value="">Selecione a obra</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.nome}
              </option>
            ))}
          </select>
          <select
            className={inputClassName}
            value={form.responsible_id}
            onChange={(event) => setForm((current) => ({ ...current, responsible_id: event.target.value }))}
            required
          >
            <option value="">Selecione o responsável</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.nome}
              </option>
            ))}
          </select>
          <input
            type="date"
            className={inputClassName}
            value={form.period_start}
            onChange={(event) => setForm((current) => ({ ...current, period_start: event.target.value }))}
            required
          />
          <input
            type="date"
            className={inputClassName}
            value={form.period_end}
            onChange={(event) => setForm((current) => ({ ...current, period_end: event.target.value }))}
            required
          />
          <textarea
            className={cn(inputClassName, 'md:col-span-2')}
            rows={3}
            placeholder="Observações da prestação"
            value={form.notes}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
          />
          <div className="flex justify-end gap-2 md:col-span-2">
            <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              Criar prestação
            </Button>
          </div>
        </form>
      ) : null}

      <ResponsiveDataList
        items={reports}
        getKey={(report) => report.id}
        mobileClassName="space-y-3 p-3"
        loading={reportsLoading && reports.length === 0 ? <div className="p-6"><InlineLoadingState label="Carregando despesas..." /></div> : undefined}
        empty={<div className="p-6">
          <EmptyState
            title="Nenhuma prestação encontrada"
            description="Crie a primeira prestação para controlar adiantamentos e despesas por obra."
          />
        </div>}
        mobile={(report) => (
          <article className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><h3 className="font-semibold text-[var(--ds-color-text-primary)]">{report.site?.nome || report.site_id}</h3><p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">{report.responsible?.nome || report.responsible_id}</p></div>
              <span className="rounded-full bg-[var(--ds-color-surface-muted)] px-2.5 py-1 text-xs font-semibold">{EXPENSE_STATUS_LABEL[report.status]}</span>
            </div>
            <p className="mt-3 flex items-center gap-1 text-sm text-[var(--ds-color-text-secondary)]"><CalendarDays className="h-4 w-4" />{report.period_start} a {report.period_end}</p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-sm"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Adiantado</dt><dd className="font-medium">{formatMoney(report.totals?.totalAdvances)}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Despesas</dt><dd className="font-medium">{formatMoney(report.totals?.totalExpenses)}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Saldo</dt><dd className="font-medium">{formatMoney(report.totals?.balance)}</dd></div></dl>
            <Link href={`/dashboard/expenses/${report.id}`} className={cn(buttonVariants({ variant: 'outline' }), 'mt-4 flex min-h-11 w-full items-center justify-center')}><Receipt className="mr-2 h-4 w-4" />Abrir prestação</Link>
          </article>
        )}
        desktop={() => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Obra</TableHead>
              <TableHead>Responsável</TableHead>
              <TableHead>Período</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Adiantado</TableHead>
              <TableHead className="text-right">Despesas</TableHead>
              <TableHead className="text-right">Saldo</TableHead>
              <TableHead className="text-right">Ação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reports.map((report) => (
              <TableRow key={report.id}>
                <TableCell className="font-medium">{report.site?.nome || report.site_id}</TableCell>
                <TableCell>{report.responsible?.nome || report.responsible_id}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {report.period_start} a {report.period_end}
                  </span>
                </TableCell>
                <TableCell>{EXPENSE_STATUS_LABEL[report.status]}</TableCell>
                <TableCell className="text-right">{formatMoney(report.totals?.totalAdvances)}</TableCell>
                <TableCell className="text-right">{formatMoney(report.totals?.totalExpenses)}</TableCell>
                <TableCell className="text-right">{formatMoney(report.totals?.balance)}</TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/dashboard/expenses/${report.id}`}
                    className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'inline-flex items-center')}
                  >
                    <Receipt className="mr-2 h-4 w-4" />
                    Abrir
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        )}
      />
    </ListPageLayout>
  );
}
