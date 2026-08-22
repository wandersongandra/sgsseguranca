import { IsBoolean, IsOptional } from 'class-validator';

export class UpdatePtApprovalRulesDto {
  @IsBoolean()
  @IsOptional()
  blockCriticalRiskWithoutEvidence?: boolean;

  // NOTE: blockWorkerWithoutValidMedicalExam is intentionally absent — the
  // service normalizes it to false; accepting it in the DTO would return 200
  // while silently discarding the value.

  @IsBoolean()
  @IsOptional()
  blockWorkerWithExpiredBlockingTraining?: boolean;

  @IsBoolean()
  @IsOptional()
  requireAtLeastOneExecutante?: boolean;

  // SGS-PT-BR-003: NR-33 compliance rules — previously unreachable via API
  @IsBoolean()
  @IsOptional()
  blockConfinedSpaceWithoutAtmosphericReadings?: boolean;

  @IsBoolean()
  @IsOptional()
  blockConfinedSpaceWithoutWatch?: boolean;

  @IsBoolean()
  @IsOptional()
  blockConfinedSpaceWithoutRescuePlan?: boolean;

  @IsBoolean()
  @IsOptional()
  blockWithoutBeforeEvidence?: boolean;
}
