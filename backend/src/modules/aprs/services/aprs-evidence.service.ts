import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import pLimit from 'p-limit';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { cleanupUploadedFile } from '../../../shared/storage/storage-compensation.util';
import {
  hashDeviceId,
  maskIpAddress,
  roundCoordinate,
} from '../../../shared/security/evidence-integrity.util';
import { DocumentStorageService } from '../../../shared/services/document-storage.service';
import { TenantService } from '../../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../../shared/tenant/site-access-scope.util';
import { AprLog } from '../entities/apr-log.entity';
import { AprRiskEvidence } from '../entities/apr-risk-evidence.entity';
import { AprRiskItem } from '../entities/apr-risk-item.entity';
import { Apr, AprStatus } from '../entities/apr.entity';

const APR_EVIDENCE_LOG_ACTION = 'APR_EVIDENCIA_ENVIADA';

type AprEvidenceResponse = {
  id: string;
  apr_id: string;
  apr_risk_item_id: string;
  uploaded_by_id?: string;
  uploaded_by_name?: string;
  file_key: string;
  original_name?: string;
  mime_type: string;
  file_size_bytes: number;
  hash_sha256: string;
  watermarked_file_key?: string;
  watermarked_hash_sha256?: string;
  watermark_text?: string;
  captured_at?: string;
  uploaded_at?: string;
  latitude?: number;
  longitude?: number;
  accuracy_m?: number;
  device_id?: string;
  ip_address?: string;
  exif_datetime?: string;
  integrity_flags?: Record<string, unknown>;
  risk_item_ordem?: number;
  url?: string;
  watermarked_url?: string;
};

@Injectable()
export class AprsEvidenceService {
  private readonly logger = new Logger(AprsEvidenceService.name);

  constructor(
    @InjectRepository(Apr)
    private readonly aprsRepository: Repository<Apr>,
    @InjectRepository(AprLog)
    private readonly aprLogsRepository: Repository<AprLog>,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
  ) {}

  // Os três normalizadores abaixo vivem em shared/security/evidence-integrity.util.ts
  // desde que o Relatório Fotográfico passou a gravar os mesmos metadados. São
  // mantidos como métodos privados delegando para o util: os call sites e
  // qualquer teste que os alcance continuam válidos, e a implementação passa a
  // ter uma fonte única.
  private maskIpAddress(ip: string | null | undefined): string | null {
    return maskIpAddress(ip);
  }

  private hashDeviceId(deviceId: string | null | undefined): string | null {
    return hashDeviceId(deviceId);
  }

  private roundCoordinate(value: number | null | undefined): number | null {
    return roundCoordinate(value);
  }

  private ensureAprStatus(status: string): AprStatus {
    const knownStatuses = Object.values(AprStatus);
    if (knownStatuses.includes(status as AprStatus)) {
      return status as AprStatus;
    }

    throw new BadRequestException(`Status de APR inválido: ${status}`);
  }

  private assertAprDocumentMutable(apr: Pick<Apr, 'pdf_file_key'>) {
    if (apr.pdf_file_key) {
      throw new BadRequestException(
        'APR assinada anexada. Edição bloqueada. Crie uma nova versão para alterar.',
      );
    }
  }

  private assertAprEditableStatus(status: string) {
    if (this.ensureAprStatus(status) !== AprStatus.PENDENTE) {
      throw new BadRequestException(
        'Somente APRs pendentes podem ser editadas pelo formulário. Use os fluxos formais de aprovação, cancelamento, encerramento ou nova versão.',
      );
    }
  }

  private assertAprFormMutable(
    apr: Pick<Apr, 'status' | 'pdf_file_key'>,
  ): void {
    this.assertAprDocumentMutable(apr);
    this.assertAprEditableStatus(apr.status);
  }

