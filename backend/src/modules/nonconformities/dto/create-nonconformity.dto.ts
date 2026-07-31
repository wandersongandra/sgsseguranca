import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
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
  codigo_nc: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  tipo: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  @IsIn(['NC_MAIOR', 'NC_MENOR', 'OBSERVACAO', 'MELHORIA'])
  tipo_categoria?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  tipo_subcategoria?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  @IsIn([
    'ORGANIZACIONAL',
    'PROCESSO',
    'EQUIPAMENTO',
    'HUMANO',
    'AMBIENTE',
    'GERENCIAL',
  ])
  causa_categoria?: string;

  @IsBoolean()
  @IsOptional()
  causa_fator_humano?: boolean;

  @IsBoolean()
  @IsOptional()
  causa_fator_equipamento?: boolean;

  @IsBoolean()
  @IsOptional()
  causa_fator_processo?: boolean;

  @IsBoolean()
  @IsOptional()
  causa_fator_ambiente?: boolean;

  @IsBoolean()
  @IsOptional()
  causa_fator_gerencial?: boolean;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  @IsIn([
    'NR_4',
    'NR_5',
    'NR_6',
    'NR_7',
    'NR_10',
    'NR_11',
    'NR_12',
    'NR_15',
    'NR_17',
    'NR_18',
    'NR_20',
    'NR_21',
    'NR_22',
    'NR_23',
    'NR_24',
    'NR_25',
    'NR_26',
    'NR_28',
    'NR_30',
    'NR_31',
    'NR_32',
    'NR_33',
    'NR_34',
    'NR_35',
    'NR_36',
  ])
  requisito_nr_categoria?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  @IsIn([
    'QUEDA',
    'CHOQUE',
    'INCENDIO',
    'CORTE',
    'ESMAGAMENTO',
    'INTOXICACAO',
    'RUIDO',
    'VIBRACAO',
    'ERGONOMIA',
    'OUTRO',
  ])
  risco_categoria?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  risco_fonte?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  evidencia_descricao_foto?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  verificacao_descricao_foto?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  evidencia_foto1_key?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  evidencia_foto2_key?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  evidencia_foto3_key?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  verificacao_foto1_key?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  verificacao_foto2_key?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  verificacao_foto3_key?: string;

  @IsDateString()
  @IsNotEmpty()
  data_identificacao: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  local_setor_area: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  atividade_envolvida: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  responsavel_area: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  auditor_responsavel: string;

  @IsArray()
  @IsOptional()
  classificacao?: string[];

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  descricao: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  evidencia_observada: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  condicao_insegura: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  ato_inseguro?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  requisito_nr: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  requisito_item: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  requisito_procedimento?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  requisito_politica?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  risco_perigo: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  risco_associado: string;

  @IsArray()
  @IsOptional()
  risco_consequencias?: string[];

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsNotEmpty()
  risco_nivel: string;

  @IsArray()
  @IsOptional()
  causa?: string[];

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  causa_outro?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_imediata_descricao?: string;

  @IsDateString()
  @IsOptional()
  acao_imediata_data?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_imediata_responsavel?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_imediata_status?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_definitiva_descricao?: string;

  @IsDateString()
  @IsOptional()
  acao_definitiva_prazo?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_definitiva_responsavel?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_definitiva_recursos?: string;

  @IsDateString()
  @IsOptional()
  acao_definitiva_data_prevista?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_preventiva_medidas?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_preventiva_treinamento?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_preventiva_revisao_procedimento?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_preventiva_melhoria_processo?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  acao_preventiva_epc_epi?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  verificacao_resultado?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
  @IsOptional()
  verificacao_evidencias?: string;

  @IsDateString()
  @IsOptional()
  verificacao_data?: string;

  @IsString()
  @Trim()
  @Transform(sanitizePlainTextTransform)
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
  @IsOptional()
  observacoes_gerais?: string;

  @IsArray()
  @IsOptional()
  anexos?: string[];

  @IsString()
  @IsOptional()
  assinatura_responsavel_area?: string;

  @IsString()
  @IsOptional()
  assinatura_tecnico_auditor?: string;

  @IsString()
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
