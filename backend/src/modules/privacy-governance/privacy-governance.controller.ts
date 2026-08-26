import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/decorators/public.decorator';
import { TenantOptional } from '../../shared/decorators/tenant-optional.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Role } from '../auth/enums/roles.enum';
import {
  PrivacyGovernanceService,
  SubprocessorRegistryResponse,
  RetentionMatrixResponse,
  TenantOffboardingChecklistResponse,
} from './privacy-governance.service';

@Controller('privacy-governance')
@ApiTags('Privacy Governance')
export class PrivacyGovernanceController {
  constructor(
    private readonly privacyGovernanceService: PrivacyGovernanceService,
  ) {}

  // Transparência pública: lista subprocessadores de dados (LGPD art. 37)
  @Public()
  @TenantOptional()
  @Get('subprocessors')
  @ApiOperation({
    summary: 'Public technical subprocessor registry',
    description:
      'Lists providers that may process personal data and flags missing contractual evidence.',
  })
  getSubprocessors(): SubprocessorRegistryResponse {
    return this.privacyGovernanceService.getSubprocessors();
  }

  // Transparência pública: matriz de retenção de dados (LGPD art. 37)
  @Public()
  @TenantOptional()
  @Get('retention-matrix')
  @ApiOperation({
    summary: 'Technical privacy retention matrix',
    description:
      'Maps data domains to retention, deletion mode, source of truth, and missing evidence.',
  })
  getRetentionMatrix(): RetentionMatrixResponse {
    return this.privacyGovernanceService.getRetentionMatrix();
  }

  // Operacional de plataforma: requer SUPER_ADMIN explícito (offboarding de tenant).
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @Get('tenant-offboarding-checklist')
  @ApiOperation({
    summary: 'Tenant offboarding privacy checklist',
    description:
      'Lists operational steps and evidence required to close or delete a tenant safely.',
  })
  getTenantOffboardingChecklist(): TenantOffboardingChecklistResponse {
    return this.privacyGovernanceService.getTenantOffboardingChecklist();
  }
}
