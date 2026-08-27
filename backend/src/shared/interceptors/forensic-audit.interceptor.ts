import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { ForensicTrailService } from '../../modules/forensic-trail/forensic-trail.service';
import {
  AUDIT_ACTION_METADATA_KEY,
  AUDIT_RESOURCE_METADATA_KEY,
  type AuditableAction,
} from '../decorators/audit-action.decorator';
import { sanitizeLogUrl } from '../logging/log-sanitizer.util';
import { getRequestIp } from '../utils/request-ip.util';

type RequestUserPayload = {
  id?: string;
  userId?: string;
  sub?: string;
  company_id?: string;
  companyId?: string;
  site_id?: string;
  siteId?: string;
  tenantId?: string;
};

type RequestLike = {
  method?: string;
  originalUrl?: string;
  url?: string;
  params?: Record<string, string | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  user?: RequestUserPayload;
};

@Injectable()
export class ForensicAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ForensicAuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    private readonly forensicTrailService?: ForensicTrailService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<'http' | 'rpc' | 'ws'>() !== 'http') {
      return next.handle();
    }

    const action = this.reflector.getAllAndOverride<AuditableAction>(
      AUDIT_ACTION_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    const resourceType = this.reflector.getAllAndOverride<string>(
      AUDIT_RESOURCE_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!action || !resourceType) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RequestLike>();

    return next.handle().pipe(
      tap((responseBody) => {
        void this.recordAuditEvent({
          request,
          responseBody,
          action,
          resourceType,
        });
      }),
    );
  }

  private async recordAuditEvent(input: {
    request: RequestLike;
    responseBody: unknown;
    action: AuditableAction;
    resourceType: string;
  }): Promise<void> {
    try {
      if (!this.forensicTrailService) {
        return;
      }
      const userId =
        input.request.user?.userId ||
        input.request.user?.id ||
        input.request.user?.sub ||
        null;
      const companyId =
        input.request.user?.company_id ||
        input.request.user?.companyId ||
        input.request.user?.tenantId ||
        this.extractHeader(input.request.headers, 'x-company-id') ||
        null;
      const resourceId =
        this.extractResourceId(input.responseBody) ||
        this.extractResourceId(input.request.params) ||
        'unknown';
      const sanitizedRoute =
        sanitizeLogUrl(
          input.request.originalUrl || input.request.url || '',
        ).split('?')[0] || null;

      await this.forensicTrailService.append({
        eventType: `AUDIT_${input.action.toUpperCase()}`,
        module: input.resourceType,
        entityId: String(resourceId),
        companyId,
        userId,
        ip: getRequestIp(input.request),
        userAgent: this.extractHeader(input.request.headers, 'user-agent'),
        metadata: {
          action: input.action,
          method: input.request.method || null,
          route: sanitizedRoute,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Falha ao registrar trilha forense automática: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private extractHeader(
    headers: Record<string, string | string[] | undefined> | undefined,
    key: string,
  ): string | null {
    if (!headers) return null;
    const raw = headers[key] ?? headers[key.toLowerCase()];
    if (Array.isArray(raw)) {
      return raw[0] || null;
    }
    return raw || null;
  }

  private extractResourceId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const candidates = [
      record.id,
      record.entityId,
      record.resourceId,
      record.aprId,
      record.userId,
      record.companyId,
      (record.data as Record<string, unknown> | undefined)?.id,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
    return null;
  }
}
