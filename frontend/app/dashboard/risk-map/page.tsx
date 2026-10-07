'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { AxiosResponse } from 'axios';
import api from '@/lib/api';
import { sitesService } from '@/services/sitesService';
import { Map as MapIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LazyChart } from '@/components/LazyChart';
import { useCachedFetch } from '@/hooks/useCachedFetch';
import { CACHE_KEYS } from '@/lib/cache/cacheKeys';

const RISK_MAP_CACHE_TTL_MS = 60_000;
const SITES_CACHE_TTL_MS = 5 * 60 * 1000;

const RiskCategoryBarChart = dynamic(
  () =>
    import('./components/RiskMapCharts').then(
      (module) => module.RiskCategoryBarChart,
    ),
  {
    ssr: false,
    loading: () => <LazyChart height={248} />,
  },
);

interface RiskCell {
  categoria: string;
  prob: number;
  sev: number;
  count: number;
}

interface Site {
  id: string;
  nome: string;
}

interface RiskMatrixResponse {
  matrix?: RiskCell[];
}

function getCellTone(score: number): 'success' | 'warning' | 'accent' | 'danger' {
  if (score <= 4) return 'success';
  if (score <= 9) return 'warning';
  if (score <= 16) return 'accent';
  return 'danger';
}

function getCellClass(score: number) {
  const tone = getCellTone(score);
  if (tone === 'success') {
    return 'border-[var(--ds-color-success)]/35 bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success)]';
  }
  if (tone === 'warning') {
    return 'border-[var(--ds-color-warning)]/35 bg-[var(--ds-color-warning-subtle)] text-[var(--ds-color-warning)]';
  }
  if (tone === 'accent') {
    return 'border-[var(--ds-color-accent)]/35 bg-[var(--ds-color-accent-subtle)] text-[var(--ds-color-accent)]';
  }
  return 'border-[var(--ds-color-danger)]/35 bg-[var(--ds-color-danger-subtle)] text-[var(--ds-color-danger)]';
}

