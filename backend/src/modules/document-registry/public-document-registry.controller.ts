import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Public } from '../../shared/decorators/public.decorator';
import { TenantOptional } from '../../shared/decorators/tenant-optional.decorator';
import { DocumentRegistryService } from './document-registry.service';
import { Throttle } from '@nestjs/throttler';
import { PublicValidationQueryDto } from '../../shared/dto/public-validation-query.dto';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import { assertValidSignedToken } from '../../shared/security/signed-token.util';

const DOCUMENT_REGISTRY_VALIDATION_PORTALS = [
  'document_public_validation',
  'dds_public_validation',
  'cat_public_validation',
  'checklist_public_validation',
  'dossier_public_validation',
  'pt_public_validation',
  'did_public_validation',
  'arr_public_validation',
  'rdo_public_validation',
  'nonconformity_public_validation',
  'audit_public_validation',
  'training_public_validation',
  // `report_public_validation` pertence ao módulo `report` (relatórios
  // gerenciais). O Relatório Fotográfico é outro módulo e precisa do seu
  // próprio portal — reusar aquele faria o token de um valer no outro.
  'report_public_validation',
  'photographic_report_public_validation',
];

@Controller('public/documents')
export class PublicDocumentRegistryController {
  constructor(
    private readonly documentRegistryService: DocumentRegistryService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
  ) {}

  @Get('validate')
  @Public()
  @TenantOptional()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async validateByCode(@Query() query: PublicValidationQueryDto) {
    const { code, token } = query;
    if (!code || !code.trim()) {
      throw new BadRequestException('Código ausente.');
    }

    const normalizedCode = code.trim().toUpperCase();
    if (!token || !token.trim()) {
      throw new BadRequestException('Token de validação ausente.');
    }
    const normalizedToken = assertValidSignedToken(
      token,
      'Token de validação inválido.',
    );

    try {
      const payload = await this.publicValidationGrantService.assertActiveToken(
        normalizedToken,
        normalizedCode,
        DOCUMENT_REGISTRY_VALIDATION_PORTALS,
      );

      return this.documentRegistryService.validatePublicCode({
        code: normalizedCode,
        companyId: payload.companyId,
      });
    } catch {
      return {
        valid: false,
        code: normalizedCode,
        message: 'Código inválido ou expirado.',
      };
    }
  }
}