  private async findOneForWrite(id: string): Promise<Apr> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'APR',
    );
    const where: FindOptionsWhere<Apr> = {
      id,
      company_id: scope.companyId,
    };
    if (!scope.hasCompanyWideAccess) {
      where.site_id = In(scope.siteIds);
    }
    const apr = await this.aprsRepository.findOne({
      where,
      relations: ['participants'],
    });
    if (!apr) {
      throw new NotFoundException(`APR com ID ${id} não encontrada`);
    }
    return apr;
  }

  private assertEvidenceUploadAllowed(apr: Apr, userId?: string): void {
    if (!userId) {
      return; // chamadas internas sem userId (ex: import batch) são permitidas
    }
    const isElaborador = apr.elaborador_id === userId;
    const isParticipant = Array.isArray(apr.participants)
      ? apr.participants.some((p) => p.id === userId)
      : false;
    if (!isElaborador && !isParticipant) {
      throw new ForbiddenException(
        'Somente o elaborador ou um participante da APR pode enviar evidências.',
      );
    }
  }

  private async addLog(
    aprId: string,
    userId: string | undefined,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const log = this.aprLogsRepository.create({
        apr_id: aprId,
        usuario_id: userId ?? undefined,
        acao: APR_EVIDENCE_LOG_ACTION,
        metadata: metadata ?? undefined,
      });
      await this.aprLogsRepository.save(log);
    } catch {
      this.logger.warn(
        `Falha ao gravar log de evidência de APR (${aprId}) em ${APR_EVIDENCE_LOG_ACTION}`,
      );
    }
  }

  async uploadRiskEvidence(
    aprId: string,
    riskItemId: string,
    file: Express.Multer.File,
    metadata: {
      captured_at?: string;
      latitude?: number;
      longitude?: number;
      accuracy_m?: number;
      device_id?: string;
      exif_datetime?: string;
    },
    userId?: string,
    ipAddress?: string,
  ): Promise<{
    id: string;
    fileKey: string;
    originalName: string;
    hashSha256: string;
  }> {
    const apr = await this.findOneForWrite(aprId);
    this.assertAprFormMutable(apr);
    this.assertEvidenceUploadAllowed(apr, userId);

    const riskItem = await this.aprsRepository.manager
      .getRepository(AprRiskItem)
      .findOne({
        where: {
          id: riskItemId,
          apr_id: aprId,
        },
      });

    if (!riskItem) {
      throw new NotFoundException(
        `Item de risco ${riskItemId} não encontrado para a APR ${aprId}.`,
      );
    }

    const parseOptionalDate = (value?: string): Date | null => {
      if (!value?.trim()) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };

    const originalName =
      file.originalname?.trim() || `apr-evidence-${Date.now()}.jpg`;
    const fileKey = this.documentStorageService.generateDocumentKey(
      apr.company_id,
      'apr-evidences',
      apr.id,
      originalName,
    );
    const hashSha256 = createHash('sha256').update(file.buffer).digest('hex');
    const evidenceId = randomUUID();

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.createReference({
          tenantId: apr.company_id,
          key: fileKey,
          owner: { resourceType: 'apr-evidence', resourceId: evidenceId },
          purpose: 'apr-evidence',
        }),
        file.buffer,
        file.mimetype,
      );

    try {
      const evidenceRepository =
        this.aprsRepository.manager.getRepository(AprRiskEvidence);
      const evidence = evidenceRepository.create({
        id: evidenceId,
        apr_id: apr.id,
        apr_risk_item_id: riskItem.id,
        uploaded_by_id: userId ?? null,
        file_key: fileKey,
        original_name: originalName,
        mime_type: file.mimetype,
        file_size_bytes: file.size || file.buffer.length,
        hash_sha256: hashSha256,
        watermarked_file_key: null,
        watermarked_hash_sha256: null,
        watermark_text: null,
        captured_at: parseOptionalDate(metadata.captured_at),
        latitude: this.roundCoordinate(metadata.latitude),
        longitude: this.roundCoordinate(metadata.longitude),
        accuracy_m:
          typeof metadata.accuracy_m === 'number' ? metadata.accuracy_m : null,
        device_id: this.hashDeviceId(metadata.device_id),
        ip_address: this.maskIpAddress(ipAddress),
        exif_datetime: parseOptionalDate(metadata.exif_datetime),
        integrity_flags: {
          gps:
            typeof metadata.latitude === 'number' &&
            typeof metadata.longitude === 'number',
          accuracy:
            typeof metadata.accuracy_m === 'number' &&
            Number.isFinite(metadata.accuracy_m),
          device: Boolean(metadata.device_id),
          ip: Boolean(ipAddress),
          exif: Boolean(metadata.exif_datetime),
        },
      });

      const saved = await evidenceRepository.save(evidence);
      await this.addLog(apr.id, userId, {
        evidenceId: saved.id,
        riskItemId: riskItem.id,
        fileKey,
        hashSha256,
      });

      return {
        id: saved.id,
        fileKey,
        originalName,
        hashSha256,
      };
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `apr-evidence:${apr.id}`,
        fileKey,
        (key) =>
          key === uploadedReference.key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }
  }

  async verifyEvidenceByHashPublic(hash: string): Promise<{
    verified: boolean;
    matchedIn?: 'original' | 'watermarked';
    message?: string;
  }> {
    const normalizedHash = String(hash || '')
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
      return {
        verified: false,
        message: 'Hash SHA-256 inválido.',
      };
    }

    // Rota pública sem contexto de tenant — RLS bloquearia todas as linhas.
    // Executamos a query como super-admin (is_super_admin() = true), que é
    // permitido pela policy RESTRICTIVE de apr_risk_evidences (migration 079).
    // O retorno é mínimo (verified + matchedIn) — sem metadados sensíveis.
    const evidence = await this.tenantService.run(
      { companyId: undefined, isSuperAdmin: true, siteScope: 'all' },
      () =>
        this.aprsRepository.manager.getRepository(AprRiskEvidence).findOne({
          where: [
            { hash_sha256: normalizedHash },
            { watermarked_hash_sha256: normalizedHash },
          ],
          select: ['id', 'hash_sha256', 'watermarked_hash_sha256'],
        }),
    );

    if (!evidence) {
      return {
        verified: false,
        message: 'Hash não localizado na base de evidências da APR.',
      };
    }

    return {
      verified: true,
      matchedIn:
        evidence.hash_sha256 === normalizedHash ? 'original' : 'watermarked',
    };
  }

  async listAprEvidences(id: string): Promise<AprEvidenceResponse[]> {
    await this.findOneForWrite(id);

    const evidences = await this.aprsRepository.manager
      .getRepository(AprRiskEvidence)
      .find({
        where: { apr_id: id },
        relations: ['apr_risk_item', 'uploaded_by'],
        order: { uploaded_at: 'DESC' },
      });

    // Estratégia adotada: manter URLs assinadas de curta duração para preservar
    // governança documental e reduzir exposição de artefatos, com concorrência
    // limitada para evitar N+1 agressivo em chamadas ao storage.
    const limit = pLimit(5);
    const signedUrlByEvidenceId = new Map<
      string,
      { url?: string; watermarkedUrl?: string }
    >();

    await Promise.all(
      evidences.map((evidence) =>
        limit(async () => {
          let url: string | undefined;
          let watermarkedUrl: string | undefined;

          try {
            url = await this.documentStorageService.getSignedUrl(
              this.documentStorageService.referenceForExistingObject(
                evidence.file_key,
                {
                  resourceType: 'apr-evidence',
                  resourceId: evidence.id,
                },
                'p1-document-storage-getSignedUrl',
              ),
              3600,
            );
          } catch {
            url = undefined;
          }

          if (evidence.watermarked_file_key) {
            try {
              watermarkedUrl = await this.documentStorageService.getSignedUrl(
                this.documentStorageService.referenceForExistingObject(
                  evidence.watermarked_file_key,
                  {
                    resourceType: 'apr-evidence-watermarked',
                    resourceId: evidence.id,
                  },
                  'p1-document-storage-getSignedUrl',
                ),
                3600,
              );
            } catch {
              watermarkedUrl = undefined;
            }
          }

          signedUrlByEvidenceId.set(evidence.id, { url, watermarkedUrl });
        }),
      ),
    );

    return evidences.map((evidence) => {
      const urls = signedUrlByEvidenceId.get(evidence.id);
      return {
        id: evidence.id,
        apr_id: evidence.apr_id,
        apr_risk_item_id: evidence.apr_risk_item_id,
        uploaded_by_id: evidence.uploaded_by_id ?? undefined,
        uploaded_by_name: evidence.uploaded_by?.nome ?? undefined,
        file_key: evidence.file_key,
        original_name: evidence.original_name ?? undefined,
        mime_type: evidence.mime_type,
        file_size_bytes: evidence.file_size_bytes,
        hash_sha256: evidence.hash_sha256,
        watermarked_file_key: evidence.watermarked_file_key ?? undefined,
        watermarked_hash_sha256: evidence.watermarked_hash_sha256 ?? undefined,
        watermark_text: evidence.watermark_text ?? undefined,
        captured_at: evidence.captured_at?.toISOString(),
        uploaded_at: evidence.uploaded_at?.toISOString(),
        latitude:
          evidence.latitude !== null && evidence.latitude !== undefined
            ? Number(evidence.latitude)
            : undefined,
        longitude:
          evidence.longitude !== null && evidence.longitude !== undefined
            ? Number(evidence.longitude)
            : undefined,
        accuracy_m:
          evidence.accuracy_m !== null && evidence.accuracy_m !== undefined
            ? Number(evidence.accuracy_m)
            : undefined,
        device_id: evidence.device_id ?? undefined,
        ip_address: evidence.ip_address ?? undefined,
        exif_datetime: evidence.exif_datetime?.toISOString(),
        integrity_flags: evidence.integrity_flags ?? undefined,
        risk_item_ordem: evidence.apr_risk_item?.ordem ?? undefined,
        url: urls?.url,
        watermarked_url: urls?.watermarkedUrl,
      };
    });
  }
}
