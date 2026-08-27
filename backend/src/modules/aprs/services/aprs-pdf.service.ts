import {
  BadRequestException,
  forwardRef,
  GoneException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { cleanupUploadedFile } from '../../../shared/storage/storage-compensation.util';
import { DocumentStorageService } from '../../../shared/services/document-storage.service';
import { PdfService } from '../../../shared/services/pdf.service';
import { TenantService } from '../../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../../shared/tenant/site-access-scope.util';
import { DocumentGovernanceService } from '../../document-registry/document-governance.service';
import { SignaturesService } from '../../signatures/signatures.service';
import type { Signature } from '../../signatures/entities/signature.entity';
import { PublicValidationGrantService } from '../../../shared/services/public-validation-grant.service';
import { AprLog } from '../entities/apr-log.entity';
import { AprRiskEvidence } from '../entities/apr-risk-evidence.entity';
import { Apr, AprStatus } from '../entities/apr.entity';
import { AprApprovalStepStatus } from '../entities/apr-approval-step.entity';
import {
  GovernedPdfAccessAvailability,
  GovernedPdfAccessResponseDto,
} from '../../../shared/dto/governed-pdf-access-response.dto';

const APR_PDF_LOG_ACTIONS = {
  PDF_ATTACHED: 'APR_PDF_ANEXADO',
  PDF_GENERATED: 'APR_PDF_GERADO',
} as const;

const APR_PUBLIC_VALIDATION_PORTAL = 'apr_public_validation';
const MAX_APR_LOGO_BYTES = 2 * 1024 * 1024;

type AprPdfLogAction =
  (typeof APR_PDF_LOG_ACTIONS)[keyof typeof APR_PDF_LOG_ACTIONS];

export type AprPdfAccessAvailability = GovernedPdfAccessAvailability;
type AprPdfAccessResponse = GovernedPdfAccessResponseDto;
type AprPdfAuthenticityMetadata = {
  verificationCode?: string | null;
  generatedAt?: Date | null;
  hashLabel?: string | null;
};

@Injectable()
export class AprsPdfService {
  private readonly logger = new Logger(AprsPdfService.name);

  constructor(
    @InjectRepository(Apr)
    private readonly aprsRepository: Repository<Apr>,
    @InjectRepository(AprLog)
    private readonly aprLogsRepository: Repository<AprLog>,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly pdfService: PdfService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    @Inject(forwardRef(() => SignaturesService))
    private readonly signaturesService: SignaturesService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
  ) {}

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

  private async assertAprReadyForFinalPdf(
    apr: Pick<
      Apr,
      'id' | 'status' | 'pdf_file_key' | 'is_modelo' | 'participants'
    >,
  ) {
    this.assertAprDocumentMutable(apr);

    if (this.ensureAprStatus(apr.status) !== AprStatus.APROVADA) {
      throw new BadRequestException(
        'A APR precisa estar aprovada antes do anexo do PDF final.',
      );
    }

    if (apr.is_modelo) {
      throw new BadRequestException(
        'Modelos de APR não podem receber PDF final. Gere uma APR operacional a partir do modelo.',
      );
    }

    const participantIds = Array.isArray(apr.participants)
      ? apr.participants
          .map((participant) => participant.id)
          .filter((participantId): participantId is string =>
            Boolean(participantId),
          )
      : [];

    if (participantIds.length === 0) {
      throw new BadRequestException(
        'A APR precisa ter participantes definidos antes do PDF final.',
      );
    }

    const signatures = await this.signaturesService.findByDocument(
      apr.id,
      'APR',
    );
    const participantSigners = new Set(
      signatures
        .map((signature) => signature.user_id)
        .filter(
          (userId): userId is string =>
            Boolean(userId) && participantIds.includes(userId),
        ),
    );

    const missingParticipants = participantIds.filter(
      (participantId) => !participantSigners.has(participantId),
    );

    if (missingParticipants.length > 0) {
      throw new BadRequestException(
        'Todos os participantes precisam assinar a APR antes do PDF final.',
      );
    }
  }

  private buildAprWhere(id: string): FindOptionsWhere<Apr> {
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
    return where;
  }

  private async findOne(id: string): Promise<Apr> {
    const apr = await this.aprsRepository.findOne({
      where: this.buildAprWhere(id),
      relations: [
        'company',
        'site',
        'elaborador',
        'elaborador.profile',
        'activities',
        'risks',
        'epis',
        'tools',
        'machines',
        'participants',
        'participants.profile',
        'auditado_por',
        'auditado_por.profile',
        'aprovado_por',
        'aprovado_por.profile',
        'approval_steps',
        'approval_steps.approver_user',
        'risk_items',
      ],
    });
    if (!apr) {
      throw new NotFoundException(`APR com ID ${id} não encontrada`);
    }
    return apr;
  }

  private async findOneForWrite(id: string): Promise<Apr> {
    const apr = await this.aprsRepository.findOne({
      where: this.buildAprWhere(id),
    });
    if (!apr) {
      throw new NotFoundException(`APR com ID ${id} não encontrada`);
    }
    return apr;
  }

  private buildAprDocumentCode(
    apr: Pick<Apr, 'id' | 'numero' | 'titulo' | 'data_inicio' | 'created_at'>,
  ): string {
    const candidateDate = apr.data_inicio
      ? new Date(apr.data_inicio)
      : apr.created_at
        ? new Date(apr.created_at)
        : new Date();
    const year = Number.isNaN(candidateDate.getTime())
      ? new Date().getFullYear()
      : candidateDate.getFullYear();
    const reference = String(apr.id || apr.numero || apr.titulo || 'APR')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toUpperCase();

    return `APR-${year}-${reference || String(Date.now()).slice(-6)}`;
  }

  private buildAprFinalPdfOriginalName(
    apr: Pick<Apr, 'numero' | 'versao' | 'id'>,
  ): string {
    const reference = String(apr.numero || apr.id || 'apr')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const version = Number(apr.versao ?? 1);

    return `${reference || 'apr'}_v${version}.pdf`;
  }

  private stringifyAprHtmlValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return String(value);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  private escapeHtml(value: unknown): string {
    return this.stringifyAprHtmlValue(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private resolveAprUserFunction(
    user?: {
      funcao?: string | null;
      profile?: { nome?: string | null } | null;
    } | null,
  ): string {
    const functionName = String(user?.funcao || '').trim();
    if (functionName) {
      return functionName;
    }

    const profileName = String(user?.profile?.nome || '').trim();
    return profileName || '-';
  }

  private resolveAprSignatureTypeLabel(type?: string | null): string {
    const normalized = String(type || '')
      .trim()
      .toLowerCase();
    const labels: Record<string, string> = {
      drawn: 'Assinatura desenhada',
      draw: 'Assinatura desenhada',
      digital: 'Assinatura digital',
      simple: 'Assinatura simples',
      hmac: 'Assinatura eletrônica por PIN',
      upload: 'Assinatura anexada',
      facial: 'Validação facial',
    };
    return labels[normalized] || type || '-';
  }

  private resolveAprApprovalStepStatus(status?: string | null): {
    label: string;
    tone: 'success' | 'critical' | 'neutral' | 'warning';
  } {
    switch (status) {
      case AprApprovalStepStatus.APPROVED:
        return { label: 'Aprovado', tone: 'success' };
      case AprApprovalStepStatus.REJECTED:
        return { label: 'Reprovado', tone: 'critical' };
      case AprApprovalStepStatus.SKIPPED:
        return { label: 'Ignorado', tone: 'neutral' };
      case AprApprovalStepStatus.PENDING:
      default:
        return { label: 'Pendente', tone: 'warning' };
    }
  }

  private resolveAprSignatureImageDataUrl(signatureData?: string | null) {
    const value = String(signatureData || '').trim();
    if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(value)) {
      return value;
    }
    return null;
  }

  /**
   * Materializa a logo governada antes do Chromium. O renderer não recebe
   * presigned URL: requests externas durante PDF são bloqueadas pelo
   * PdfService.
   */
  private async resolveAprCompanyLogoDataUri(
    storageKey: string,
    companyId: string,
  ): Promise<string | null> {
    const buffer = await this.documentStorageService.downloadFileBuffer(
      this.documentStorageService.referenceForExistingObject(
        storageKey,
        { resourceType: 'company', resourceId: companyId },
        'company-logo',
      ),
    );
    if (buffer.length === 0 || buffer.length > MAX_APR_LOGO_BYTES) {
      return null;
    }

    let mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | null = null;
    if (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      mimeType = 'image/png';
    } else if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      mimeType = 'image/jpeg';
    } else if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      mimeType = 'image/webp';
    }

    return mimeType
      ? `data:${mimeType};base64,${buffer.toString('base64')}`
      : null;
  }

  private buildAprSignatureProofLabel(input: {
    signature: Signature | null;
    signatureData: string | null;
  }): string {
    if (!input.signature) {
      return 'Assinatura pendente';
    }

    if (this.resolveAprSignatureImageDataUrl(input.signatureData)) {
      return 'Imagem da assinatura registrada';
    }

    if (input.signature.type === 'hmac') {
      return 'Assinatura eletrônica verificada por PIN';
    }

    return 'Assinatura registrada no SGS';
  }

  private buildAprSignatureHashLabel(signature?: Signature | null): string {
    const hash = String(signature?.signature_hash || '').trim();
    return hash ? hash.slice(0, 16) : '-';
  }

  private normalizeAprPdfNarrativeValue(
    value: unknown,
    fallback = '-',
  ): string {
    const normalized = this.stringifyAprHtmlValue(value)
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return fallback;
    }

    if (this.isLikelyAprPdfPlaceholder(normalized)) {
      return fallback;
    }

    return normalized;
  }

  private isLikelyAprPdfPlaceholder(value: string): boolean {
    const compact = value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (!compact) {
      return true;
    }

    if (
      [
        'teste',
        'test',
        'lorem',
        'lorem ipsum',
        'ipsum',
        'asdf',
        'qwer',
        'qwerty',
        'xxx',
        'abcd',
        'abc123',
        'n/a',
      ].includes(compact)
    ) {
      return true;
    }

    if (compact.length < 8 || /\s/.test(compact)) {
      return false;
    }

    if (
      /^(?:nr|ca|epi|epc|pt|apr|ltcat|pgr|pcms|aso)[-:/_\s]?[a-z0-9]+$/i.test(
        compact,
      ) ||
      /^[a-f0-9-]{16,}$/i.test(compact)
    ) {
      return false;
    }

    if (/\d/.test(compact)) {
      return true;
    }

    if (/([a-z]{2,3})\1{1,}/.test(compact) || /(.)\1{2,}/.test(compact)) {
      return true;
    }

    const lettersOnly = compact.replace(/[^a-z]/g, '');
    const vowelCount = (lettersOnly.match(/[aeiou]/g) || []).length;

    return (
      lettersOnly.length >= 8 &&
      vowelCount > 0 &&
      vowelCount / lettersOnly.length < 0.24
    );
  }

  private formatAprDisplayDate(
    value?: Date | string | null,
    fallback = '-',
  ): string {
    if (!value) {
      return fallback;
    }

    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return fallback;
    }

    return parsed.toLocaleDateString('pt-BR', {
      timeZone: 'UTC',
    });
  }

  private formatAprDisplayDateTime(
    value?: Date | string | null,
    fallback = '-',
  ): string {
    if (!value) {
      return fallback;
    }

    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return fallback;
    }

    return parsed.toLocaleString('pt-BR', {
      timeZone: 'UTC',
    });
  }

  private buildAprFooterTemplate(input: {
    documentCode: string;
    generatedAt: Date;
  }): string {
    return `
      <div style="width: 100%; font-size: 8px; color: #355070; padding: 0 12mm; box-sizing: border-box; font-family: Arial, sans-serif;">
        <div style="border-top: 1px solid #dbe7f2; padding-top: 4px; display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <span>APR · Código ${this.escapeHtml(input.documentCode)}</span>
          <span>Gerado em ${this.escapeHtml(this.formatAprDisplayDateTime(input.generatedAt, '-'))} · Pág. <span class="pageNumber"></span> de <span class="totalPages"></span></span>
        </div>
      </div>
    `;
  }

  private getAprStatusTone(status?: string | null): string {
    switch ((status || '').trim().toUpperCase()) {
      case 'APROVADA':
        return 'success';
      case 'PENDENTE':
        return 'warning';
      case 'CANCELADA':
      case 'REPROVADA':
        return 'critical';
      case 'ENCERRADA':
        return 'neutral';
      default:
        return 'neutral';
    }
  }

  private getAprRiskTone(value?: string | null): string {
    const normalized = String(value || '')
      .trim()
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (!normalized) {
      return 'neutral';
    }

    if (normalized.includes('CRITIC')) {
      return 'critical';
    }

    if (normalized.includes('SUBSTANCIAL')) {
      return 'alert';
    }

    if (normalized.includes('ATENCAO') || normalized.includes('ALERTA')) {
      return 'warning';
    }

    if (
      normalized.includes('ACEITAVEL') ||
      normalized.includes('CONCLUID') ||
      normalized.includes('VALIDAD') ||
      normalized.includes('PRONTA')
    ) {
      return 'success';
    }

    if (
      normalized.includes('OBRIGAT') ||
      normalized.includes('PENDENT') ||
      normalized.includes('ANDAMENTO') ||
      normalized.includes('INSTRUC')
    ) {
      return 'info';
    }

    return 'neutral';
  }

  private getAprActionStatusTone(value?: string | null): string {
    const normalized = String(value || '')
      .trim()
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    if (!normalized) {
      return 'neutral';
    }

    if (
      normalized.includes('BLOQUE') ||
      normalized.includes('CRITIC') ||
      normalized.includes('IMEDIATA')
    ) {
      return 'critical';
    }

    if (
      normalized.includes('CONCLUID') ||
      normalized.includes('VALIDAD') ||
      normalized.includes('PRONTA')
    ) {
      return 'info';
    }

    if (normalized.includes('ATENCAO') || normalized.includes('INCOMPLETA')) {
      return 'incomplete';
    }

    if (
      normalized.includes('OBRIGAT') ||
      normalized.includes('PENDENT') ||
      normalized.includes('ANDAMENTO') ||
      normalized.includes('AGUARDANDO')
    ) {
      return 'info';
    }

    return 'neutral';
  }

  private normalizeAprRiskItemsForPdf(apr: Apr): Array<{
    id: string;
    ordem: number;
    atividade: string | null;
    etapa: string | null;
    agente_ambiental: string | null;
    condicao_perigosa: string | null;
    fonte_circunstancia: string | null;
    lesao: string | null;
    probabilidade: number | null;
    severidade: number | null;
    score_risco: number | null;
    categoria_risco: string | null;
    prioridade: string | null;
    medidas_prevencao: string | null;
    epc: string | null;
    epi: string | null;
    permissao_trabalho: string | null;
    normas_relacionadas: string | null;
    responsavel: string | null;
    prazo: Date | string | null;
    status_acao: string | null;
    hierarquia_controle?: string | null;
    residual_probabilidade?: number | null;
    residual_severidade?: number | null;
    residual_score?: number | null;
    residual_categoria?: string | null;
  }> {
    const structuredItems = Array.isArray(apr.risk_items) ? apr.risk_items : [];
    if (structuredItems.length > 0) {
      return structuredItems
        .slice()
        .sort((left, right) => left.ordem - right.ordem)
        .map((item) => ({
          id: item.id,
          ordem: item.ordem ?? 0,
          atividade: item.atividade ?? null,
          etapa: item.etapa ?? null,
          agente_ambiental: item.agente_ambiental ?? null,
          condicao_perigosa: item.condicao_perigosa ?? null,
          fonte_circunstancia: item.fonte_circunstancia ?? null,
          lesao: item.lesao ?? null,
          probabilidade: item.probabilidade ?? null,
          severidade: item.severidade ?? null,
          score_risco: item.score_risco ?? null,
          categoria_risco: item.categoria_risco ?? null,
          prioridade: item.prioridade ?? null,
          medidas_prevencao: item.medidas_prevencao ?? null,
          epc: item.epc ?? null,
          epi: item.epi ?? null,
          permissao_trabalho: item.permissao_trabalho ?? null,
          normas_relacionadas: item.normas_relacionadas ?? null,
          responsavel: item.responsavel ?? null,
          prazo: item.prazo ?? null,
          status_acao: item.status_acao ?? null,
          hierarquia_controle: item.hierarquia_controle ?? null,
          residual_probabilidade: item.residual_probabilidade ?? null,
          residual_severidade: item.residual_severidade ?? null,
          residual_score: item.residual_score ?? null,
          residual_categoria: item.residual_categoria ?? null,
        }));
    }

    return [];
  }

  private async renderAprFinalPdfHtml(input: {
    apr: Apr;
    documentCode: string;
    signatures: Signature[];
    evidences: AprRiskEvidence[];
    isSuperseded?: boolean;
    logoDataUri?: string | null;
    authenticity?: AprPdfAuthenticityMetadata;
  }): Promise<string> {
    const {
      apr,
      documentCode,
      signatures,
      evidences,
      isSuperseded,
      logoDataUri,
      authenticity,
    } = input;
    const riskItems = this.normalizeAprRiskItemsForPdf(apr);
    const verificationCode =
      authenticity?.verificationCode ?? apr.verification_code ?? null;
    const generatedAt = authenticity?.generatedAt ?? apr.pdf_generated_at;
    const hashDisplay =
      authenticity?.hashLabel ??
      apr.final_pdf_hash_sha256 ??
      'Calculado e registrado após a emissão';
    let verificationUrl: string | null = null;
    if (verificationCode) {
      try {
        verificationUrl = await this.buildVerificationUrl({
          id: apr.id,
          company_id: apr.company_id,
          verification_code: verificationCode,
        });
      } catch (error) {
        this.logger.warn({
          event: 'apr_pdf_public_validation_url_failed',
          aprId: apr.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const signaturesWithData = await Promise.all(
      signatures.map(async (signature) => {
        const signatureData = await this.signaturesService
          .resolveSignatureData(signature)
          .catch((error) => {
            this.logger.warn({
              event: 'apr_pdf_signature_data_resolve_failed',
              aprId: apr.id,
              signatureId: signature.id,
              errorName: error instanceof Error ? error.name : 'unknown_error',
            });
            return null;
          });

        return { signature, signatureData };
      }),
    );
    const signatureEntryByUserId = new Map<
      string,
      (typeof signaturesWithData)[number]
    >();
    signaturesWithData.forEach((entry) => {
      if (
        entry.signature.user_id &&
        !signatureEntryByUserId.has(entry.signature.user_id)
      ) {
        signatureEntryByUserId.set(entry.signature.user_id, entry);
      }
    });
    const renderSignatureProofCell = (
      entry?: (typeof signaturesWithData)[number],
    ) => {
      const signature = entry?.signature ?? null;
      const signatureData = entry?.signatureData ?? null;
      const imageDataUrl = this.resolveAprSignatureImageDataUrl(signatureData);

      if (imageDataUrl) {
        return `
          <div class="signature-proof">
            <img class="signature-image" src="${this.escapeHtml(imageDataUrl)}" alt="Assinatura registrada" />
            <div>${this.escapeHtml(this.buildAprSignatureProofLabel({ signature, signatureData }))}</div>
          </div>
        `;
      }

      return `
        <div class="signature-proof">
          <strong>${this.escapeHtml(this.buildAprSignatureProofLabel({ signature, signatureData }))}</strong>
          <span>Hash: ${this.escapeHtml(this.buildAprSignatureHashLabel(signature))}</span>
          ${
            signature?.timestamp_authority
              ? `<span>Autoridade: ${this.escapeHtml(signature.timestamp_authority)}</span>`
              : ''
          }
        </div>
      `;
    };
    const participants = Array.isArray(apr.participants)
      ? apr.participants
      : [];
    const participantList = participants
      .map((participant) => participant.nome)
      .filter((name): name is string => Boolean(name));
    const participantRows = participants
      .map((participant, index) => {
        const signatureEntry = signatureEntryByUserId.get(participant.id);
        const signature = signatureEntry?.signature ?? null;
        const statusLabel = signature ? 'Assinado' : 'Pendente';
        return `
          <tr>
            <td>${this.escapeHtml(index + 1)}</td>
            <td>${this.escapeHtml(participant.nome || '-')}</td>
            <td>${this.escapeHtml(this.resolveAprUserFunction(participant))}</td>
            <td>${this.escapeHtml(participant.profile?.nome || '-')}</td>
            <td><span class="status-tag status-tag--${signature ? 'success' : 'warning'}">${this.escapeHtml(statusLabel)}</span></td>
            <td>${renderSignatureProofCell(signatureEntry)}</td>
            <td>${this.escapeHtml(this.resolveAprSignatureTypeLabel(signature?.type))}</td>
            <td>${this.escapeHtml(this.formatAprDisplayDateTime(signature?.signed_at, '-'))}</td>
          </tr>
        `;
      })
      .join('');
    const signatureRows = signaturesWithData
      .map(
        (entry) => `
          <tr>
            <td>${this.escapeHtml(entry.signature.user?.nome || entry.signature.user_id || 'Usuário')}</td>
            <td>${this.escapeHtml(this.resolveAprUserFunction(entry.signature.user))}</td>
            <td>${renderSignatureProofCell(entry)}</td>
            <td>${this.escapeHtml(this.resolveAprSignatureTypeLabel(entry.signature.type))}</td>
            <td>${this.escapeHtml(this.formatAprDisplayDateTime(entry.signature.signed_at, '-'))}</td>
            <td>${this.escapeHtml(this.buildAprSignatureHashLabel(entry.signature))}</td>
          </tr>
        `,
      )
      .join('');

    const evidenceCountByRiskItem = new Map<string, number>();
    evidences.forEach((evidence) => {
      evidenceCountByRiskItem.set(
        evidence.apr_risk_item_id,
        (evidenceCountByRiskItem.get(evidence.apr_risk_item_id) || 0) + 1,
      );
    });
    const riskItemLabelById = new Map(
      riskItems.map((item) => [
        item.id,
        this.normalizeAprPdfNarrativeValue(
          item.atividade,
          'Item de risco não identificado',
        ),
      ]),
    );
    const evidenceManifestHtml =
      evidences.length > 0
        ? `
        <section class="section-card">
          <div class="section-banner section-banner--teal">Manifesto de evidências (${this.escapeHtml(evidences.length)})</div>
          <table class="support-table">
            <thead>
              <tr>
                <th style="width:5%">#</th>
                <th style="width:18%">Item de risco</th>
                <th style="width:20%">Arquivo</th>
                <th style="width:12%">Tipo</th>
                <th style="width:10%">Tamanho</th>
                <th style="width:14%">Captura / upload</th>
                <th style="width:12%">Hash</th>
                <th>Geolocalização</th>
              </tr>
            </thead>
            <tbody>
              ${evidences
                .map(
                  (evidence, index) => `
                    <tr>
                      <td>${this.escapeHtml(index + 1)}</td>
                      <td>${this.escapeHtml(riskItemLabelById.get(evidence.apr_risk_item_id) || '-')}</td>
                      <td>
                        <strong>${this.escapeHtml(evidence.original_name || 'Evidência registrada')}</strong>
                        ${
                          evidence.watermark_text
                            ? `<div class="cell-helper">Marca d'água: ${this.escapeHtml(evidence.watermark_text)}</div>`
                            : ''
                        }
                      </td>
                      <td>${this.escapeHtml(evidence.mime_type || '-')}</td>
                      <td>${this.escapeHtml(`${evidence.file_size_bytes || 0} bytes`)}</td>
                      <td>
                        ${this.escapeHtml(this.formatAprDisplayDateTime(evidence.captured_at, '-'))}
                        <div class="cell-helper">Upload: ${this.escapeHtml(this.formatAprDisplayDateTime(evidence.uploaded_at, '-'))}</div>
                      </td>
                      <td>
                        ${this.escapeHtml(String(evidence.hash_sha256 || '').slice(0, 16) || '-')}
                        ${
                          evidence.watermarked_hash_sha256
                            ? `<div class="cell-helper">WM: ${this.escapeHtml(evidence.watermarked_hash_sha256.slice(0, 16))}</div>`
                            : ''
                        }
                      </td>
                      <td>${
                        evidence.latitude != null && evidence.longitude != null
                          ? this.escapeHtml(
                              `${evidence.latitude}, ${evidence.longitude}${
                                evidence.accuracy_m != null
                                  ? ` (${evidence.accuracy_m}m)`
                                  : ''
                              }`,
                            )
                          : '-'
                      }</td>
                    </tr>
                  `,
                )
                .join('')}
            </tbody>
          </table>
        </section>`
        : '';

    const summary = apr.classificacao_resumo || {
      total: riskItems.length,
      aceitavel: riskItems.filter((item) =>
        String(item.categoria_risco || '')
          .toLowerCase()
          .includes('aceit'),
      ).length,
      atencao: riskItems.filter((item) =>
        String(item.categoria_risco || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .includes('atencao'),
      ).length,
      substancial: riskItems.filter((item) =>
        String(item.categoria_risco || '')
          .toLowerCase()
          .includes('subst'),
      ).length,
      critico: riskItems.filter((item) =>
        String(item.categoria_risco || '')
          .toLowerCase()
          .includes('crit'),
      ).length,
    };
    const signatureCount = signatures.length;
    const totalEvidenceCount = evidences.length;
    const approvalSteps = Array.isArray(apr.approval_steps)
      ? apr.approval_steps
          .slice()
          .sort((left, right) => left.level_order - right.level_order)
      : [];
    const complementaryFields = [
      { label: 'Versão', value: apr.versao },
      {
        label: 'Criada em',
        value: this.formatAprDisplayDateTime(apr.created_at, ''),
      },
      {
        label: 'Atualizada em',
        value: this.formatAprDisplayDateTime(apr.updated_at, ''),
      },
      {
        label: 'Modelo reutilizável',
        value: apr.is_modelo ? 'Sim' : null,
      },
      {
        label: 'Modelo padrão',
        value: apr.is_modelo_padrao ? 'Sim' : null,
      },
      { label: 'APR anterior', value: apr.parent_apr_id },
      { label: 'Tipo de atividade', value: apr.tipo_atividade },
      { label: 'Frente de trabalho', value: apr.frente_trabalho },
      { label: 'Área de risco', value: apr.area_risco },
      { label: 'Turno', value: apr.turno },
      { label: 'Local detalhado', value: apr.local_execucao_detalhado },
      { label: 'Responsável técnico', value: apr.responsavel_tecnico_nome },
      {
        label: 'Registro técnico',
        value: apr.responsavel_tecnico_registro,
      },
      { label: 'Probabilidade global', value: apr.probability },
      { label: 'Severidade global', value: apr.severity },
      { label: 'Exposição global', value: apr.exposure },
      { label: 'Risco inicial', value: apr.initial_risk },
      { label: 'Risco residual', value: apr.residual_risk },
      { label: 'Descrição de controle', value: apr.control_description },
      {
        label: 'Evidência de controle',
        value:
          apr.control_evidence === true
            ? 'Sim'
            : apr.control_evidence === false
              ? 'Não'
              : null,
      },
      { label: 'Evidência fotográfica', value: apr.evidence_photo },
      { label: 'Evidência documental', value: apr.evidence_document },
      { label: 'Pontuação de conformidade', value: apr.complianceScore },
      { label: 'Reprovado por', value: apr.reprovado_por?.nome },
      {
        label: 'Data de reprovação',
        value: this.formatAprDisplayDateTime(apr.reprovado_em, ''),
      },
      { label: 'Motivo de reprovação', value: apr.reprovado_motivo },
    ].filter(
      ({ value }) =>
        value !== null && value !== undefined && String(value).trim() !== '',
    );
    const complementaryFieldsGridHtml =
      complementaryFields.length > 0
        ? complementaryFields
            .map(
              (field) => `
                <div class="kv-box">
                  <div class="kv-label">${this.escapeHtml(field.label)}</div>
                  <div class="kv-value">${this.escapeHtml(field.value)}</div>
                </div>
              `,
            )
            .join('')
        : '';

    const statusTone = this.getAprStatusTone(apr.status);

    // ── Atividades ──────────────────────────────────────────────────────────
    const activities = Array.isArray(apr.activities) ? apr.activities : [];
    const activitiesHtml =
      activities.length > 0
        ? activities
            .map(
              (a, i) => `
          <tr>
            <td style="width:28px;text-align:center;color:var(--muted)">${i + 1}</td>
            <td><strong>${this.escapeHtml(a.nome)}</strong></td>
            <td>${this.escapeHtml(a.descricao || '-')}</td>
          </tr>`,
            )
            .join('')
        : `<tr><td colspan="3" style="color:var(--muted)">Nenhuma atividade vinculada.</td></tr>`;

    // ── Riscos do catálogo ───────────────────────────────────────────────────
    const risks = Array.isArray(apr.risks) ? apr.risks : [];
    const risksHtml =
      risks.length > 0
        ? risks
            .map(
              (r, i) => `
          <tr>
            <td style="width:28px;text-align:center;color:var(--muted)">${i + 1}</td>
            <td><strong>${this.escapeHtml(r.nome)}</strong></td>
            <td>${this.escapeHtml(r.categoria)}</td>
            <td>${this.escapeHtml(r.medidas_controle || '-')}</td>
          </tr>`,
            )
            .join('')
        : `<tr><td colspan="4" style="color:var(--muted)">Nenhum risco do catálogo vinculado.</td></tr>`;

    // ── EPIs ─────────────────────────────────────────────────────────────────
    const epis = Array.isArray(apr.epis) ? apr.epis : [];
    const episHtml =
      epis.length > 0
        ? epis
            .map(
              (e, i) => `
          <tr>
            <td style="width:28px;text-align:center;color:var(--muted)">${i + 1}</td>
            <td><strong>${this.escapeHtml(e.nome)}</strong></td>
            <td>${this.escapeHtml(e.ca || '-')}</td>
            <td>${this.escapeHtml(this.formatAprDisplayDate(e.validade_ca, '-'))}</td>
            <td>${this.escapeHtml(e.descricao || '-')}</td>
          </tr>`,
            )
            .join('')
        : `<tr><td colspan="5" style="color:var(--muted)">Nenhum EPI vinculado.</td></tr>`;

    // ── Ferramentas ───────────────────────────────────────────────────────────
    const tools = Array.isArray(apr.tools) ? apr.tools : [];
    const toolsHtml =
      tools.length > 0
        ? tools
            .map(
              (t, i) => `
          <tr>
            <td style="width:28px;text-align:center;color:var(--muted)">${i + 1}</td>
            <td><strong>${this.escapeHtml(t.nome)}</strong></td>
            <td>${this.escapeHtml(t.numero_serie || '-')}</td>
            <td>${this.escapeHtml(t.descricao || '-')}</td>
          </tr>`,
            )
            .join('')
        : '';

    // ── Máquinas ─────────────────────────────────────────────────────────────
    const machines = Array.isArray(apr.machines) ? apr.machines : [];
    const machinesHtml =
      machines.length > 0
        ? machines
            .map(
              (m, i) => `
          <tr>
            <td style="width:28px;text-align:center;color:var(--muted)">${i + 1}</td>
            <td><strong>${this.escapeHtml(m.nome)}</strong></td>
            <td>${this.escapeHtml(m.placa || '-')}</td>
            <td>${this.escapeHtml(m.requisitos_seguranca || '-')}</td>
          </tr>`,
            )
            .join('')
        : '';

    const riskTableRowsHtml = riskItems.length
      ? riskItems
          .map((item) => {
            const evidenceCount = evidenceCountByRiskItem.get(item.id) || 0;
            const activityLabel = this.normalizeAprPdfNarrativeValue(
              item.atividade,
              'Atividade não informada',
            );
            const stepLabel = this.normalizeAprPdfNarrativeValue(
              item.etapa,
              '',
            );
            const environmentalAgent = this.normalizeAprPdfNarrativeValue(
              item.agente_ambiental,
              'Informação operacional não qualificada',
            );
            const hazardousCondition = this.normalizeAprPdfNarrativeValue(
              item.condicao_perigosa,
              'Informação operacional não qualificada',
            );
            const sourceOrCircumstance = this.normalizeAprPdfNarrativeValue(
              item.fonte_circunstancia,
              'Informação operacional não qualificada',
            );
            const potentialInjury = this.normalizeAprPdfNarrativeValue(
              item.lesao,
              'Informação operacional não qualificada',
            );
            const preventionLines = [
              this.normalizeAprPdfNarrativeValue(item.medidas_prevencao),
              item.score_risco != null
                ? `Score inicial: ${item.score_risco}`
                : null,
              item.prioridade ? `Prioridade: ${item.prioridade}` : null,
              item.epc ? `EPC: ${item.epc}` : null,
              item.epi ? `EPI: ${item.epi}` : null,
              item.permissao_trabalho
                ? `Permissão: ${item.permissao_trabalho}`
                : null,
              item.normas_relacionadas
                ? `NRs / normas: ${item.normas_relacionadas}`
                : null,
              item.hierarquia_controle
                ? `Hierarquia: ${item.hierarquia_controle}`
                : null,
              item.responsavel ? `Responsável: ${item.responsavel}` : null,
              item.prazo
                ? `Prazo: ${this.formatAprDisplayDate(item.prazo, '-')}`
                : null,
              item.status_acao ? `Status: ${item.status_acao}` : null,
              item.residual_probabilidade != null ||
              item.residual_severidade != null ||
              item.residual_score != null ||
              item.residual_categoria
                ? `Residual P/S/Score/Cat: ${item.residual_probabilidade ?? '-'}/${item.residual_severidade ?? '-'}/${item.residual_score ?? '-'}/${item.residual_categoria || '-'}`
                : null,
              evidenceCount > 0
                ? `Evidências: ${evidenceCount} arquivo${evidenceCount !== 1 ? 's' : ''}`
                : null,
            ].filter(Boolean);

            return `
              <tr>
                <td class="cell-activity">
                  <strong>${this.escapeHtml(activityLabel)}</strong>
                  ${stepLabel ? `<div class="cell-helper">Etapa: ${this.escapeHtml(stepLabel)}</div>` : ''}
                </td>
                <td>${this.escapeHtml(environmentalAgent)}</td>
                <td>${this.escapeHtml(hazardousCondition)}</td>
                <td>${this.escapeHtml(sourceOrCircumstance)}</td>
                <td>${this.escapeHtml(potentialInjury)}</td>
                <td class="cell-score">${this.escapeHtml(item.probabilidade ?? '-')}</td>
                <td class="cell-score">${this.escapeHtml(item.severidade ?? '-')}</td>
                <td class="risk-level risk-level--${this.escapeHtml(
                  this.getAprRiskTone(item.categoria_risco || item.prioridade),
                )}">${this.escapeHtml(item.categoria_risco || item.prioridade || '-')}</td>
                <td class="cell-prevention">${preventionLines
                  .map((line) => `<div>${this.escapeHtml(line)}</div>`)
                  .join('')}</td>
              </tr>
            `;
          })
          .join('')
      : `
          <tr>
            <td colspan="9" class="empty-state">
              Nenhum item de risco estruturado disponível.
            </td>
          </tr>
        `;

    const riskMatrixHtml = `
      <div class="matrix-layout">
        <table class="matrix-severity-table">
          <thead>
            <tr>
              <th style="width:24%"></th>
              <th style="width:15%">1</th>
              <th style="width:15%">2</th>
              <th style="width:15%">3</th>
              <th style="width:15%">4</th>
              <th style="width:16%">5</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="matrix-axis-title">Severidade</td>
              <td>Insignificante<div class="matrix-index">1</div></td>
              <td>Menor<div class="matrix-index">2</div></td>
              <td>Moderada<div class="matrix-index">3</div></td>
              <td>Grave<div class="matrix-index">4</div></td>
              <td>Catastrófica<div class="matrix-index">5</div></td>
            </tr>
          </tbody>
        </table>

        <table class="risk-matrix-table">
          <tbody>
            <tr>
              <td class="matrix-probability-title" rowspan="5">Probabilidade</td>
              <td class="matrix-row-label">1<br />Improvável</td>
              <td class="matrix-row-index">1</td>
              <td class="risk-badge risk-badge--acceptable">Aceitável</td>
              <td class="risk-badge risk-badge--acceptable">Aceitável</td>
              <td class="risk-badge risk-badge--acceptable">Aceitável</td>
              <td class="risk-badge risk-badge--acceptable">Aceitável</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
            </tr>
            <tr>
              <td class="matrix-row-label">2<br />Remota</td>
              <td class="matrix-row-index">2</td>
              <td class="risk-badge risk-badge--acceptable">Aceitável</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td class="risk-badge risk-badge--substantial">Substancial</td>
            </tr>
            <tr>
              <td class="matrix-row-label">3<br />Ocasional</td>
              <td class="matrix-row-index">3</td>
              <td class="risk-badge risk-badge--acceptable">Aceitável</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td class="risk-badge risk-badge--substantial">Substancial</td>
              <td class="risk-badge risk-badge--substantial">Substancial</td>
            </tr>
            <tr>
              <td class="matrix-row-label">4<br />Provável</td>
              <td class="matrix-row-index">4</td>
              <td class="risk-badge risk-badge--acceptable">Aceitável</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td class="risk-badge risk-badge--substantial">Substancial</td>
              <td class="risk-badge risk-badge--substantial">Substancial</td>
              <td class="risk-badge risk-badge--critical">Crítico</td>
            </tr>
            <tr>
              <td class="matrix-row-label">5<br />Frequente</td>
              <td class="matrix-row-index">5</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td class="risk-badge risk-badge--substantial">Substancial</td>
              <td class="risk-badge risk-badge--critical">Crítico</td>
              <td class="risk-badge risk-badge--critical">Crítico</td>
            </tr>
          </tbody>
        </table>

        <p class="matrix-note">
          Matriz 5×5: o cruzamento entre probabilidade e severidade orienta a priorização operacional, o bloqueio de atividades críticas e a escalada gerencial.
        </p>

        <table class="action-criteria-table">
          <tbody>
            <tr>
              <td class="risk-badge risk-badge--acceptable">Aceitável</td>
              <td><strong>NÃO PRIORITÁRIO</strong><br />Risco dentro do patamar aceitável. Manter controles vigentes, registrar e monitorar a atividade.</td>
            </tr>
            <tr>
              <td class="risk-badge risk-badge--attention">De atenção</td>
              <td><strong>PRIORIDADE BÁSICA</strong><br />Reavaliar controles, registrar justificativa de aceitação e acompanhar a execução com vigilância operacional.</td>
            </tr>
            <tr>
              <td class="risk-badge risk-badge--substantial">Substancial</td>
              <td><strong>PRIORIDADE PREFERENCIAL</strong><br />A atividade não deve iniciar ou continuar sem redução de risco e validação dos controles implementados.</td>
            </tr>
            <tr>
              <td class="risk-badge risk-badge--critical">Crítico</td>
              <td><strong>PRIORIDADE MÁXIMA</strong><br />Interromper imediatamente a atividade e escalar para gestão até que o risco seja reduzido e formalmente revalidado.</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    // ── Seção aprovação (condicional) ────────────────────────────────────────
    const approvalHtml = apr.aprovado_por
      ? `
        <section class="section-card">
          <div class="section-banner section-banner--teal">Aprovação</div>
          <div class="kv-grid kv-grid--3">
            <div class="kv-box">
              <div class="kv-label">Aprovado por</div>
              <div class="kv-value">${this.escapeHtml(apr.aprovado_por?.nome || '-')}</div>
            </div>
            <div class="kv-box">
              <div class="kv-label">Data de aprovação</div>
              <div class="kv-value">${this.escapeHtml(this.formatAprDisplayDateTime(apr.aprovado_em, '-'))}</div>
            </div>
            <div class="kv-box">
              <div class="kv-label">Resultado</div>
              <div class="kv-value"><span class="status-tag status-tag--success">Aprovada</span></div>
            </div>
          </div>
          ${apr.aprovado_motivo ? `<div class="notes-block"><div class="kv-label">Observações de aprovação</div><div class="notes-content">${this.escapeHtml(apr.aprovado_motivo)}</div></div>` : ''}
        </section>`
      : '';

    const approvalHistoryHtml =
      approvalSteps.length > 0
        ? `
          <section class="section-card">
            <div class="section-banner section-banner--teal">Histórico de aprovação</div>
            <table class="support-table">
              <thead>
                <tr>
                  <th style="width:8%">Nível</th>
                  <th style="width:28%">Etapa</th>
                  <th style="width:18%">Perfil</th>
                  <th style="width:14%">Status</th>
                  <th style="width:16%">Decisão em</th>
                  <th>Responsável</th>
                </tr>
              </thead>
              <tbody>
                ${approvalSteps
                  .map((step) => {
                    const stepStatus = this.resolveAprApprovalStepStatus(
                      step.status,
                    );
                    return `
                      <tr>
                        <td>${this.escapeHtml(step.level_order)}</td>
                        <td>${this.escapeHtml(step.title)}</td>
                        <td>${this.escapeHtml(step.approver_role)}</td>
                        <td>
                          <span class="status-tag status-tag--${stepStatus.tone}">${this.escapeHtml(stepStatus.label)}</span>
                        </td>
                        <td>${this.escapeHtml(this.formatAprDisplayDateTime(step.decided_at, '-'))}</td>
                        <td>${this.escapeHtml(step.approver_user?.nome || '-')}</td>
                      </tr>
                    `;
                  })
                  .join('')}
              </tbody>
            </table>
          </section>`
        : '';

    // ── Seção auditoria (condicional) ────────────────────────────────────────
    const hasAuditData = Boolean(
      apr.auditado_por ||
      apr.data_auditoria ||
      apr.resultado_auditoria ||
      apr.notas_auditoria,
    );
    const auditHtml = hasAuditData
      ? `
        <section class="section-card">
          <div class="section-banner section-banner--teal">Auditoria</div>
          <div class="kv-grid kv-grid--3">
            <div class="kv-box">
              <div class="kv-label">Auditado por</div>
              <div class="kv-value">${this.escapeHtml(apr.auditado_por?.nome || '-')}</div>
            </div>
            <div class="kv-box">
              <div class="kv-label">Data de auditoria</div>
              <div class="kv-value">${this.escapeHtml(this.formatAprDisplayDate(apr.data_auditoria, '-'))}</div>
            </div>
            <div class="kv-box">
              <div class="kv-label">Resultado</div>
              <div class="kv-value">
                <span class="status-tag status-tag--${apr.resultado_auditoria === 'Conforme' ? 'success' : apr.resultado_auditoria ? 'critical' : 'neutral'}">
                  ${this.escapeHtml(apr.resultado_auditoria || '-')}
                </span>
              </div>
            </div>
          </div>
          ${apr.notas_auditoria ? `<div class="notes-block"><div class="kv-label">Notas de auditoria</div><div class="notes-content">${this.escapeHtml(apr.notas_auditoria)}</div></div>` : ''}
        </section>`
      : '';

    const complianceHtml = (() => {
      if (!apr.rulesSnapshot) return '';
      const score = apr.complianceScore ?? 100;
      const snapshot = apr.rulesSnapshot as unknown as Array<{
        code?: string;
        version?: number;
        severity?: string;
        title?: string;
        operationalMessage?: string;
      }>;
      const warnings = Array.isArray(snapshot)
        ? snapshot.filter((r) => r.severity === 'ADVERTENCIA')
        : [];
      const ruleVersions =
        Array.isArray(snapshot) && snapshot.length > 0
          ? `v${snapshot[0]?.version ?? 1}`
          : 'v1';
      const warnRows =
        warnings.length > 0
          ? warnings
              .map(
                (w) =>
                  `<tr><td>${this.escapeHtml(w.title ?? w.code ?? '')}</td><td>${this.escapeHtml(w.operationalMessage ?? '')}</td></tr>`,
              )
              .join('')
          : `<tr><td colspan="2" class="empty-state">Nenhuma advertência registrada.</td></tr>`;
      return `
        <section class="section-card">
          <div class="section-banner section-banner--teal">Conformidade SST</div>
          <div class="section-body">
            <div class="kv-grid kv-grid--4">
              <div class="kv-box"><div class="kv-label">Conformidade</div><div class="kv-value">${score}/100</div></div>
            </div>
            ${
              warnings.length > 0
                ? `
            <table class="support-table" style="margin-top:8px">
              <thead><tr><th>Advertência</th><th>Orientação</th></tr></thead>
              <tbody>${warnRows}</tbody>
            </table>`
                : `<p style="margin-top:6px;font-size:9px;color:#4a6572;">Nenhuma advertência registrada no momento da aprovação.</p>`
            }
            <p style="margin-top:6px;font-size:7px;color:#7a8f9c;">Validado pelo motor de regras SST — SGS ${ruleVersions}</p>
          </div>
        </section>`;
    })();

    const authenticityHtml = `
      <section class="section-card">
        <div class="section-banner section-banner--amber">Autenticidade e rastreabilidade</div>
        <div class="section-body">
          <div class="kv-grid kv-grid--4">
            <div class="kv-box"><div class="kv-label">Código de verificação</div><div class="kv-value">${this.escapeHtml(verificationCode || '-')}</div></div>
            <div class="kv-box"><div class="kv-label">Hash SHA-256</div><div class="kv-value">${this.escapeHtml(hashDisplay)}</div></div>
            <div class="kv-box"><div class="kv-label">Gerado em</div><div class="kv-value">${this.escapeHtml(this.formatAprDisplayDateTime(generatedAt, '-'))}</div></div>
            <div class="kv-box"><div class="kv-label">Código documental</div><div class="kv-value">${this.escapeHtml(documentCode)}</div></div>
          </div>
          ${
            verificationUrl
              ? `<div class="notes-block"><div class="kv-label">Validação pública</div><div class="notes-content">${this.escapeHtml(verificationUrl)}</div></div>`
              : ''
          }
        </div>
      </section>
    `;

    return `
      <!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8" />
          <title>${this.escapeHtml(apr.titulo || apr.numero || 'APR')}</title>
          <style>
            @page {
              size: A4 landscape;
              margin: 9mm 10mm 10mm 10mm;
            }
            :root {
              color-scheme: light;
              --paper: #ffffff;
              --ink: #0f172a;
              --muted: #2a455e;
              --line: #0d3457;
              --soft-line: #9cbdd8;
              --teal: #1d5b8d;
              --teal-soft: #eaf4fb;
              --header-gray: #d7e6f3;
              --group-yellow: #fef3c7;
              --acceptable: #15803d;
              --attention: #1d5b8d;
              --substantial: #d97706;
              --critical: #b3261e;
              --neutral: #edf4fa;
              --prevention-soft: #f3f9ff;
              --row-soft: #f8fbff;
              --score-soft: #f8fbff;
              --success-soft: #e8f5e9;
              --critical-soft: #fef2f2;
            }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              background: var(--paper);
              color: var(--ink);
              font-family: Arial, Helvetica, sans-serif;
              font-size: 10px;
              line-height: 1.35;
            }
            h1, h2, h3, p { margin: 0; }
            .page { width: 100%; }
            .stack > * + * { margin-top: 8px; }
            .muted { color: var(--muted); }
            .empty-state { color: var(--muted); text-align: center; padding: 10px; }

            .tech-header {
              border: 1px solid var(--soft-line);
              border-radius: 12px;
              background: linear-gradient(180deg, #1865B0 0px, #1865B0 5px, #18517C 5px, #18517C 7px, #ffffff 7px, #ffffff 100%);
              overflow: hidden;
              box-shadow: 0 2px 6px rgba(9,30,66,0.08), 0 0 1px rgba(9,30,66,0.08);
            }
            .logo-box {
              width: 14%;
              text-align: center;
              vertical-align: middle !important;
              padding: 4px !important;
            }
            .logo-img {
              max-width: 100%;
              max-height: 42px;
              object-fit: contain;
              display: block;
              margin: 0 auto;
            }
            .doc-title-row {
              border-bottom: 1px solid var(--line);
            }
            .doc-title-table,
            .tech-table,
            .apr-risk-table,
            .support-table,
            .signature-table,
            .matrix-severity-table,
            .risk-matrix-table,
            .action-criteria-table {
              width: 100%;
              border-collapse: collapse;
              table-layout: fixed;
            }
            .doc-title-table td {
              border-right: 1px solid var(--soft-line);
              padding: 8px 10px;
              vertical-align: middle;
            }
            .doc-title-table td:last-child { border-right: 0; }
            .doc-title-main {
              text-align: center;
              font-weight: 800;
              font-size: 15px;
              letter-spacing: .05em;
              color: var(--teal);
              text-transform: uppercase;
            }
            .doc-code-box {
              width: 16%;
              font-size: 8px;
              text-align: center;
              background: linear-gradient(180deg, #eef6fd 0%, #e4f0f9 100%);
            }
            .tech-table td,
            .tech-table th,
            .apr-risk-table td,
            .apr-risk-table th,
            .support-table td,
            .support-table th,
            .signature-table td,
            .signature-table th,
            .matrix-severity-table td,
            .matrix-severity-table th,
            .risk-matrix-table td,
            .action-criteria-table td {
              border: 1px solid var(--soft-line);
              padding: 4px 6px;
              vertical-align: top;
              word-break: break-word;
            }
            .teal-cell {
              background: var(--teal);
              color: #fff;
              font-weight: 700;
              width: 13%;
            }
            .tech-value {
              background: #fdfefe;
            }
            .status-tag {
              display: inline-block;
              padding: 2px 8px;
              border: 1px solid var(--soft-line);
              border-radius: 999px;
              font-size: 8px;
              font-weight: 700;
            }
            .status-tag--success    { background: #e8f5e9; color: #166534; border-color: #a7d7b4; }
            .status-tag--critical   { background: #fef2f2; color: #991b1b; border-color: #fca5a5; }
            .status-tag--warning    { background: #fffbeb; color: #92400e; border-color: #fde68a; }
            .status-tag--alert      { background: #fff7ed; color: #9a3412; border-color: #fdba74; }
            .status-tag--info       { background: #eff6ff; color: #1e40af; border-color: #bfdbfe; }
            .status-tag--neutral    { background: #f9fafb; color: #374151; border-color: #e5e7eb; }
            .status-tag--incomplete { background: #fef9c3; color: #713f12; border-color: #fde047; }

            .metrics-grid {
              display: grid;
              grid-template-columns: repeat(7, minmax(0, 1fr));
              gap: 6px;
              margin-bottom: 2px;
            }
            .metric-card {
              border: 1px solid var(--soft-line);
              border-radius: 10px;
              background: linear-gradient(180deg, #ffffff 0%, #f4f9ff 100%);
              padding: 8px 10px;
              box-shadow: 0 1px 3px rgba(9,30,66,0.05);
            }
            .metric-bar {
              height: 4px;
              border-radius: 999px;
              margin-bottom: 7px;
              background: var(--teal);
              box-shadow: 0 1px 2px rgba(29,91,141,0.25);
            }
            .metric-card--acceptable .metric-bar { background: var(--acceptable); box-shadow: 0 1px 2px rgba(21,128,61,0.25); }
            .metric-card--attention .metric-bar { background: var(--attention); box-shadow: 0 1px 2px rgba(29,91,141,0.25); }
            .metric-card--substantial .metric-bar { background: var(--substantial); box-shadow: 0 1px 2px rgba(217,119,6,0.25); }
            .metric-card--critical .metric-bar { background: var(--critical); box-shadow: 0 1px 2px rgba(179,38,30,0.25); }
            .metric-card--info .metric-bar { background: #2563eb; }
            .metric-label {
              font-size: 7.5px;
              text-transform: uppercase;
              letter-spacing: .07em;
              color: var(--muted);
              font-weight: 700;
            }
            .metric-value {
              margin-top: 3px;
              font-size: 14px;
              font-weight: 800;
              color: var(--ink);
              line-height: 1.1;
            }

            .section-card {
              border: 1px solid var(--soft-line);
              border-radius: 12px;
              background: #fff;
              padding: 0;
              overflow: hidden;
              break-inside: avoid;
              box-shadow: 0 1px 4px rgba(9,30,66,0.06), 0 0 1px rgba(9,30,66,0.07);
            }
            .section-banner {
              padding: 7px 12px;
              font-size: 10px;
              font-weight: 700;
              border-bottom: 1px solid var(--soft-line);
              color: var(--teal);
              letter-spacing: .04em;
            }
            .section-banner--teal {
              background: linear-gradient(90deg, #ddf0fa 0%, #eef8fd 100%);
              border-left: 6px solid var(--teal);
            }
            .section-banner--amber {
              background: linear-gradient(90deg, #fef3e2 0%, #fffcf7 100%);
              border-left: 6px solid var(--substantial);
              color: var(--substantial);
            }
            .section-body {
              padding: 8px 10px 10px;
            }
            .kv-grid {
              display: grid;
              gap: 6px;
            }
            .kv-grid--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
            .kv-grid--4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
            .kv-box {
              min-height: 46px;
              border: 1px solid #dbe7f2;
              border-left: 3px solid #b0cfe8;
              padding: 7px 8px 7px 10px;
              background: linear-gradient(180deg, #ffffff 0%, #f6fbff 100%);
              border-radius: 8px;
              box-shadow: 0 1px 2px rgba(9,30,66,0.04);
            }
            .kv-label {
              font-size: 7.5px;
              text-transform: uppercase;
              letter-spacing: .07em;
              color: #355070;
              font-weight: 700;
            }
            .kv-value {
              margin-top: 4px;
              font-size: 11.5px;
              font-weight: 700;
              color: var(--ink);
            }
            .notes-block {
              margin-top: 6px;
              border-top: 1px solid #dbe7f2;
              padding: 7px 10px 9px;
              background: #fbfdff;
            }
            .notes-content {
              margin-top: 4px;
              white-space: pre-wrap;
            }

            .apr-risk-table thead th {
              text-align: center;
              font-size: 8px;
              font-weight: 700;
            }
            .apr-risk-table .group-header-teal {
              background: var(--teal);
              color: #fff;
            }
            .apr-risk-table .group-header-yellow {
              background: var(--group-yellow);
              color: var(--ink);
            }
            .apr-risk-table .sub-header {
              background: var(--header-gray);
            }
            .apr-risk-table tbody tr:nth-child(even) td {
              background: var(--row-soft);
            }
            .apr-risk-table td.cell-activity {
              width: 13%;
              background: #f7fbff;
              font-weight: 700;
            }
            .cell-helper {
              margin-top: 3px;
              font-size: 8px;
              color: var(--muted);
              font-weight: 400;
            }
            .apr-risk-table td.cell-score {
              text-align: center;
              font-weight: 700;
              background: var(--score-soft);
            }
            .apr-risk-table td.cell-prevention {
              background: var(--prevention-soft);
            }
            .apr-risk-table td.risk-level {
              text-align: center;
              font-weight: 700;
            }
            .risk-level--success { background: var(--acceptable) !important; color: #fff; }
            .risk-level--warning,
            .risk-level--info { background: var(--attention) !important; color: #fff; }
            .risk-level--alert { background: var(--substantial) !important; color: #111; }
            .risk-level--critical { background: var(--critical) !important; color: #fff; }
            .risk-level--neutral,
            .risk-level--incomplete { background: #e5e7eb !important; color: #111; }

            .support-table th {
              background: linear-gradient(180deg, #e4f0f9 0%, #edf4fa 100%);
              text-transform: uppercase;
              font-size: 8px;
              letter-spacing: .05em;
              color: var(--teal);
              font-weight: 700;
            }
            .support-table tbody tr:nth-child(even) td,
            .signature-table tbody tr:nth-child(even) td {
              background: #f8fbff;
            }
            .signature-table th {
              background: linear-gradient(180deg, #e4f0f9 0%, #edf4fa 100%);
              color: var(--teal);
              text-transform: uppercase;
              font-size: 8px;
              letter-spacing: .06em;
              font-weight: 700;
            }
            .signature-proof {
              display: flex;
              flex-direction: column;
              gap: 3px;
              font-size: 8px;
              color: var(--muted);
            }
            .signature-proof strong {
              color: var(--ink);
              font-size: 9px;
            }
            .signature-image {
              display: block;
              width: 130px;
              height: 42px;
              object-fit: contain;
              border: 1px solid #dbe7f2;
              border-radius: 6px;
              background: #fff;
              padding: 3px;
            }

            .matrix-layout > * + * { margin-top: 8px; }
            .matrix-severity-table th {
              background: #fff;
              text-align: center;
              font-size: 9px;
              font-weight: 700;
            }
            .matrix-severity-table td {
              text-align: center;
              background: #fff;
            }
            .matrix-axis-title {
              background: var(--header-gray) !important;
              font-weight: 700;
              text-transform: uppercase;
            }
            .matrix-index {
              margin-top: 6px;
              font-size: 9px;
              font-weight: 700;
            }
            .risk-matrix-table td {
              text-align: center;
              font-weight: 700;
            }
            .matrix-probability-title {
              width: 10%;
              background: var(--header-gray);
              writing-mode: vertical-rl;
              transform: rotate(180deg);
              text-transform: uppercase;
            }
            .matrix-row-label,
            .matrix-row-index {
              background: #f5f5f5;
            }
            .risk-badge {
              font-weight: 700;
              text-align: center;
            }
            .risk-badge--acceptable { background: var(--acceptable); color: #fff; }
            .risk-badge--attention { background: var(--attention); color: #fff; }
            .risk-badge--substantial { background: var(--substantial); color: #111; }
            .risk-badge--critical { background: var(--critical); color: #fff; }
            .matrix-note {
              font-size: 9px;
              color: var(--muted);
            }
            .action-criteria-table td:first-child {
              width: 19%;
              font-size: 9px;
            }

            .watermark-overlay {
              position: fixed;
              inset: 0;
              pointer-events: none;
              z-index: 9999;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .watermark-text {
              font-size: 72px;
              font-weight: 900;
              color: rgba(179, 38, 30, 0.13);
              text-transform: uppercase;
              letter-spacing: 0.12em;
              transform: rotate(-38deg);
              white-space: nowrap;
            }
            .watermark-banner {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              background: rgba(179, 38, 30, 0.85);
              color: #fff;
              font-size: 9px;
              font-weight: 900;
              text-align: center;
              padding: 4px 8px;
              letter-spacing: 0.12em;
              text-transform: uppercase;
              z-index: 10000;
            }
            .footer {
              margin-top: 8px;
              padding: 7px 4px 2px;
              border-top: 2px solid var(--soft-line);
              color: var(--muted);
              font-size: 8px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 8px;
            }
          </style>
        </head>
        <body>
          ${
            isSuperseded
              ? `
          <div class="watermark-banner">
            VERSAO SUPERSEDIDA — Existe uma versao mais recente deste documento. Consulte o sistema para a versao vigente.
          </div>
          <div class="watermark-overlay">
            <div class="watermark-text">Versão Supersedida</div>
          </div>`
              : ''
          }
          <div class="page stack" style="${isSuperseded ? 'margin-top:28px' : ''}">
            <section class="tech-header">
              <div class="doc-title-row">
                <table class="doc-title-table">
                  <tr>
                    ${
                      logoDataUri
                        ? `<td class="logo-box"><img src="${this.escapeHtml(logoDataUri)}" class="logo-img" alt="Logo" /></td>`
                        : ''
                    }
                    <td class="doc-title-main" style="width: ${logoDataUri ? '70%' : '84%'}">APR - ANÁLISE PRELIMINAR DE RISCOS</td>
                    <td class="doc-code-box">
                      <div><strong>Código</strong></div>
                      <div>${this.escapeHtml(documentCode)}</div>
                    </td>
                  </tr>
                </table>
              </div>
              <table class="tech-table">
                <tbody>
                  <tr>
                    <td class="teal-cell">Descrição da atividade:</td>
                    <td class="tech-value">${this.escapeHtml(apr.titulo || apr.descricao || '-')}</td>
                    <td class="teal-cell">Empresa:</td>
                    <td class="tech-value">${this.escapeHtml(apr.company?.razao_social || apr.company_id)}</td>
                  </tr>
                  <tr>
                    <td class="teal-cell">Data de elaboração:</td>
                    <td class="tech-value">${this.escapeHtml(this.formatAprDisplayDate(apr.created_at || apr.data_inicio, '-'))}</td>
                    <td class="teal-cell">CNPJ:</td>
                    <td class="tech-value">${this.escapeHtml(apr.company?.cnpj || '-')}</td>
                  </tr>
                  <tr>
                    <td class="teal-cell">Data revisão/ versão:</td>
                    <td class="tech-value">${this.escapeHtml(this.formatAprDisplayDate(apr.updated_at || apr.data_inicio, '-'))} / v${this.escapeHtml(apr.versao ?? 1)}</td>
                    <td class="teal-cell">Responsável:</td>
                    <td class="tech-value">${this.escapeHtml(apr.aprovado_por?.nome || apr.elaborador?.nome || apr.elaborador_id || '-')}</td>
                  </tr>
                  <tr>
                    <td class="teal-cell">Site / obra:</td>
                    <td class="tech-value">${this.escapeHtml(apr.site?.nome || apr.site_id)}</td>
                    <td class="teal-cell">Validade:</td>
                    <td class="tech-value">${this.escapeHtml(this.formatAprDisplayDate(apr.data_inicio, '-'))} a ${this.escapeHtml(this.formatAprDisplayDate(apr.data_fim, '-'))}</td>
                  </tr>
                  <tr>
                    <td class="teal-cell">Status:</td>
                    <td class="tech-value"><span class="status-tag status-tag--${this.escapeHtml(statusTone)}">${this.escapeHtml(apr.status)}</span></td>
                    <td class="teal-cell">Número APR:</td>
                    <td class="tech-value">${this.escapeHtml(apr.numero || '-')}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section class="metrics-grid">
              <article class="metric-card"><div class="metric-bar"></div><div class="metric-label">Itens avaliados</div><div class="metric-value">${this.escapeHtml(summary.total)}</div></article>
              <article class="metric-card metric-card--acceptable"><div class="metric-bar"></div><div class="metric-label">Aceitável</div><div class="metric-value">${this.escapeHtml(summary.aceitavel)}</div></article>
              <article class="metric-card metric-card--attention"><div class="metric-bar"></div><div class="metric-label">De atenção</div><div class="metric-value">${this.escapeHtml(summary.atencao)}</div></article>
              <article class="metric-card metric-card--substantial"><div class="metric-bar"></div><div class="metric-label">Substancial</div><div class="metric-value">${this.escapeHtml(summary.substancial)}</div></article>
              <article class="metric-card metric-card--critical"><div class="metric-bar"></div><div class="metric-label">Crítico</div><div class="metric-value">${this.escapeHtml(summary.critico)}</div></article>
              <article class="metric-card metric-card--info"><div class="metric-bar"></div><div class="metric-label">Assinaturas</div><div class="metric-value">${this.escapeHtml(signatureCount)}</div></article>
              <article class="metric-card"><div class="metric-bar"></div><div class="metric-label">Evidências</div><div class="metric-value">${this.escapeHtml(totalEvidenceCount)}</div></article>
            </section>

            <section class="section-card">
              <div class="section-banner section-banner--amber">Reconhecimento de Riscos</div>
              <table class="apr-risk-table">
                <thead>
                  <tr>
                    <th class="group-header-yellow" rowspan="2" style="width:13%">Atividades / Processos</th>
                    <th class="group-header-teal" colspan="4">Reconhecimento de Riscos</th>
                    <th class="group-header-yellow" colspan="3">Avaliação de Riscos</th>
                    <th class="group-header-teal" rowspan="2" style="width:21%">Medidas de Prevenção</th>
                  </tr>
                  <tr>
                    <th class="sub-header" style="width:10%">Agente Ambiental</th>
                    <th class="sub-header" style="width:12%">Condição perigosa</th>
                    <th class="sub-header" style="width:12%">Fontes ou circunstâncias</th>
                    <th class="sub-header" style="width:12%">Possíveis lesões ou agravos à saúde</th>
                    <th class="sub-header" style="width:6%">Probabilidade</th>
                    <th class="sub-header" style="width:6%">Severidade</th>
                    <th class="sub-header" style="width:8%">Categoria de Risco</th>
                  </tr>
                </thead>
                <tbody>
                  ${riskTableRowsHtml}
                </tbody>
              </table>
            </section>

            <section class="section-card">
              <div class="section-banner section-banner--teal">Identificação e contexto</div>
              <div class="section-body">
                <div class="kv-grid kv-grid--4">
                  <div class="kv-box"><div class="kv-label">Elaborador</div><div class="kv-value">${this.escapeHtml(apr.elaborador?.nome || apr.elaborador_id || '-')}</div></div>
                  <div class="kv-box"><div class="kv-label">Aprovado por</div><div class="kv-value">${this.escapeHtml(apr.aprovado_por?.nome || '-')}</div></div>
                  <div class="kv-box"><div class="kv-label">Participantes</div><div class="kv-value">${this.escapeHtml(participantList.length)}</div></div>
                  <div class="kv-box"><div class="kv-label">Período</div><div class="kv-value">${this.escapeHtml(this.formatAprDisplayDate(apr.data_inicio, '-'))} a ${this.escapeHtml(this.formatAprDisplayDate(apr.data_fim, '-'))}</div></div>
                </div>
                ${
                  apr.descricao
                    ? `<div class="notes-block"><div class="kv-label">Descrição operacional</div><div class="notes-content">${this.escapeHtml(this.normalizeAprPdfNarrativeValue(apr.descricao))}</div></div>`
                    : ''
                }
                ${
                  complementaryFieldsGridHtml
                    ? `<div class="notes-block"><div class="kv-label">Campos complementares da APR</div><div class="kv-grid kv-grid--4" style="margin-top:8px">${complementaryFieldsGridHtml}</div></div>`
                    : ''
                }
              </div>
            </section>

            <section class="section-card">
              <div class="section-banner section-banner--teal">Participantes (${this.escapeHtml(participantList.length)})</div>
              <table class="support-table">
                <thead>
                  <tr>
                    <th style="width:5%">#</th>
                    <th style="width:18%">Nome</th>
                    <th style="width:17%">Cargo / função</th>
                    <th style="width:12%">Perfil</th>
                    <th style="width:10%">Status</th>
                    <th style="width:20%">Assinatura</th>
                    <th style="width:10%">Tipo</th>
                    <th>Registrada em</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    participantList.length
                      ? participantRows
                      : `<tr><td colspan="8" class="empty-state">Nenhum participante vinculado.</td></tr>`
                  }
                </tbody>
              </table>
            </section>

            <section class="section-card">
              <div class="section-banner section-banner--teal">Atividades previstas (${this.escapeHtml(activities.length)})</div>
              <table class="support-table">
                <thead><tr><th style="width:8%">#</th><th style="width:32%">Atividade</th><th>Descrição</th></tr></thead>
                <tbody>${activitiesHtml}</tbody>
              </table>
            </section>

            <section class="section-card">
              <div class="section-banner section-banner--teal">Equipamentos de Proteção Individual — EPIs (${this.escapeHtml(epis.length)})</div>
              <table class="support-table">
                <thead><tr><th style="width:8%">#</th><th style="width:28%">EPI</th><th style="width:12%">CA</th><th style="width:14%">Validade CA</th><th>Descrição</th></tr></thead>
                <tbody>${episHtml}</tbody>
              </table>
            </section>

            ${
              tools.length > 0
                ? `
            <section class="section-card">
              <div class="section-banner section-banner--teal">Ferramentas (${this.escapeHtml(tools.length)})</div>
              <table class="support-table">
                <thead><tr><th style="width:8%">#</th><th style="width:30%">Ferramenta</th><th style="width:20%">Nº de série</th><th>Descrição</th></tr></thead>
                <tbody>${toolsHtml}</tbody>
              </table>
            </section>`
                : ''
            }

            ${
              machines.length > 0
                ? `
            <section class="section-card">
              <div class="section-banner section-banner--teal">Máquinas e equipamentos (${this.escapeHtml(machines.length)})</div>
              <table class="support-table">
                <thead><tr><th style="width:8%">#</th><th style="width:28%">Máquina</th><th style="width:18%">Placa / ID</th><th>Requisitos de segurança</th></tr></thead>
                <tbody>${machinesHtml}</tbody>
              </table>
            </section>`
                : ''
            }

            ${
              risks.length > 0
                ? `
            <section class="section-card">
              <div class="section-banner section-banner--teal">Riscos do catálogo identificados (${this.escapeHtml(risks.length)})</div>
              <table class="support-table">
                <thead><tr><th style="width:8%">#</th><th style="width:26%">Risco</th><th style="width:16%">Categoria</th><th>Medidas de controle</th></tr></thead>
                <tbody>${risksHtml}</tbody>
              </table>
            </section>`
                : ''
            }

            ${evidenceManifestHtml}

            <section class="section-card">
              <div class="section-banner section-banner--amber">Matriz de risco e critério de ação</div>
              <div class="section-body">
                ${riskMatrixHtml}
              </div>
            </section>

            ${approvalHistoryHtml}
            ${approvalHtml}
            ${auditHtml}
            ${complianceHtml}
            ${authenticityHtml}

            <section class="section-card">
              <div class="section-banner section-banner--teal">Assinaturas registradas</div>
              <table class="signature-table">
                <thead>
                  <tr>
                    <th style="width:18%">Assinante</th>
                    <th style="width:16%">Cargo / função</th>
                    <th style="width:26%">Assinatura</th>
                    <th style="width:12%">Tipo</th>
                    <th style="width:14%">Registrada em</th>
                    <th>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  ${signatureRows || `<tr><td colspan="6" class="empty-state">Nenhuma assinatura registrada.</td></tr>`}
                </tbody>
              </table>
            </section>

            <div class="footer">
              Documento técnico governado — emitido pela esteira oficial do SGS ·
              Código: ${this.escapeHtml(documentCode)} ·
              Última atualização: ${this.escapeHtml(this.formatAprDisplayDateTime(apr.updated_at, '-'))}
            </div>
          </div>
        </body>
      </html>
    `;
  }

  private async addLog(
    aprId: string,
    userId: string | undefined,
    acao: AprPdfLogAction,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const log = this.aprLogsRepository.create({
        apr_id: aprId,
        usuario_id: userId ?? undefined,
        acao,
        metadata: metadata ?? undefined,
      });
      await this.aprLogsRepository.save(log);
    } catch {
      this.logger.warn(`Falha ao gravar log de APR (${aprId}): ${acao}`);
    }
  }

  private async getPdfAccess(id: string): Promise<AprPdfAccessResponse> {
    const apr = await this.findOneForWrite(id);
    if (!apr.pdf_file_key) {
      return {
        entityId: apr.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'A APR ainda não possui PDF final emitido.',
        fileKey: null,
        folderPath: apr.pdf_folder_path ?? null,
        originalName: apr.pdf_original_name ?? null,
        url: null,
      };
    }

    let url: string | null;
    let availability: AprPdfAccessAvailability = 'ready';
    let message: string | null = null;
    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          apr.pdf_file_key,
          {
            resourceType: 'apr',
            resourceId: apr.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
        3600,
      );
    } catch {
      url = null;
      availability = 'registered_without_signed_url';
      message =
        'O PDF final está registrado, mas a URL segura não está disponível no momento.';
    }

    return {
      entityId: apr.id,
      hasFinalPdf: true,
      availability,
      message,
      fileKey: apr.pdf_file_key,
      folderPath: apr.pdf_folder_path ?? null,
      originalName: apr.pdf_original_name ?? null,
      url,
    };
  }

  async storeFinalPdfBuffer(
    apr: Apr,
    input: {
      buffer: Buffer;
      originalName: string;
      mimeType: string;
      userId?: string;
      logAction?: AprPdfLogAction;
      verificationCode?: string;
      generatedAt?: Date;
    },
  ): Promise<{ fileKey: string; folderPath: string; originalName: string }> {
    if (!apr.site_id) {
      throw new BadRequestException(
        'APR sem obra/setor vinculado não pode receber PDF final.',
      );
    }

    const key = this.documentStorageService.generateDocumentKey(
      apr.company_id,
      'aprs',
      apr.id,
      input.originalName,
      { folderSegments: ['sites', apr.site_id] },
    );
    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          key,
          { resourceType: 'apr', resourceId: apr.id },
          'p1-document-storage-uploadFile',
        ),
        input.buffer,
        input.mimeType,
      );
    const uploadedToStorage = true;
    const folder = key.split('/').slice(0, -1).join('/');
    const verificationCode =
      input.verificationCode ||
      apr.verification_code ||
      this.buildVerificationCode();
    const generatedAt = input.generatedAt || new Date();

    try {
      const registration =
        await this.documentGovernanceService.registerFinalDocument({
          companyId: apr.company_id,
          module: 'apr',
          entityId: apr.id,
          title: apr.titulo || apr.numero || 'APR',
          documentDate: apr.data_inicio || apr.created_at,
          documentCode: this.buildAprDocumentCode(apr),
          fileKey: key,
          folderPath: folder,
          originalName: input.originalName,
          mimeType: input.mimeType,
          createdBy: input.userId,
          fileBuffer: input.buffer,
          persistEntityMetadata: async (manager, computedHash) => {
            await manager.getRepository(Apr).update(
              { id: apr.id },
              {
                pdf_file_key: key,
                pdf_folder_path: folder,
                pdf_original_name: input.originalName,
                final_pdf_hash_sha256: computedHash,
                verification_code: verificationCode,
                pdf_generated_at: generatedAt,
              },
            );
          },
        });
      apr.final_pdf_hash_sha256 = registration.hash;
      apr.verification_code = verificationCode;
      apr.pdf_generated_at = generatedAt;
    } catch (error) {
      if (uploadedToStorage) {
        await cleanupUploadedFile(
          this.logger,
          `apr:${apr.id}`,
          key,
          (fileKey) =>
            uploadedReference.key === fileKey
              ? this.documentStorageService.deleteFile(uploadedReference)
              : Promise.resolve(),
        );
      }
      throw error;
    }

    await this.addLog(
      apr.id,
      input.userId,
      input.logAction ?? APR_PDF_LOG_ACTIONS.PDF_ATTACHED,
      {
        fileKey: key,
        originalName: input.originalName,
      },
    );

    return {
      fileKey: key,
      folderPath: folder,
      originalName: input.originalName,
    };
  }

  attachPdf(
    id: string,
    _file: Express.Multer.File,
    _userId?: string,
  ): Promise<{ fileKey: string; folderPath: string; originalName: string }> {
    throw new GoneException(
      `Anexo manual de PDF final descontinuado para APR ${id}. Use generateFinalPdf para emitir o PDF oficial governado a partir dos dados aprovados no banco.`,
    );
  }

  /**
   * Regenera o PDF de uma APR que acabou de ser supersedida por uma nova versão,
   * adicionando a marca d'água "VERSÃO SUPERSEDIDA". Chamado por createNewVersion.
   * É idempotente — se o APR não tiver PDF ou falhar, o erro é silenciado.
   */
  async regeneratePdfWithSupersededWatermark(
    parentAprId: string,
    userId?: string,
  ): Promise<void> {
    try {
      const apr = await this.findOneForWrite(parentAprId);
      if (!apr.pdf_file_key) {
        return;
      }
      const full = await this.findOne(parentAprId);
      const [signatures, evidences] = await Promise.all([
        this.signaturesService.findByDocument(full.id, 'APR'),
        this.aprsRepository.manager.getRepository(AprRiskEvidence).find({
          where: { apr_id: full.id },
          relations: ['apr_risk_item', 'uploaded_by', 'uploaded_by.profile'],
          order: { uploaded_at: 'DESC' },
        }),
      ]);

      // Resolve company logo if available
      let logoDataUri: string | null = null;
      if (full.company?.logo_storage_key) {
        try {
          logoDataUri = await this.resolveAprCompanyLogoDataUri(
            full.company.logo_storage_key,
            full.company_id,
          );
        } catch {
          this.logger.warn(
            `Falha ao resolver URL da logo para PDF supersedido da APR ${parentAprId}`,
          );
        }
      }

      const html = await this.renderAprFinalPdfHtml({
        apr: full,
        documentCode: this.buildAprDocumentCode(full),
        signatures,
        evidences,
        isSuperseded: true,
        logoDataUri,
      });
      const generatedAt = new Date();
      const buffer = await this.pdfService.generateFromHtml(html, {
        format: 'A4',
        landscape: true,
        preferCssPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: this.buildAprFooterTemplate({
          documentCode: this.buildAprDocumentCode(full),
          generatedAt,
        }),
        margin: {
          top: '0mm',
          right: '0mm',
          bottom: '8mm',
          left: '0mm',
        },
      });
      const originalName = this.buildAprFinalPdfOriginalName(full);
      await this.storeFinalPdfBuffer(full, {
        buffer,
        originalName,
        mimeType: 'application/pdf',
        userId,
        logAction: APR_PDF_LOG_ACTIONS.PDF_GENERATED,
      });
    } catch (err) {
      this.logger.warn(
        `Falha ao regenerar PDF com marca d'água de APR supersedida (${parentAprId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async generateFinalPdf(
    id: string,
    userId?: string,
  ): Promise<AprPdfAccessResponse & { generated: boolean }> {
    const existingAccess = await this.getPdfAccess(id);
    if (existingAccess.hasFinalPdf) {
      return {
        ...existingAccess,
        generated: false,
      };
    }

    const apr = await this.findOne(id);
    await this.assertAprReadyForFinalPdf(apr);

    const [signatures, evidences, supersedingRow] = await Promise.all([
      this.signaturesService.findByDocument(apr.id, 'APR'),
      this.aprsRepository.manager.getRepository(AprRiskEvidence).find({
        where: { apr_id: apr.id },
        relations: ['apr_risk_item', 'uploaded_by', 'uploaded_by.profile'],
        order: { uploaded_at: 'DESC' },
      }),
      this.aprsRepository.findOne({
        where: { parent_apr_id: apr.id, company_id: apr.company_id },
        select: ['id'],
      }),
    ]);

    const originalName = this.buildAprFinalPdfOriginalName(apr);
    const documentCode = this.buildAprDocumentCode(apr);
    const verificationCode =
      apr.verification_code || this.buildVerificationCode();
    const generatedAt = new Date();

    // Resolve company logo if available
    let logoDataUri: string | null = null;
    if (apr.company?.logo_storage_key) {
      try {
        logoDataUri = await this.resolveAprCompanyLogoDataUri(
          apr.company.logo_storage_key,
          apr.company_id,
        );
      } catch {
        this.logger.warn(`Falha ao resolver URL da logo para PDF da APR ${id}`);
      }
    }

    const html = await this.renderAprFinalPdfHtml({
      apr,
      documentCode,
      signatures,
      evidences,
      isSuperseded: supersedingRow != null,
      logoDataUri,
      authenticity: {
        verificationCode,
        generatedAt,
        hashLabel: 'Calculado e registrado após a emissão',
      },
    });
    const buffer = await this.pdfService.generateFromHtml(html, {
      format: 'A4',
      landscape: true,
      preferCssPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: this.buildAprFooterTemplate({
        documentCode,
        generatedAt,
      }),
      margin: {
        top: '0mm',
        right: '0mm',
        bottom: '8mm',
        left: '0mm',
      },
    });

    await this.storeFinalPdfBuffer(apr, {
      buffer,
      originalName,
      mimeType: 'application/pdf',
      userId,
      logAction: APR_PDF_LOG_ACTIONS.PDF_GENERATED,
      verificationCode,
      generatedAt,
    });

    return {
      ...(await this.getPdfAccess(id)),
      generated: true,
    };
  }

  private buildVerificationCode(): string {
    return `APR-${randomBytes(5).toString('hex').toUpperCase()}`;
  }

  private async buildVerificationUrl(
    apr: Pick<Apr, 'id' | 'company_id' | 'verification_code'>,
  ): Promise<string> {
    const code = apr.verification_code;
    if (!code) {
      throw new InternalServerErrorException(
        'APR sem código de verificação para emissão de token público.',
      );
    }

    const token = await this.publicValidationGrantService.issueToken({
      code,
      companyId: apr.company_id,
      documentId: apr.id,
      portal: APR_PUBLIC_VALIDATION_PORTAL,
    });
    const baseUrl =
      process.env.API_PUBLIC_URL ||
      process.env.BACKEND_PUBLIC_URL ||
      process.env.APP_URL ||
      '';

    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const params = new URLSearchParams({
      code,
      token,
    });
    const path = `/public/aprs/verify?${params.toString()}`;
    return normalizedBase ? `${normalizedBase}${path}` : path;
  }
}
