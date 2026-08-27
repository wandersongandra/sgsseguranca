import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { PrivilegedDbService } from '../../../shared/database/privileged-db.service';

interface RefreshResult {
  status: 'success' | 'error';
  table: string;
  duration_ms?: number;
  timestamp?: string;
  error?: string;
}

interface RefreshAllResult {
  status: 'success' | 'partial' | 'error';
  views: RefreshResult[];
  total_duration_ms: number;
  timestamp: string;
}

interface CacheStatusRow {
  row_count?: string | number;
}

interface MaterializedViewRow {
  matviewname?: string;
}

/**
 * 📊 Cache Refresh Service
 * Gerencia refresh de materialized views e cache invalidation
 *
 * Métodos:
 * - refreshDashboard() → Atualiza métricas do dashboard
 * - refreshRiskRankings() → Recalcula ranking de riscos
 * - refreshAll() → Atualiza todos os caches
 */

@Injectable()
export class CacheRefreshService {
  private readonly logger = new Logger('CacheRefreshService');

  constructor(private readonly privilegedDb: PrivilegedDbService) {}

  private async withCacheAdmin<T>(
    operation: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.privilegedDb.withRequiredPrivilegedClient(
      operation,
      async (client) => {
        // Materialized views are cross-tenant snapshots. The dedicated admin
        // connection must opt into the existing, role-gated global policy;
        // the runtime pool never receives this flag.
        await client.query(
          "SELECT set_config('app.is_super_admin', 'true', false)",
        );
        try {
          return await callback(client);
        } finally {
          await client.query('RESET app.is_super_admin');
        }
      },
    );
  }

  private getErrorType(error: unknown): string {
    return error instanceof Error && error.name ? error.name : 'UnknownError';
  }

