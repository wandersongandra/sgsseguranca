'use client';
import { logger } from '@/lib/logger';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Archive, Download, Printer, Search, Sparkles } from 'lucide-react';
import { getISOWeek, getISOWeekYear, subWeeks } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';
import { companiesService, Company } from '@/services/companiesService';
import {
  documentRegistryService,
  DocumentRegistryEntry,
} from '@/services/documentRegistryService';
import { openPdfForPrint, preparePdfPrintWindow } from '@/lib/print-utils';
import { Button } from '@/components/ui/button';
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
import { ListPageLayout } from '@/components/layout';
import { cn } from '@/lib/utils';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { safeFormatDate } from '@/lib/date/safeFormat';

const inputClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]';

const moduleOptions = [
  { value: 'apr', label: 'APR' },
  { value: 'pt', label: 'PT' },
  { value: 'dds', label: 'DDS' },
  { value: 'did', label: 'Início do Dia' },
  { value: 'arr', label: 'ARR' },
  { value: 'checklist', label: 'Checklist' },
  { value: 'audit', label: 'Auditoria' },
  { value: 'nonconformity', label: 'NC' },
  { value: 'rdo', label: 'RDO' },
];

function parseYearFilter(value: string) {
  if (!value || !/^\d{4}$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 2020 || parsed > 2100) {
    return undefined;
  }
  return parsed;
}

function parseWeekFilter(value: string) {
  if (!value || !/^\d{1,2}$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 53) {
    return undefined;
  }
  return parsed;
}

