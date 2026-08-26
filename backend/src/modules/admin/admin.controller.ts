import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Logger,
  BadRequestException,
  NotFoundException,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CacheRefreshService } from './services/cache-refresh.service';
import { GDPRDeletionService } from './services/gdpr-deletion.service';
import { RLSValidationService } from './services/rls-validation.service';
import { DatabaseHealthService } from './services/database-health.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { Authorize } from '../auth/authorize.decorator';
import { TenantOptional } from '../../shared/decorators/tenant-optional.decorator';
import {
  SensitiveAction,
  SensitiveActionGuard,
} from '../../shared/security/sensitive-action.guard';

/**
 * Admin Operations Controller
 * Endpoints para manutenção, compliance e monitoring
 *
 * SEGURANÇA: Todas as rotas exigem JWT válido + Role.SUPER_ADMIN.
 * TenantOptional é aplicado pois admin global opera cross-tenant.
 *
 * Rotas:
 * - /admin/cache/*     → Cache management
 * - /admin/gdpr/*      → GDPR/Data deletion
 * - /admin/security/*  → Security checks (RLS, audits)
 * - /admin/health/*    → Database health
 */

@Controller('admin')
@ApiTags('Admin - Operations & Compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@TenantOptional()
export class AdminController {
  private readonly logger = new Logger('AdminController');

  constructor(
    private cacheRefreshService: CacheRefreshService,
    private gdprDeletionService: GDPRDeletionService,
    private rlsValidationService: RLSValidationService,
    private databaseHealthService: DatabaseHealthService,
  ) {}

  // ============================================
  // CACHE MANAGEMENT
  // ============================================

  @Post('cache/refresh-dashboard')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Refresh dashboard metrics cache',
    description: 'Refreshes company_dashboard_metrics materialized view',
  })
  async refreshDashboard(): Promise<unknown> {
    this.logger.log('[Admin] Refresh dashboard cache requested');
    return this.cacheRefreshService.refreshDashboard();
  }

  @Post('cache/refresh-rankings')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Refresh risk rankings cache',
    description: 'Refreshes apr_risk_rankings materialized view',
  })
  async refreshRankings(): Promise<unknown> {
    this.logger.log('[Admin] Refresh risk rankings cache requested');
    return this.cacheRefreshService.refreshRiskRankings();
  }

  @Post('cache/refresh-all')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Refresh all caches',
    description: 'Refreshes all materialized views',
  })
  async refreshAllCaches(): Promise<unknown> {
    this.logger.log('[Admin] Refresh all caches requested');
    return this.cacheRefreshService.refreshAll();
  }

  @Get('cache/status')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Get cache status',
    description: 'Returns row counts and freshness of cached views',
  })
  async getCacheStatus() {
    return this.cacheRefreshService.getCacheStatus();
  }

  // ============================================
  // GDPR / DATA COMPLIANCE
  // ============================================

  @Post('gdpr/delete-user/:userId')
  @Authorize('can_manage_users')
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('admin_gdpr_delete_user')
  @ApiOperation({
    summary: 'Delete user data (GDPR right-to-be-forgotten)',
    description: 'Anonymizes all user data per GDPR request. Irreversible.',
  })
  async deleteUserData(@Param('userId', new ParseUUIDPipe()) userId: string) {
    this.logger.warn(`[Admin] GDPR deletion requested for user: ${userId}`);

    try {
      return await this.gdprDeletionService.deleteUserData(userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Admin] GDPR deletion failed: ${message}`);
      throw error;
    }
  }

  @Post('gdpr/cleanup-expired')
  @Authorize('can_manage_users')
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('admin_cleanup_expired')
  @ApiOperation({
    summary: 'Execute TTL cleanup',
    description:
      'Hard-delete data older than retention period (90d/1y/2y by table)',
  })
  async cleanupExpiredData() {
    this.logger.log('[Admin] TTL cleanup requested');
    return this.gdprDeletionService.deleteExpiredData();
  }

  @Get('gdpr/request-status/:requestId')
  @Authorize('can_manage_users')
  @ApiOperation({
    summary: 'Get GDPR deletion request status',
    description: 'Check progress of a pending GDPR deletion request',
  })
  async getGDPRStatus(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ) {
    const status =
      await this.gdprDeletionService.getDeleteRequestStatus(requestId);

    if (!status) {
      throw new NotFoundException('Request not found');
    }

    return status;
  }

  @Get('gdpr/pending-requests')
  @Authorize('can_manage_users')
  @ApiOperation({
    summary: 'List pending GDPR requests',
    description: 'Get all in-progress deletion requests',
  })
  async getPendingGDPRRequests() {
    return this.gdprDeletionService.getPendingRequests();
  }

  @Get('gdpr/retention-cleanup-runs')
  @Authorize('can_manage_users')
  @ApiOperation({
    summary: 'List retention cleanup runs',
    description:
      'Returns audit evidence for manual and scheduled LGPD TTL cleanup executions',
  })
  async getRetentionCleanupRuns(@Query('limit') limit?: string) {
    if (limit === undefined) {
      return this.gdprDeletionService.getRetentionCleanupRuns();
    }

    const parsed = Number.parseInt(limit, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }

    return this.gdprDeletionService.getRetentionCleanupRuns(parsed);
  }

  // ============================================
  // SECURITY VALIDATION (RLS)
  // ============================================

  @Get('security/validate-rls')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Validate RLS policies',
    description:
      'Check if Row Level Security is properly configured on critical tables',
  })
  async validateRLS() {
    this.logger.log('[Admin] RLS validation requested');
    return this.rlsValidationService.validateRLSPolicies();
  }

  @Post('security/test-isolation/:userCompanyId/:otherCompanyId')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Test cross-tenant isolation',
    description:
      'Verify that users cannot see other tenant data (security test)',
  })
  async testCrossTenantIsolation(
    @Param('userCompanyId', new ParseUUIDPipe()) userCompanyId: string,
    @Param('otherCompanyId', new ParseUUIDPipe()) otherCompanyId: string,
  ) {
    this.logger.log(
      `[Admin] Cross-tenant isolation test: ${userCompanyId} vs ${otherCompanyId}`,
    );
    return this.rlsValidationService.testCrossTenantIsolation(
      userCompanyId,
      otherCompanyId,
    );
  }

  @Get('security/score')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Get RLS security score',
    description:
      'Calculate RLS security compliance score (0-100) with recommendations',
  })
  async getSecurityScore() {
    this.logger.log('[Admin] Security score calculation requested');
    return this.rlsValidationService.getSecurityScore();
  }

  // ============================================
  // DATABASE HEALTH & MONITORING
  // ============================================

  @Get('health/full-check')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Full database health check',
    description:
      'Comprehensive health assessment (connections, RLS, indexes, bloat, TTL, slow queries)',
  })
  async getFullHealthCheck() {
    this.logger.log('[Admin] Full health check initiated');
    return this.databaseHealthService.getFullHealthCheck();
  }

  @Get('health/quick-status')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Quick health status (liveness probe)',
    description: 'Fast connection check - suitable for Kubernetes probes',
  })
  async getQuickStatus() {
    return this.databaseHealthService.getQuickStatus();
  }

  // ============================================
  // SUMMARY ENDPOINTS
  // ============================================

  @Get('summary/compliance')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Compliance summary',
    description: 'Combined RLS + TTL + Health status for overview',
  })
  async getComplianceSummary() {
    this.logger.log('[Admin] Compliance summary requested');

    const [rls, health, security] = await Promise.all([
      this.rlsValidationService.validateRLSPolicies(),
      this.databaseHealthService.getFullHealthCheck(),
      this.rlsValidationService.getSecurityScore(),
    ]);

    return {
      timestamp: new Date().toISOString(),
      rls_status: rls.status,
      health_status: health.status,
      security_score: security.overall_score,
      overall_compliance:
        rls.all_pass && health.overall_health_score >= 80
          ? 'compliant'
          : 'at_risk',
      detailed: { rls, health, security },
    };
  }

  @Get('summary/deployment-readiness')
  @Authorize('can_view_system_health')
  @ApiOperation({
    summary: 'Deployment readiness check',
    description:
      'Pre-deployment validation: RLS, health, indexes, policies (for stagining/prod)',
  })
  async getDeploymentReadiness() {
    this.logger.log('[Admin] Deployment readiness check requested');

    const [rls, health] = await Promise.all([
      this.rlsValidationService.validateRLSPolicies(),
      this.databaseHealthService.getFullHealthCheck(),
    ]);

    const isReady =
      rls.all_pass &&
      health.overall_health_score >= 70 &&
      health.status !== 'critical';

    return {
      is_deployment_ready: isReady,
      required_conditions: {
        rls_enabled: rls.all_pass,
        health_score_acceptable: health.overall_health_score >= 70,
        no_critical_issues: health.status !== 'critical',
      },
      rls_detail: rls,
      health_detail: health,
      recommendation: isReady
        ? 'Database is ready for deployment'
        : 'Address issues above before deploying',
      timestamp: new Date().toISOString(),
    };
  }
}