export default function RiskMapPage() {
  const fetchRiskMatrix = useCallback(
    (siteId?: string): Promise<AxiosResponse<RiskMatrixResponse>> =>
      api.get<RiskMatrixResponse>('/aprs/risks/matrix', {
        params: siteId ? { site_id: siteId } : {},
      }),
    [],
  );
  const fetchSitesPage = useCallback(
    (params: { page: number; limit: number }) =>
      sitesService.findPaginated(params),
    [],
  );
  const riskMatrixCache = useCachedFetch(
    CACHE_KEYS.riskMapMatrix,
    fetchRiskMatrix,
    RISK_MAP_CACHE_TTL_MS,
  );
  const sitesLookupCache = useCachedFetch(
    CACHE_KEYS.riskMapSites,
    fetchSitesPage,
    SITES_CACHE_TTL_MS,
  );
  const [matrix, setMatrix] = useState<RiskCell[]>([]);
  const [matrixLoading, setMatrixLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [filterSite, setFilterSite] = useState('');

  const loadMatrix = useCallback(async () => {
    setMatrixLoading(true);
    try {
      const res = await riskMatrixCache.fetch(filterSite || undefined);
      setMatrix(res.data.matrix ?? []);
    } catch {
      setMatrix([]);
    } finally {
      setMatrixLoading(false);
    }
  }, [filterSite, riskMatrixCache]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  useEffect(() => {
    sitesLookupCache
      .fetch({ page: 1, limit: 100 })
      .then((res) => {
        setSites(res.data);
      })
      .catch(() => {
        toast.error('Não foi possível carregar a lista de obras.');
      });
  }, [sitesLookupCache]);

  const { cellMap, chartData, totalRiscos, highRisks } = useMemo(() => {
    const nextCellMap: Record<string, { count: number; categorias: string[] }> =
      {};
    const cellCategories = new Map<string, Set<string>>();
    const categoryData: Record<string, number> = {};
    let total = 0;
    let high = 0;

    for (const item of matrix) {
      const key = `${item.prob}_${item.sev}`;
      if (!nextCellMap[key]) {
        nextCellMap[key] = { count: 0, categorias: [] };
        cellCategories.set(key, new Set<string>());
      }

      nextCellMap[key].count += item.count;
      total += item.count;
      if (item.prob * item.sev >= 17) {
        high += item.count;
      }

      if (item.categoria) {
        cellCategories.get(key)?.add(item.categoria);
      }

      const category = item.categoria ?? 'Outros';
      categoryData[category] = (categoryData[category] ?? 0) + item.count;
    }

    for (const [key, categories] of cellCategories.entries()) {
      if (!nextCellMap[key]) continue;
      nextCellMap[key]!.categorias = Array.from(categories);
    }

    const nextChartData = Object.entries(categoryData)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      cellMap: nextCellMap,
      chartData: nextChartData,
      totalRiscos: total,
      highRisks: high,
    };
  }, [matrix]);

  return (
    <div className="space-y-6">
      <Card tone="elevated" padding="lg">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--ds-color-accent-subtle)] text-[var(--ds-color-accent)]">
              <MapIcon className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-[var(--ds-color-text-primary)]">Mapa de Risco</h1>
              <p className="text-sm text-[var(--ds-color-text-secondary)]">Matriz de probabilidade × severidade por APR</p>
            </div>
          </div>
          <select
            value={filterSite}
            onChange={(e) => setFilterSite(e.target.value)}
            className="h-10 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-[13px] text-[var(--ds-color-text-primary)] shadow-[var(--ds-shadow-sm)] outline-none motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-focus)] focus:shadow-[0_0_0_4px_var(--ds-color-focus-ring)]"
          >
            <option value="">Todas as obras</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {matrixLoading ? (
          <>
            <div className="ds-kpi-card ds-kpi-card--primary">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-current opacity-80">Total de riscos</p>
              <div className="mt-1 h-8 w-20 animate-pulse rounded bg-current/20" />
            </div>
            <div className="ds-kpi-card ds-kpi-card--danger">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-current opacity-80">Risco alto/crítico</p>
              <div className="mt-1 h-8 w-20 animate-pulse rounded bg-current/20" />
              <div className="mt-2 h-3 w-24 animate-pulse rounded bg-current/15" />
            </div>
            <div className="ds-kpi-card ds-kpi-card--accent">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-current opacity-80">Categorias</p>
              <div className="mt-1 h-8 w-20 animate-pulse rounded bg-current/20" />
            </div>
          </>
        ) : (
          <>
            <div className="ds-kpi-card ds-kpi-card--primary">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-current opacity-80">Total de riscos</p>
              <p className="mt-1 text-[1.55rem] font-bold text-current">{totalRiscos}</p>
            </div>
            <div className="ds-kpi-card ds-kpi-card--danger">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-current opacity-80">Risco alto/crítico</p>
              <p className="mt-1 text-[1.55rem] font-bold text-current">{highRisks}</p>
              <p className="text-[11px] text-current opacity-80">Score ≥ 17</p>
            </div>
            <div className="ds-kpi-card ds-kpi-card--accent">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-current opacity-80">Categorias</p>
              <p className="mt-1 text-[1.55rem] font-bold text-current">{chartData.length}</p>
            </div>
          </>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card tone="elevated" padding="lg">
          <CardHeader className="mb-4 px-0 pt-0">
            <CardTitle className="text-base">Matriz Probabilidade × Severidade</CardTitle>
            <CardDescription>Distribuição dos riscos por score operacional.</CardDescription>
          </CardHeader>

          {matrixLoading ? (
            <div className="flex h-48 items-center justify-center">
              <div className="h-8 w-8 motion-safe:animate-spin rounded-full border-2 border-[var(--ds-color-accent)] border-t-transparent" />
            </div>
          ) : (
            <div className="ds-table-scroll overflow-x-auto pb-1">
              <div className="mb-1 flex min-w-[420px]">
                <div className="w-20" />
                {[1, 2, 3, 4, 5].map((sev) => (
                  <div key={sev} className="flex-1 text-center text-xs font-semibold text-[var(--ds-color-text-secondary)]">
                    S{sev}
                  </div>
                ))}
              </div>
              <div className="mb-3 flex min-w-[420px]">
                <div className="w-20 pr-2 text-right text-xs text-[var(--ds-color-text-secondary)]">Prob ↓ / Sev →</div>
                <div className="flex-1" />
              </div>

              {[5, 4, 3, 2, 1].map((prob) => (
                <div key={prob} className="mb-1 flex min-w-[420px] items-center">
                  <div className="w-20 pr-3 text-right text-xs font-semibold text-[var(--ds-color-text-secondary)]">P{prob}</div>
                  {[1, 2, 3, 4, 5].map((sev) => {
                    const score = prob * sev;
                    const cell = cellMap[`${prob}_${sev}`];
                    return (
                      <div
                        key={sev}
                        className={`m-0.5 flex h-12 flex-1 flex-col items-center justify-center rounded border text-xs font-bold ${getCellClass(score)}`}
                        title={cell?.categorias.join(', ') ?? `Score ${score}`}
                      >
                        <span className="text-base leading-none">{cell?.count ?? ''}</span>
                        <span className="text-[10px] opacity-60">{score}</span>
                      </div>
                    );
                  })}
                </div>
              ))}

              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <Badge variant="success">Baixo (1-4)</Badge>
                <Badge variant="warning">Médio (5-9)</Badge>
                <Badge variant="accent">Alto (10-16)</Badge>
                <Badge variant="danger">Crítico (17-25)</Badge>
              </div>
            </div>
          )}
        </Card>

        <Card tone="elevated" padding="lg">
          <CardHeader className="mb-4 px-0 pt-0">
            <CardTitle className="text-base">Riscos por Categoria</CardTitle>
            <CardDescription>Concentração de riscos por tema operacional.</CardDescription>
          </CardHeader>
          {matrixLoading ? (
            <div className="flex h-48 items-center justify-center">
              <div className="h-8 w-8 motion-safe:animate-spin rounded-full border-2 border-[var(--ds-color-accent)] border-t-transparent" />
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-[var(--ds-color-text-secondary)]">Nenhum risco encontrado</div>
          ) : (
            <RiskCategoryBarChart data={chartData} />
          )}
        </Card>
      </div>
    </div>
  );
}
