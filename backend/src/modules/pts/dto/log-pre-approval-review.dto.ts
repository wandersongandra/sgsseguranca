import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class PtPreApprovalRulesDto {
  @IsBoolean()
  blockCriticalRiskWithoutEvidence: boolean;

  @IsBoolean()
  blockWorkerWithoutValidMedicalExam: boolean;

  @IsBoolean()
  blockWorkerWithExpiredBlockingTraining: boolean;

  @IsBoolean()
  requireAtLeastOneExecutante: boolean;
}

class PtPreApprovalWorkerStatusDto {
  @IsUUID()
  userId: string;

  @IsString()
  @MaxLength(200)
  nome: string;

  @IsString()
  @MaxLength(100)
  roleLabel: string;

  @IsBoolean()
  blocked: boolean;

  @IsOptional()
  @IsBoolean()
  unavailable?: boolean;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  reasons: string[];
}

class PtPreApprovalChecklistDto {
  @IsBoolean()
  reviewedReadiness: boolean;

  @IsBoolean()
  reviewedWorkers: boolean;

  @IsBoolean()
  confirmedRelease: boolean;
}

export class LogPreApprovalReviewDto {
  @IsIn(['preview', 'approval_requested'])
  stage: 'preview' | 'approval_requested';

  @IsBoolean()
  readyForRelease: boolean;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  blockers: string[];

  @IsInt()
  @Min(0)
  unansweredChecklistItems: number;

  @IsInt()
  @Min(0)
  adverseChecklistItems: number;

  @IsInt()
  @Min(0)
  pendingSignatures: number;

  @IsBoolean()
  hasRapidRiskBlocker: boolean;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PtPreApprovalWorkerStatusDto)
  workerStatuses: PtPreApprovalWorkerStatusDto[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  warnings: string[];

  @ValidateNested()
  @Type(() => PtPreApprovalRulesDto)
  @IsOptional()
  rules?: PtPreApprovalRulesDto;

  @ValidateNested()
  @Type(() => PtPreApprovalChecklistDto)
  @IsOptional()
  checklist?: PtPreApprovalChecklistDto;
}
