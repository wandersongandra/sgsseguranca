import { Exclude, Expose, Type, plainToInstance } from 'class-transformer';
import { Apr } from '../entities/apr.entity';

/** Projeções APR deliberadamente mínimas; DTOs genéricos carregam PII e RBAC. */
@Exclude()
class AprUserSummaryResponseDto {
  @Expose() id: string;
  @Expose() nome: string;
  @Expose() funcao?: string | null;
}

@Exclude()
class AprCompanySummaryResponseDto {
  @Expose() id: string;
  @Expose() razao_social: string;
}

@Exclude()
class AprSiteSummaryResponseDto {
  @Expose() id: string;
  @Expose() nome: string;
}

@Exclude()
class AprActivityResponseDto {
  @Expose()
  id: string;

  @Expose()
  nome: string;

  @Expose()
  descricao?: string | null;

  @Expose()
  status: boolean;

  @Expose()
  company_id: string;
}

@Exclude()
class AprRiskResponseDto {
  @Expose()
  id: string;

  @Expose()
  nome: string;

  @Expose()
  categoria: string;

  @Expose()
  descricao?: string | null;

  @Expose()
  medidas_controle?: string | null;

  @Expose()
  status: boolean;

  @Expose()
  company_id: string;
}

@Exclude()
class AprEpiResponseDto {
  @Expose()
  id: string;

  @Expose()
  nome: string;

  @Expose()
  ca?: string | null;

  @Expose()
  validade_ca?: Date | null;

  @Expose()
  descricao?: string | null;

  @Expose()
  status: boolean;

  @Expose()
  company_id: string;
}

@Exclude()
class AprToolResponseDto {
  @Expose()
  id: string;

  @Expose()
  nome: string;

  @Expose()
  numero_serie?: string | null;

  @Expose()
  descricao?: string | null;

  @Expose()
  status: boolean;

  @Expose()
  company_id: string;
}

@Exclude()
class AprMachineResponseDto {
  @Expose()
  id: string;

  @Expose()
  nome: string;

  @Expose()
  placa?: string | null;

  @Expose()
  horimetro_atual?: number;

  @Expose()
  descricao?: string | null;

  @Expose()
  requisitos_seguranca?: string | null;

  @Expose()
  status: boolean;

  @Expose()
  company_id: string;
}

@Exclude()
class AprRiskItemResponseDto {
  @Expose()
  id: string;

  @Expose()
  apr_id: string;

  // ── Atividade e etapa ────────────────────────────────────────────────────

  @Expose()
  atividade?: string | null;

  @Expose()
  etapa?: string | null;

  // ── Identificação do perigo ──────────────────────────────────────────────

  @Expose()
  agente_ambiental?: string | null;

  @Expose()
  condicao_perigosa?: string | null;

  @Expose()
  fonte_circunstancia?: string | null;

  @Expose()
  lesao?: string | null;

  // ── Risco bruto ──────────────────────────────────────────────────────────

  @Expose()
  probabilidade?: number | null;

  @Expose()
  severidade?: number | null;

  @Expose()
  score_risco?: number | null;

  @Expose()
  categoria_risco?: string | null;

  @Expose()
  prioridade?: string | null;

  // ── Controles e hierarquia ───────────────────────────────────────────────

  @Expose()
  medidas_prevencao?: string | null;

  @Expose()
  epc?: string | null;

  @Expose()
  epi?: string | null;

  @Expose()
  permissao_trabalho?: string | null;

  @Expose()
  normas_relacionadas?: string | null;

  @Expose()
  hierarquia_controle?: string | null;

  // ── Risco residual ───────────────────────────────────────────────────────

  @Expose()
  residual_probabilidade?: number | null;

  @Expose()
  residual_severidade?: number | null;

  @Expose()
  residual_score?: number | null;

  @Expose()
  residual_categoria?: string | null;

  // ── Plano de ação ────────────────────────────────────────────────────────

  @Expose()
  responsavel?: string | null;

  @Expose()
  prazo?: Date | null;

  @Expose()
  status_acao?: string | null;

  @Expose()
  ordem: number;

  @Expose()
  created_at: Date;

  @Expose()
  updated_at: Date;

  @Expose()
  deleted_at?: Date | null;
}

@Exclude()
class AprClassificationResumoResponseDto {
  @Expose()
  total: number;

  @Expose()
  aceitavel: number;

  @Expose()
  atencao: number;

  @Expose()
  substancial: number;

  @Expose()
  critico: number;
}

@Exclude()
class AprApprovalStepUserResponseDto {
  @Expose()
  id: string;

  @Expose()
  nome: string;
}

@Exclude()
class AprApprovalStepResponseDto {
  @Expose()
  id: string;

  @Expose()
  apr_id: string;

  @Expose()
  level_order: number;

  @Expose()
  title: string;

  @Expose()
  approver_role: string;

