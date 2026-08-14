import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Regras de bloqueio de aprovação da PT, com escopo de EMPRESA.
 *
 * IMPORTANTE: este DTO é o único caminho de escrita de `companies.pt_approval_rules`.
 * Como a rota usa `whitelist` + `forbidNonWhitelisted`, toda regra AUSENTE deste
 * DTO fica permanentemente presa no default do serviço — sem qualquer forma de
 * ser ligada pela API. Foi exatamente o que aconteceu com as quatro regras de
 * NR-33 e de evidência prévia, cujo código em `assertCanApprove` era, na prática,
 * inalcançável em produção.
 *
 * Ao adicionar uma regra nova em `PtsService.defaultApprovalRules`, adicione-a
 * TAMBÉM aqui — o teste `pts.service.spec` garante que os dois conjuntos batem.
 */
export class UpdatePtApprovalRulesDto {
  @IsBoolean()
  @IsOptional()
  blockCriticalRiskWithoutEvidence?: boolean;

  @IsBoolean()
  @IsOptional()
  blockWorkerWithoutValidMedicalExam?: boolean;

  @IsBoolean()
  @IsOptional()
  blockWorkerWithExpiredBlockingTraining?: boolean;

  @IsBoolean()
  @IsOptional()
  requireAtLeastOneExecutante?: boolean;

  /** NR-33 — espaço confinado sem leitura atmosférica registrada. */
  @IsBoolean()
  @IsOptional()
  blockConfinedSpaceWithoutAtmosphericReadings?: boolean;

  /** NR-33 — espaço confinado sem vigia designado. */
  @IsBoolean()
  @IsOptional()
  blockConfinedSpaceWithoutWatch?: boolean;

  /** NR-33 — espaço confinado sem plano de resgate e contato de emergência. */
  @IsBoolean()
  @IsOptional()
  blockConfinedSpaceWithoutRescuePlan?: boolean;

  /** Exige evidência fotográfica "antes" registrada para liberar a aprovação. */
  @IsBoolean()
  @IsOptional()
  blockWithoutBeforeEvidence?: boolean;
}
