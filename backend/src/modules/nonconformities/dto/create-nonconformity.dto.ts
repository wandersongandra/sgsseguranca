import {
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ArrayMaxSize,
  ArrayUnique,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Trim } from 'class-sanitizer';
import { sanitizePlainTextTransform } from '../../../shared/utils/plain-text-sanitizer.util';
import { PartialType } from '@nestjs/mapped-types';

export class CreateNonConformityDto {
  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(80)
  codigo_nc: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(60)
  tipo: string;

  @IsDateString()
  @IsNotEmpty()
  data_identificacao: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(200)
  local_setor_area: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(200)
  atividade_envolvida: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(160)
  responsavel_area: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(160)
  auditor_responsavel: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(20)
  @MaxLength(120, { each: true })
  @IsOptional()
  classificacao?: string[];

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(10_000)
  descricao: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(10_000)
  evidencia_observada: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(10_000)
  condicao_insegura: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(10_000)
  @IsOptional()
  ato_inseguro?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(80)
  requisito_nr: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(500)
  requisito_item: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(2_000)
  @IsOptional()
  requisito_procedimento?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(2_000)
  @IsOptional()
  requisito_politica?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(1_000)
  risco_perigo: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @MaxLength(1_000)
  risco_associado: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(20)
  @MaxLength(500, { each: true })
  @IsOptional()
  risco_consequencias?: string[];

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @IsIn(['Baixo', 'Médio', 'Alto', 'Crítico'])
  risco_nivel: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(20)
  @MaxLength(500, { each: true })
  @IsOptional()
  causa?: string[];

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(2_000)
  @IsOptional()
  causa_outro?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(10_000)
  @IsOptional()
  acao_imediata_descricao?: string;

  @IsDateString()
  @IsOptional()
  acao_imediata_data?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(160)
  @IsOptional()
  acao_imediata_responsavel?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(60)
  @IsOptional()
  acao_imediata_status?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(10_000)
  @IsOptional()
  acao_definitiva_descricao?: string;

  @IsDateString()
  @IsOptional()
  acao_definitiva_prazo?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(160)
  @IsOptional()
  acao_definitiva_responsavel?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(2_000)
  @IsOptional()
  acao_definitiva_recursos?: string;

  @IsDateString()
  @IsOptional()
  acao_definitiva_data_prevista?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(10_000)
  @IsOptional()
  acao_preventiva_medidas?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(2_000)
  @IsOptional()
  acao_preventiva_treinamento?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(2_000)
  @IsOptional()
  acao_preventiva_revisao_procedimento?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(2_000)
  @IsOptional()
  acao_preventiva_melhoria_processo?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(2_000)
  @IsOptional()
  acao_preventiva_epc_epi?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsIn(['Sim', 'Parcialmente', 'Não'])
  @IsOptional()
  verificacao_resultado?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(10_000)
  @IsOptional()
  verificacao_evidencias?: string;

  @IsDateString()
  @IsOptional()
  verificacao_data?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(160)
  @IsOptional()
  verificacao_responsavel?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  @IsIn(['ABERTA', 'EM_ANDAMENTO', 'AGUARDANDO_VALIDACAO', 'ENCERRADA'])
  status: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(10_000)
  @IsOptional()
  observacoes_gerais?: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(24, { message: 'Máximo 24 anexos por não conformidade.' })
  @MaxLength(4_096, { each: true })
  @IsOptional()
  anexos?: string[];

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(160)
  @IsOptional()
  assinatura_responsavel_area?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(160)
  @IsOptional()
  assinatura_tecnico_auditor?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @MaxLength(160)
  @IsOptional()
  assinatura_gestao?: string;

  @IsUUID()
  @IsOptional()
  site_id?: string;

  @IsUUID()
  @IsOptional()
  checklist_id?: string;
}

export class UpdateNonConformityDto extends PartialType(
  CreateNonConformityDto,
) {}