  @Expose()
  status: string;

  @Expose()
  approver_user_id?: string | null;

  @Expose()
  decision_reason?: string | null;

  @Expose()
  decided_at?: Date | null;

  @Expose()
  created_at: Date;

  @Expose()
  updated_at: Date;

  @Expose()
  @Type(() => AprApprovalStepUserResponseDto)
  approver_user?: AprApprovalStepUserResponseDto | null;
}

@Exclude()
export class AprResponseDto {
  @Expose()
  id: string;

  @Expose()
  numero: string;

  @Expose()
  titulo: string;

  @Expose()
  descricao?: string | null;

  @Expose()
  tipo_atividade?: string | null;

  @Expose()
  frente_trabalho?: string | null;

  @Expose()
  area_risco?: string | null;

  @Expose()
  turno?: string | null;

  @Expose()
  local_execucao_detalhado?: string | null;

  @Expose()
  responsavel_tecnico_nome?: string | null;

  @Expose()
  responsavel_tecnico_registro?: string | null;

  @Expose()
  data_inicio: Date;

  @Expose()
  data_fim: Date;

  @Expose()
  status: string;

  @Expose()
  is_modelo: boolean;

  @Expose()
  is_modelo_padrao: boolean;

  @Expose()
  itens_risco?: Array<Record<string, string>>;

  @Expose()
  probability?: number | null;

  @Expose()
  severity?: number | null;

  @Expose()
  exposure?: number | null;

  @Expose()
  initial_risk?: number | null;

  @Expose()
  residual_risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;

  @Expose()
  evidence_photo?: string | null;

  @Expose()
  evidence_document?: string | null;

  @Expose()
  control_description?: string | null;

  @Expose()
  control_evidence: boolean;

  @Expose()
  company_id: string;

  @Expose()
  site_id: string;

  @Expose()
  elaborador_id: string;

  @Expose()
  auditado_por_id?: string | null;

  @Expose()
  data_auditoria?: Date | null;

  @Expose()
  resultado_auditoria?: string | null;

  @Expose()
  notas_auditoria?: string | null;

  @Expose()
  has_final_pdf: boolean;

  @Expose()
  pdf_original_name?: string | null;

  @Expose()
  final_pdf_hash_sha256?: string | null;

  @Expose()
  verification_code?: string | null;

  @Expose()
  pdf_generated_at?: Date | null;

  @Expose()
  versao: number;

  @Expose()
  parent_apr_id?: string | null;

  @Expose()
  aprovado_por_id?: string | null;

  @Expose()
  aprovado_em?: Date | null;

  @Expose()
  aprovado_motivo?: string | null;

  @Expose()
  reprovado_por_id?: string | null;

  @Expose()
  reprovado_em?: Date | null;

  @Expose()
  reprovado_motivo?: string | null;

  @Expose()
  @Type(() => AprUserSummaryResponseDto)
  reprovado_por?: AprUserSummaryResponseDto;

  @Expose()
  @Type(() => AprClassificationResumoResponseDto)
  classificacao_resumo?: AprClassificationResumoResponseDto;

  @Expose()
  created_at: Date;

  @Expose()
  updated_at: Date;

  @Expose()
  @Type(() => AprCompanySummaryResponseDto)
  company?: AprCompanySummaryResponseDto;

  @Expose()
  @Type(() => AprSiteSummaryResponseDto)
  site?: AprSiteSummaryResponseDto;

  @Expose()
  @Type(() => AprUserSummaryResponseDto)
  elaborador?: AprUserSummaryResponseDto;

  @Expose()
  @Type(() => AprUserSummaryResponseDto)
  auditado_por?: AprUserSummaryResponseDto;

  @Expose()
  @Type(() => AprUserSummaryResponseDto)
  participants: AprUserSummaryResponseDto[];

  @Expose()
  @Type(() => AprActivityResponseDto)
  activities: AprActivityResponseDto[];

  @Expose()
  @Type(() => AprRiskResponseDto)
  risks: AprRiskResponseDto[];

  @Expose()
  @Type(() => AprEpiResponseDto)
  epis: AprEpiResponseDto[];

  @Expose()
  @Type(() => AprToolResponseDto)
  tools: AprToolResponseDto[];

  @Expose()
  @Type(() => AprMachineResponseDto)
  machines: AprMachineResponseDto[];

  @Expose()
  @Type(() => AprRiskItemResponseDto)
  risk_items: AprRiskItemResponseDto[];

  @Expose()
  @Type(() => AprApprovalStepResponseDto)
  approval_steps: AprApprovalStepResponseDto[];
}

export function toAprResponseDto(apr: Apr): AprResponseDto {
  const dto = plainToInstance(AprResponseDto, apr, {
    excludeExtraneousValues: true,
  });
  dto.has_final_pdf = Boolean(apr.pdf_file_key);
  return dto;
}
