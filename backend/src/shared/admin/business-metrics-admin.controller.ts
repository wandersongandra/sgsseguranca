import { Controller, Get, Optional, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';
import { RolesGuard } from '../../modules/auth/roles.guard';
import { Roles } from '../../modules/auth/roles.decorator';
import { Role } from '../../modules/auth/enums/roles.enum';
import { Authorize } from '../../modules/auth/authorize.decorator';
import { TenantOptional } from '../decorators/tenant-optional.decorator';
import { BusinessMetricsSummaryService } from '../observability/business-metrics-summary.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RedisService } from '../redis/redis.service';
import {
  N1QueryDetectorService,
  N1SuspectReport,
} from '../database/n1-query-detector.service';

type QueueStats = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  total: number;
  health: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'ERROR';
  error?: string;
};

type CacheStats = {
  hits: number;
  misses: number;
  hit_rate: number;
  memory_used: string;
  connected_clients: number;
  health: 'OK' | 'ERROR';
  error?: string;
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

@Controller('admin/metrics')
@TenantOptional()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class BusinessMetricsAdminController {
  constructor(
    private readonly businessMetricsSummaryService: BusinessMetricsSummaryService,
    private readonly redisService: RedisService,
    private readonly n1QueryDetector: N1QueryDetectorService,
    @Optional() @InjectQueue('mail') private readonly mailQueue?: Queue,
    @Optional()
    @InjectQueue('pdf-generation')
    private readonly pdfQueue?: Queue,
    @Optional()
    @InjectQueue('document-import')
    private readonly documentImportQueue?: Queue,
  ) {}

  @Get('business')
  @Authorize('can_view_system_health')
  async getBusinessMetrics() {
    return this.businessMetricsSummaryService.getBusinessSummaryByTenant();
  }

  @Get('performance')
  @Authorize('can_view_system_health')
  async getPerformanceMetrics() {
    const [mailQueueStats, pdfQueueStats, documentImportQueueStats] =
      await Promise.all([
        this.getQueueStats(this.mailQueue),
        this.getQueueStats(this.pdfQueue),
        this.getQueueStats(this.documentImportQueue),
      ]);

    const cacheStats = await this.getCacheStats();
    const n1Report = this.n1QueryDetector.analyzeQueries();

    return {
      timestamp: new Date().toISOString(),
      queues: {
        mail: mailQueueStats,
        pdf: pdfQueueStats,
        document_import: documentImportQueueStats,
      },
      cache: cacheStats,
      database: {
        n1_queries: {
          total_queries: n1Report.totalQueries,
          unique_patterns: n1Report.uniquePatterns,
          critical_suspects: n1Report.suspects.filter(
            (s) => s.severity === 'CRITICAL',
          ).length,
          high_suspects: n1Report.suspects.filter((s) => s.severity === 'HIGH')
            .length,
          slow_queries_count: n1Report.slowQueries.length,
        },
      },
      alerts: this.generateAlerts(
        mailQueueStats,
        pdfQueueStats,
        documentImportQueueStats,
        cacheStats,
        n1Report,
      ),
    };
  }

  private async getQueueStats(queue?: Queue): Promise<QueueStats> {
    if (!queue) {
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        total: 0,
        health: 'WARNING',
        error: 'queue unavailable',
      };
    }

    try {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      const waiting = counts.waiting ?? 0;
      const active = counts.active ?? 0;
      const completed = counts.completed ?? 0;
      const failed = counts.failed ?? 0;
      const delayed = counts.delayed ?? 0;

      return {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed,
        health: this.assessQueueHealth(waiting, active, failed),
      };
    } catch (error) {
      return {
        error: getErrorMessage(error),
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        total: 0,
        health: 'ERROR',
      };
    }
  }

  private async getCacheStats(): Promise<CacheStats> {
    try {
      // Tentar obter stats do Redis INFO command
      const info = await this.redisService.getClient().info();
      const lines = info.split('\n');
      const stats: Record<string, string> = {};

      lines.forEach((line) => {
        const [key, value] = line.split(':');
        if (key && value) {
          stats[key] = value;
        }
      });

      return {
        hits: parseInt(stats.keyspace_hits || '0'),
        misses: parseInt(stats.keyspace_misses || '0'),
        hit_rate:
          stats.keyspace_hits && stats.keyspace_misses
            ? (parseInt(stats.keyspace_hits) /
                (parseInt(stats.keyspace_hits) +
                  parseInt(stats.keyspace_misses))) *
              100
            : 0,
        memory_used: stats.used_memory_human || 'unknown',
        connected_clients: parseInt(stats.connected_clients || '0'),
        health: 'OK',
      };
    } catch (error) {
      return {
        error: getErrorMessage(error),
        hits: 0,
        misses: 0,
        hit_rate: 0,
        memory_used: 'unknown',
        connected_clients: 0,
        health: 'ERROR',
      };
    }
  }

  private assessQueueHealth(
    waiting: number,
    active: number,
    failed: number,
  ): 'HEALTHY' | 'WARNING' | 'CRITICAL' {
    void active;
    if (failed > 10 || waiting > 50) return 'CRITICAL';
    if (failed > 5 || waiting > 20) return 'WARNING';
    return 'HEALTHY';
  }

  private generateAlerts(
    mailStats: QueueStats,
    pdfStats: QueueStats,
    _docStats: QueueStats,
    cacheStats: CacheStats,
    n1Report: N1SuspectReport,
  ) {
    const alerts = [];

    // Queue alerts
    if (mailStats.health === 'CRITICAL') {
      alerts.push({
        level: 'CRITICAL',
        component: 'mail_queue',
        message: `Mail queue critical: ${mailStats.waiting} waiting, ${mailStats.failed} failed`,
        action: 'Check mail service and increase workers',
      });
    }

    if (pdfStats.health === 'CRITICAL') {
      alerts.push({
        level: 'CRITICAL',
        component: 'pdf_queue',
        message: `PDF queue critical: ${pdfStats.waiting} waiting, ${pdfStats.failed} failed`,
        action: 'Check PDF generation and increase workers',
      });
    }

    // Cache alerts
    if (cacheStats.hit_rate < 50 && cacheStats.hit_rate > 0) {
      alerts.push({
        level: 'WARNING',
        component: 'cache',
        message: `Low cache hit rate: ${cacheStats.hit_rate.toFixed(1)}%`,
        action: 'Review cache TTLs and keys',
      });
    }

    // N+1 alerts
    if (n1Report.suspects.filter((s) => s.severity === 'CRITICAL').length > 0) {
      alerts.push({
        level: 'CRITICAL',
        component: 'database',
        message: `${n1Report.suspects.filter((s) => s.severity === 'CRITICAL').length} critical N+1 patterns detected`,
        action: 'Fix N+1 queries immediately',
      });
    }

    return alerts;
  }
}