export default function DocumentRegistryPage() {
  const [entries, setEntries] = useState<DocumentRegistryEntry[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState(
    () => selectedTenantStore.get()?.companyId || '',
  );
  const [companySearchTerm, setCompanySearchTerm] = useState('');
  const [year, setYear] = useState(String(getISOWeekYear(new Date())));
  const [week, setWeek] = useState(String(getISOWeek(new Date())));
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const deferredCompanySearchTerm = useDeferredValue(companySearchTerm);
  const deferredYear = useDeferredValue(year);
  const deferredWeek = useDeferredValue(week);
  const parsedYear = useMemo(
    () => parseYearFilter(deferredYear),
    [deferredYear],
  );
  const parsedWeek = useMemo(
    () => parseWeekFilter(deferredWeek),
    [deferredWeek],
  );

  const loadCompanies = useCallback(async () => {
    try {
      setLoadingCompanies(true);
      const response = await companiesService.findPaginated({
        page: 1,
        limit: 25,
        search: deferredCompanySearchTerm.trim() || undefined,
      });

      let nextCompanies = response.data;
      if (
        companyId &&
        !nextCompanies.some((company) => company.id === companyId)
      ) {
        try {
          const selectedCompany = await companiesService.findOne(companyId);
          nextCompanies = dedupeById([selectedCompany, ...nextCompanies]);
        } catch {
          nextCompanies = dedupeById(nextCompanies);
        }
      } else {
        nextCompanies = dedupeById(nextCompanies);
      }

      setCompanies(nextCompanies);
    } catch (loadError) {
      logger.error(
        'Erro ao carregar empresas do registry documental:',
        loadError,
      );
      toast.error('Erro ao carregar empresas disponíveis.');
    } finally {
      setLoadingCompanies(false);
    }
  }, [companyId, deferredCompanySearchTerm]);

  const loadPageData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const registryData = await documentRegistryService.list({
        company_id: companyId || undefined,
        year: parsedYear,
        week: parsedWeek,
        modules: selectedModules.length ? selectedModules : undefined,
      });
      setEntries(registryData);
    } catch (loadError) {
      logger.error('Erro ao carregar registry documental:', loadError);
      setError('Nao foi possivel carregar o registry documental.');
      toast.error('Erro ao carregar documentos consolidados.');
    } finally {
      setLoading(false);
    }
  }, [companyId, parsedWeek, parsedYear, selectedModules]);

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  useEffect(() => {
    const unsubscribe = selectedTenantStore.subscribe((tenant) => {
      setCompanyId(tenant?.companyId || '');
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const filteredEntries = useMemo(() => {
    const normalizedTerm = searchTerm.trim().toLowerCase();
    if (!normalizedTerm) {
      return entries;
    }

    return entries.filter((entry) => {
      return (
        (entry.title ?? '').toLowerCase().includes(normalizedTerm) ||
        (entry.module ?? '').toLowerCase().includes(normalizedTerm) ||
        (entry.document_code || '').toLowerCase().includes(normalizedTerm) ||
        (entry.original_name || '').toLowerCase().includes(normalizedTerm)
      );
    });
  }, [entries, searchTerm]);

  const summary = useMemo(() => {
    const byModule = moduleOptions.reduce<Record<string, number>>(
      (acc, option) => {
        acc[option.value] = entries.filter(
          (entry) => entry.module === option.value,
        ).length;
        return acc;
      },
      {},
    );

    return {
      total: entries.length,
      modules: new Set(entries.map((entry) => entry.module)).size,
      ...byModule,
    };
  }, [entries]);

  const activeCompanyName = useMemo(() => {
    if (!companyId) {
      return (
        selectedTenantStore.get()?.companyName ||
        'Todas as empresas disponíveis'
      );
    }
    return (
      companies.find((company) => company.id === companyId)?.razao_social ||
      'Empresa filtrada'
    );
  }, [companies, companyId]);

  const weeklyHighlights = useMemo(
    () =>
      moduleOptions
        .map((option) => ({
          ...option,
          count: entries.filter((entry) => entry.module === option.value)
            .length,
        }))
        .filter((item) => item.count > 0),
    [entries],
  );

  const handleToggleModule = (moduleName: string) => {
    setSelectedModules((current) =>
      current.includes(moduleName)
        ? current.filter((item) => item !== moduleName)
        : [...current, moduleName],
    );
  };

  const applyCurrentWeek = () => {
    const now = new Date();
    setYear(String(getISOWeekYear(now)));
    setWeek(String(getISOWeek(now)));
  };

  const applyPreviousWeek = () => {
    const target = subWeeks(new Date(), 1);
    setYear(String(getISOWeekYear(target)));
    setWeek(String(getISOWeek(target)));
  };

  const handleDownloadBundle = async () => {
    if (!parsedYear || !parsedWeek) {
      toast.error('Informe ano e semana para baixar o pacote.');
      return;
    }

    try {
      setLoadingBundle(true);
      const blob = await documentRegistryService.downloadWeeklyBundle({
        company_id: companyId || undefined,
        year: parsedYear,
        week: parsedWeek,
        modules: selectedModules.length ? selectedModules : undefined,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `documentos-semana-${parsedYear}-${String(parsedWeek).padStart(2, '0')}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      toast.success('Pacote consolidado gerado com sucesso.');
    } catch (bundleError) {
      logger.error('Erro ao baixar pacote consolidado:', bundleError);
      toast.error('Não foi possível gerar o pacote consolidado.');
    } finally {
      setLoadingBundle(false);
    }
  };

  const handleDownloadEntry = async (entry: DocumentRegistryEntry) => {
    try {
      const access = await documentRegistryService.getPdfAccess(entry.id);
      if (access.availability !== 'ready' || !access.url) {
        toast.error(
          access.message || 'PDF arquivado indisponível para download.',
        );
        return;
      }

      const anchor = document.createElement('a');
      anchor.href = access.url;
      anchor.download =
        access.originalName ||
        entry.original_name ||
        `${entry.module}-${entry.entity_id}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } catch (downloadError) {
      logger.error('Erro ao baixar PDF arquivado:', downloadError);
      toast.error('Não foi possível baixar o PDF arquivado.');
    }
  };

  const handlePrintEntry = async (entry: DocumentRegistryEntry) => {
    const printWindow = preparePdfPrintWindow();
    try {
      const access = await documentRegistryService.getPdfAccess(entry.id);
      if (access.availability !== 'ready' || !access.url) {
        printWindow?.close();
        toast.error(
          access.message || 'PDF arquivado indisponível para impressão.',
        );
        return;
      }

      openPdfForPrint(
        access.url,
        () => {
          toast.error(
            'Pop-up bloqueado. Permita pop-ups para imprimir sem sair do sistema.',
          );
        },
        printWindow,
      );
    } catch (printError) {
      printWindow?.close();
      logger.error('Erro ao imprimir PDF arquivado:', printError);
      toast.error('Não foi possível abrir o PDF arquivado para impressão.');
    }
  };

  const handlePrintBundle = async () => {
    if (!parsedYear || !parsedWeek) {
      toast.error('Informe ano e semana para imprimir o pacote.');
      return;
    }

    const printWindow = preparePdfPrintWindow();
    try {
      setLoadingBundle(true);
      const blob = await documentRegistryService.downloadWeeklyBundle({
        company_id: companyId || undefined,
        year: parsedYear,
        week: parsedWeek,
        modules: selectedModules.length ? selectedModules : undefined,
      });
      const url = URL.createObjectURL(blob);
      openPdfForPrint(
        url,
        () => {
          toast.error(
            'Pop-up bloqueado. Permita pop-ups para imprimir sem sair do sistema.',
          );
        },
        printWindow,
      );
    } catch (bundleError) {
      printWindow?.close();
      logger.error('Erro ao imprimir pacote consolidado:', bundleError);
      toast.error('Não foi possível abrir o pacote consolidado.');
    } finally {
      setLoadingBundle(false);
    }
  };

  const canBuildWeeklyBundle = Boolean(parsedYear && parsedWeek);

  if (error) {
    return (
      <ErrorState
        title="Falha ao carregar registry documental"
        description={error}
        action={
          <Button type="button" onClick={loadPageData}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  return (
    <ListPageLayout
      eyebrow="Governança documental"
      title="Registry documental"
      description="Índice central de documentos SST por empresa, semana e módulo, com pacote consolidado."
      icon={<Archive className="h-5 w-5" />}
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            leftIcon={<Download className="h-4 w-4" />}
            onClick={handleDownloadBundle}
            disabled={loadingBundle || !canBuildWeeklyBundle}
          >
            Baixar pacote
          </Button>
          <Button
            type="button"
            variant="outline"
            leftIcon={<Printer className="h-4 w-4" />}
            onClick={handlePrintBundle}
            disabled={loadingBundle || !canBuildWeeklyBundle}
          >
            Imprimir pacote
          </Button>
        </>
      }
      metrics={
        loading && entries.length === 0
          ? []
          : [
        {
          label: 'Documentos indexados',
          value: summary.total,
          note: 'Total governado no recorte atual.',
        },
        {
          label: 'Módulos presentes',
          value: summary.modules,
          note: 'Cobertura efetiva no índice semanal.',
          tone: 'primary',
        },
          ]
      }
      toolbarContent={
        <div className="grid w-full grid-cols-1 gap-3 xl:grid-cols-[1.2fr_repeat(2,minmax(0,0.55fr))_1fr]">
          <div className="space-y-2">
            <input
              type="text"
              value={companySearchTerm}
              onChange={(event) => setCompanySearchTerm(event.target.value)}
              placeholder="Buscar empresa no seletor"
              aria-label="Buscar empresa do pacote semanal"
              className={inputClassName}
            />
            <select
              aria-label="Selecionar empresa do pacote semanal"
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
              className={inputClassName}
              disabled={loadingCompanies}
            >
              <option value="">
                {loadingCompanies
                  ? 'Carregando empresas...'
                  : 'Tenant atual / empresas encontradas'}
              </option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.razao_social}
                </option>
              ))}
            </select>
          </div>
          <input
            type="number"
            min={2020}
            max={2100}
            aria-label="Selecionar ano documental"
            value={year}
            onChange={(event) => setYear(event.target.value)}
            placeholder="Ano"
            className={inputClassName}
          />
          <input
            type="number"
            min={1}
            max={53}
            aria-label="Selecionar semana ISO"
            value={week}
            onChange={(event) => setWeek(event.target.value)}
            placeholder="Semana ISO"
            className={inputClassName}
          />
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
            <input
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Buscar no índice"
              aria-label="Buscar documentos no índice central"
              className={cn(inputClassName, 'pl-10')}
            />
          </div>
          <div className="xl:col-span-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={applyCurrentWeek}
            >
              Semana atual
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={applyPreviousWeek}
            >
              Semana anterior
            </Button>
            {moduleOptions.map((option) => {
              const active = selectedModules.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleToggleModule(option.value)}
                  aria-pressed={active}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-sm motion-safe:transition-colors',
                    active
                      ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-action-primary)] text-[var(--ds-color-text-inverse)]'
                      : 'border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)] hover:border-[var(--ds-color-action-primary)] hover:text-[var(--ds-color-action-primary)]',
                  )}
                >
                  {option.label}
                </button>
              );
            })}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={loadPageData}
            >
              Atualizar lista
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {loading && entries.length === 0 ? (
          <div className="px-4 pt-2">
            <InlineLoadingState label="Carregando registry documental..." />
          </div>
        ) : null}

        <div className="mx-4 mt-1 flex flex-col gap-4 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 px-4 py-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
              Pacote operacional ativo
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Empresa: {activeCompanyName} · Semana{' '}
              {String(week || '—').padStart(2, '0')}/{year || '—'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="ds-badge ds-badge--info">
              <Sparkles className="h-3.5 w-3.5" />
              {selectedModules.length > 0
                ? `${selectedModules.length} módulo(s) filtrado(s)`
                : 'Todos os módulos'}
            </span>
            {weeklyHighlights.length > 0 ? (
              weeklyHighlights.map((item) => (
                <span key={item.value} className="ds-badge">
                  {item.label}: {item.count}
                </span>
              ))
            ) : (
              <span className="ds-badge">Sem documentos no recorte atual</span>
            )}
          </div>
        </div>

        {!loadingBundle && (loading || filteredEntries.length > 0) ? (
          <div className="px-4 pt-2 text-sm text-[var(--ds-color-text-secondary)]">
            {filteredEntries.length} documento(s) encontrado(s) no índice
            consolidado.
          </div>
        ) : null}

        <ResponsiveDataList
          items={filteredEntries}
          getKey={(entry) => entry.id}
          loading={
            loadingBundle ? (
              <div className="px-4 pb-4">
                <InlineLoadingState label="Gerando pacote consolidado" />
              </div>
            ) : undefined
          }
          empty={
            !loading ? (
              <div className="p-6">
                <EmptyState
                  title="Nenhum documento indexado"
                  description="Não há documentos no registry para o filtro aplicado."
                  compact
                />
              </div>
            ) : undefined
          }
          desktop={(desktopEntries) => (
            <div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Módulo</TableHead>
                    <TableHead>Título</TableHead>
                    <TableHead>Código</TableHead>
                    <TableHead>Arquivo</TableHead>
                    <TableHead>Semana</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {desktopEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        {entry.document_date
                          ? safeFormatDate(entry.document_date, 'dd/MM/yyyy', {
                              locale: ptBR,
                            })
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <span className="ds-badge">{entry.module}</span>
                      </TableCell>
                      <TableCell className="font-medium text-[var(--ds-color-text-primary)]">
                        {entry.title}
                      </TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {entry.document_code || '—'}
                      </TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {entry.original_name || '—'}
                      </TableCell>
                      <TableCell className="text-[var(--ds-color-text-secondary)]">
                        {String(entry.iso_week).padStart(2, '0')}/
                        {entry.iso_year}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            leftIcon={<Download className="h-3.5 w-3.5" />}
                            onClick={() => handleDownloadEntry(entry)}
                          >
                            Baixar
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            leftIcon={<Printer className="h-3.5 w-3.5" />}
                            onClick={() => handlePrintEntry(entry)}
                          >
                            Imprimir
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          mobileClassName="space-y-3 px-4 pb-4"
          mobile={(entry) => (
            <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                        {entry.title}
                      </p>
                      <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">
                        {entry.document_date
                          ? safeFormatDate(entry.document_date, 'dd/MM/yyyy', {
                              locale: ptBR,
                            })
                          : 'Sem data documental'}
                      </p>
                    </div>
                    <span className="ds-badge">{entry.module}</span>
                  </div>
                  <div className="mt-3 space-y-1 text-xs text-[var(--ds-color-text-secondary)]">
                    <p>Código: {entry.document_code || '—'}</p>
                    <p>Arquivo: {entry.original_name || '—'}</p>
                    <p>
                      Semana: {String(entry.iso_week).padStart(2, '0')}/
                      {entry.iso_year}
                    </p>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      leftIcon={<Download className="h-3.5 w-3.5" />}
                      onClick={() => handleDownloadEntry(entry)}
                    >
                      Baixar
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      leftIcon={<Printer className="h-3.5 w-3.5" />}
                      onClick={() => handlePrintEntry(entry)}
                    >
                      Imprimir
                    </Button>
                  </div>
            </div>
          )}
        />
      </div>
    </ListPageLayout>
  );
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}