  private toInt(value: unknown): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    }

    return 0;
  }

  private async getAvailableMaterializedViews(
    viewNames: string[],
    client: PoolClient,
  ): Promise<Set<string>> {
    const rows: MaterializedViewRow[] = await client
      .query(
        `
        SELECT matviewname
        FROM pg_matviews
        WHERE schemaname = 'public'
          AND matviewname = ANY($1::text[])
      `,
        [viewNames],
      )
      .then((result) => result.rows as MaterializedViewRow[]);

    return new Set(
      rows
        .map((row) => row.matviewname)
        .filter((name): name is string => typeof name === 'string'),
    );
  }

  /**
   * Refresh dashboard metrics materialized view
   * Executa: REFRESH MATERIALIZED VIEW CONCURRENTLY company_dashboard_metrics
   */
  async refreshDashboard(companyId?: string): Promise<RefreshResult> {
    const startTime = Date.now();
    this.logger.log(
      `[Dashboard] Starting refresh${companyId ? ` for company ${companyId}` : ''}...`,
    );

    try {
      await this.withCacheAdmin('cache_refresh_dashboard', (client) =>
        client.query(
          'REFRESH MATERIALIZED VIEW CONCURRENTLY public.company_dashboard_metrics',
        ),
      );

      const duration = Date.now() - startTime;

      this.logger.log(`[Dashboard] Refresh completed in ${duration}ms`);

      return {
        status: 'success',
        table: 'company_dashboard_metrics',
        duration_ms: duration,
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      this.logger.error(
        `[Dashboard] Refresh failed (${this.getErrorType(error)}).`,
      );
      throw new ServiceUnavailableException(
        'Falha ao atualizar cache do dashboard.',
      );
    }
  }

  /**
   * Refresh APR risk rankings materialized view
   * Executa: REFRESH MATERIALIZED VIEW CONCURRENTLY apr_risk_rankings
   */
  async refreshRiskRankings(companyId?: string): Promise<RefreshResult> {
    const startTime = Date.now();
    this.logger.log(
      `[RiskRankings] Starting refresh${companyId ? ` for company ${companyId}` : ''}...`,
    );

    try {
      await this.withCacheAdmin('cache_refresh_risk_rankings', (client) =>
        client.query(
          'REFRESH MATERIALIZED VIEW CONCURRENTLY public.apr_risk_rankings',
        ),
      );

      const duration = Date.now() - startTime;

      this.logger.log(`[RiskRankings] Refresh completed in ${duration}ms`);

      return {
        status: 'success',
        table: 'apr_risk_rankings',
        duration_ms: duration,
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      this.logger.error(
        `[RiskRankings] Refresh failed (${this.getErrorType(error)}).`,
      );
      throw new ServiceUnavailableException(
        'Falha ao atualizar cache de rankings de risco.',
      );
    }
  }

  /**
   * Refresh all materialized views
   * Executado periodicamente (cron job) ou on-demand via API
   */
  async refreshAll(): Promise<RefreshAllResult> {
    const startTime = Date.now();
    const results: RefreshResult[] = [];

    this.logger.log('[CacheRefresh] Starting full cache refresh...');

    try {
      results.push(await this.refreshDashboard());
      results.push(await this.refreshRiskRankings());

      const totalDuration = Date.now() - startTime;

      this.logger.log(
        `[CacheRefresh] All caches refreshed in ${totalDuration}ms`,
      );

      return {
        status: 'success',
        views: results,
        total_duration_ms: totalDuration,
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      this.logger.error(
        `[CacheRefresh] Full refresh failed (${this.getErrorType(error)}).`,
      );
      throw new ServiceUnavailableException(
        'Falha ao atualizar os caches administrativos.',
      );
    }
  }

  /**
   * Invalidate cache timestamp (register last refresh)
   * Useful for monitoring cache freshness
   */
  async getCacheStatus(): Promise<{
    views: {
      name: string;
      row_count: number;
      available: boolean;
      last_refresh?: string;
    }[];
    timestamp: string;
  }> {
    try {
      const result = await this.withCacheAdmin(
        'cache_status',
        async (client) => {
          const requestedViews = [
            'company_dashboard_metrics',
            'apr_risk_rankings',
          ] as const;
          const availableViews = await this.getAvailableMaterializedViews(
            [...requestedViews],
            client,
          );
          const dashboardAvailable = availableViews.has(
            'company_dashboard_metrics',
          );
          const riskAvailable = availableViews.has('apr_risk_rankings');

          const dashboardStatus = dashboardAvailable
            ? ((
                await client.query(
                  'SELECT COUNT(*) as row_count FROM public.company_dashboard_metrics',
                )
              ).rows as CacheStatusRow[])
            : [];

          const riskStatus = riskAvailable
            ? ((
                await client.query(
                  'SELECT COUNT(*) as row_count FROM public.apr_risk_rankings',
                )
              ).rows as CacheStatusRow[])
            : [];

          return {
            requestedViews,
            availableViews,
            dashboardAvailable,
            riskAvailable,
            dashboardStatus,
            riskStatus,
          };
        },
      );

      const {
        requestedViews,
        availableViews,
        dashboardAvailable,
        riskAvailable,
        dashboardStatus,
        riskStatus,
      } = result;

      if (!dashboardAvailable || !riskAvailable) {
        this.logger.warn(
          `[CacheStatus] Materialized views unavailable: ${requestedViews
            .filter((viewName) => !availableViews.has(viewName))
            .join(', ')}`,
        );
      }

      return {
        views: [
          {
            name: 'company_dashboard_metrics',
            row_count: this.toInt(dashboardStatus[0]?.row_count),
            available: dashboardAvailable,
          },
          {
            name: 'apr_risk_rankings',
            row_count: this.toInt(riskStatus[0]?.row_count),
            available: riskAvailable,
          },
        ],
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to get cache status (${this.getErrorType(error)}).`,
      );
      throw new ServiceUnavailableException(
        'Falha ao consultar status do cache.',
      );
    }
  }
}
