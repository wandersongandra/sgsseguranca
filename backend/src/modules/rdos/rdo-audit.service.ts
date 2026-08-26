import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RdoAuditEvent } from './entities/rdo-audit-event.entity';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import { storageKeyFingerprint } from '../../shared/storage/storage-compensation.util';

@Injectable()
export class RdoAuditService {
  private readonly logger = new Logger(RdoAuditService.name);

  constructor(
    @InjectRepository(RdoAuditEvent)
    private auditRepository: Repository<RdoAuditEvent>,
  ) {}

  async recordEvent(
    rdoId: string,
    eventType: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const userId = RequestContext.getUserId();
      const requestId = RequestContext.getRequestId();
      const companyId = RequestContext.getCompanyId();
      const ip = RequestContext.get<string>('ip');
      const userAgent = RequestContext.get<string>('userAgent');

      const event = this.auditRepository.create({
        rdo_id: rdoId,
        event_type: eventType,
        user_id: userId || undefined,
        details: {
          requestId: requestId ?? null,
          companyId: companyId ?? null,
          ip: ip ?? null,
          userAgent: userAgent ?? null,
          ...(details || {}),
        },
      });

      await this.auditRepository.save(event);
    } catch (error) {
      this.logger.error(
        `Falha ao registrar evento de auditoria para o RDO ${rdoId} (Tipo: ${eventType})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async recordCancellation(
    rdoId: string,
    reason: string,
    previousStatus: string,
  ): Promise<void> {
    await this.recordEvent(rdoId, 'CANCELED', {
      reason,
      previousStatus,
    });
  }

  async recordStatusChange(
    rdoId: string,
    previousStatus: string,
    newStatus: string,
  ): Promise<void> {
    await this.recordEvent(rdoId, 'STATUS_CHANGED', {
      previousStatus,
      newStatus,
    });
  }

  async recordPdfGenerated(
    rdoId: string,
    fileKey: string,
    originalName: string,
  ): Promise<void> {
    await this.recordEvent(rdoId, 'PDF_GENERATED', {
      keyFingerprint: storageKeyFingerprint(fileKey),
      originalName,
    });
  }

  async recordSignature(
    rdoId: string,
    signatureType: 'responsavel' | 'engenheiro',
    signerName: string,
  ): Promise<void> {
    await this.recordEvent(rdoId, 'SIGNED', {
      signatureType,
      signerName,
    });
  }

  async getEventsForRdo(rdoId: string): Promise<RdoAuditEvent[]> {
    return this.auditRepository.find({
      where: { rdo_id: rdoId },
      order: { created_at: 'DESC' },
    });
  }
}
