import { Test, TestingModule } from '@nestjs/testing';
import { CacheRefreshService } from './cache-refresh.service';
import { PrivilegedDbService } from '../../../shared/database/privileged-db.service';

/**
 * 📊 Cache Refresh Service Tests
 * Validates materialized view refresh functionality
 */

describe('CacheRefreshService', () => {
  let service: CacheRefreshService;
  let mockClient: { query: jest.Mock };
  let mockPrivilegedDb: {
    withRequiredPrivilegedClient: jest.Mock;
  };

  beforeEach(async () => {
    mockClient = {
      query: jest.fn(),
    };
    mockClient.query.mockResolvedValue({ rows: [] });
    mockPrivilegedDb = {
      withRequiredPrivilegedClient: jest.fn(
        async (
          _operation: string,
          callback: (client: typeof mockClient) => Promise<unknown>,
        ) => callback(mockClient),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheRefreshService,
        {
          provide: PrivilegedDbService,
          useValue: mockPrivilegedDb,
        },
      ],
    }).compile();

    service = module.get<CacheRefreshService>(CacheRefreshService);
  });

  describe('refreshDashboard', () => {
    it('uses the dedicated privileged connection and resets the session flag', async () => {
      await service.refreshDashboard();

      expect(
        mockPrivilegedDb.withRequiredPrivilegedClient,
      ).toHaveBeenCalledWith('cache_refresh_dashboard', expect.any(Function));
      expect(mockClient.query.mock.calls.map(([sql]) => String(sql))).toEqual([
        "SELECT set_config('app.is_super_admin', 'true', false)",
        'REFRESH MATERIALIZED VIEW CONCURRENTLY public.company_dashboard_metrics',
        'RESET app.is_super_admin',
      ]);
    });

    it('does not accept a caller-controlled materialized view identifier', async () => {
      await service.refreshDashboard('company-not-used-for-sql');

      expect(mockClient.query).toHaveBeenCalledWith(
        'REFRESH MATERIALIZED VIEW CONCURRENTLY public.company_dashboard_metrics',
      );
      expect(
        mockClient.query.mock.calls.some(([sql]) =>
          String(sql).includes('company-not-used-for-sql'),
        ),
      ).toBe(false);
    });

    it('fails closed when the dedicated privileged connection is unavailable', async () => {
      mockPrivilegedDb.withRequiredPrivilegedClient.mockRejectedValueOnce(
        new Error('DATABASE_ADMIN_URL is missing'),
      );

      await expect(service.refreshDashboard()).rejects.toThrow(
        'Falha ao atualizar cache do dashboard.',
      );
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should successfully refresh dashboard metrics view', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await service.refreshDashboard();

      expect(result.status).toBe('success');
      expect(result.table).toBe('company_dashboard_metrics');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should record execution time', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await service.refreshDashboard();

      expect(result.duration_ms).toBeDefined();
      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should handle refresh errors', async () => {
      mockClient.query.mockRejectedValue(new Error('View not found'));

      await expect(service.refreshDashboard()).rejects.toThrow();
    });

    it('should include timestamp in response', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await service.refreshDashboard();

      expect(result.timestamp).toBeDefined();
      if (!result.timestamp) {
        throw new Error('timestamp ausente em refreshDashboard');
      }
      expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
    });
  });

  describe('refreshRiskRankings', () => {
    it('should successfully refresh APR risk rankings view', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await service.refreshRiskRankings();

      expect(result.status).toBe('success');
      expect(result.table).toBe('apr_risk_rankings');
    });

    it('should measure refresh performance', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await service.refreshRiskRankings();

      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should handle refresh errors gracefully', async () => {
      mockClient.query.mockRejectedValue(new Error('View refresh in progress'));

      await expect(service.refreshRiskRankings()).rejects.toThrow();
    });
  });

  describe('refreshAll', () => {
    it('should refresh all materialized views', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await service.refreshAll();

      expect(result.status).toMatch(/success|partial|error/);
      expect(result.views.length).toBeGreaterThan(0);
      expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should report status for each view', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await service.refreshAll();

      expect(
        result.views.every((v) =>
          Object.prototype.hasOwnProperty.call(v, 'status'),
        ),
      ).toBe(true);
      expect(
        result.views.every((v) =>
          Object.prototype.hasOwnProperty.call(v, 'duration_ms'),
        ),
      ).toBe(true);
    });

    it('should report overall status as success only if all views succeed', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await service.refreshAll();

      const allSuccess = result.views.every((v) => v.status === 'success');
      if (allSuccess) {
        expect(result.status).toBe('success');
      } else {
        expect(result.status).toMatch(/partial|error/);
      }
    });

    it('should fail closed when one view fails', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('First view failed'))
        .mockResolvedValueOnce({ rows: [] });

      await expect(service.refreshAll()).rejects.toThrow(
        'Falha ao atualizar os caches administrativos.',
      );

      expect(mockClient.query).toHaveBeenCalledWith('RESET app.is_super_admin');
      expect(mockClient.query).not.toHaveBeenCalledWith(
        'REFRESH MATERIALIZED VIEW CONCURRENTLY public.apr_risk_rankings',
      );
    });
  });

  describe('getCacheStatus', () => {
    it('should return row counts for each view', async () => {
      mockClient.query
        .mockResolvedValueOnce({
          rows: [],
        })
        .mockResolvedValueOnce({
          rows: [
            { matviewname: 'company_dashboard_metrics' },
            { matviewname: 'apr_risk_rankings' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ row_count: 50 }] }) // dashboard
        .mockResolvedValueOnce({ rows: [{ row_count: 200 }] }); // rankings

      const result = await service.getCacheStatus();

      expect(result.views.length).toBe(2);
      expect(result.views[0].name).toBe('company_dashboard_metrics');
      expect(result.views[0].row_count).toBe(50);
      expect(result.views[0].available).toBe(true);
      expect(result.views[1].name).toBe('apr_risk_rankings');
      expect(result.views[1].row_count).toBe(200);
      expect(result.views[1].available).toBe(true);
      const queryCalls = mockClient.query.mock.calls as unknown[][];
      expect(String(queryCalls[1]?.[0])).toContain(
        "WHERE schemaname = 'public'",
      );
    });

    it('should handle missing views gracefully', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getCacheStatus();

      expect(result.views).toEqual([
        {
          name: 'company_dashboard_metrics',
          row_count: 0,
          available: false,
        },
        {
          name: 'apr_risk_rankings',
          row_count: 0,
          available: false,
        },
      ]);
    });

    it('should include timestamp', async () => {
      mockClient.query
        .mockResolvedValueOnce({
          rows: [],
        })
        .mockResolvedValueOnce({
          rows: [
            { matviewname: 'company_dashboard_metrics' },
            { matviewname: 'apr_risk_rankings' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ row_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ row_count: 0 }] });

      const result = await service.getCacheStatus();

      expect(result.timestamp).toBeDefined();
      if (!result.timestamp) {
        throw new Error('timestamp ausente em getCacheStatus');
      }
      expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
    });
  });
});
