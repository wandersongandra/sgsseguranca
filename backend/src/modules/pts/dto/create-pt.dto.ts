import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsUUID,
  IsArray,
  IsEnum,
  IsBoolean,
  IsInt,
  IsNumber,
  Matches,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class HeightChecklistItemDto {
  @IsString()
  id: string;

  @IsString()
  pergunta: string;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsEnum(['Sim', 'Não', 'Não aplicável'])
  resposta?: 'Sim' | 'Não' | 'Não aplicável';

  @IsOptional()
  @IsString()
  justificativa?: string;

  @IsOptional()
  @IsString()
  anexo_nome?: string;

  // Aceito para round-trip do form, mas o service sempre restaura o valor
  // persistido — o cliente não consegue forjar referências governadas.
  @IsOptional()
  @IsString()
  anexo_ref?: string;
}

export class PtAtmosphericReadingDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'hora deve estar no formato HH:mm',
  })
  hora: string;

  @IsNumber()
  @Min(0)
  @Max(25)
  oxigenio: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  inflamaveis_lel: number;

  @IsNumber()
  @Min(0)
  @Max(1000)
  co: number;

  @IsNumber()
  @Min(0)
  @Max(500)
  h2s: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  instrumento: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  responsavel: string;
}

export class RecommendationChecklistItemDto {
  @IsString()
  id: string;

  @IsString()
  pergunta: string;

  @IsOptional()
  @IsEnum(['Ciente', 'Não'])
  resposta?: 'Ciente' | 'Não';

  @IsOptional()
  @IsString()
  justificativa?: string;
}

export class RapidRiskChecklistItemDto {
  @IsString()
  id: string;

  @IsString()
  pergunta: string;

  @IsEnum(['basica', 'adicional'])
  secao: 'basica' | 'adicional';

  @IsOptional()
  @IsEnum(['Sim', 'Não'])
  resposta?: 'Sim' | 'Não';
}

export class CreatePtDto {
  @IsString()
  @IsNotEmpty()
  numero: string;

  @IsString()
  @IsNotEmpty()
  titulo: string;

  @IsString()
  @IsOptional()
  descricao?: string;

  @IsDateString()
  @IsNotEmpty()
  data_hora_inicio: string;

  @IsDateString()
  @IsNotEmpty()
  data_hora_fim: string;

  @IsString()
  @IsOptional()
  @IsEnum(['Pendente', 'Aprovada', 'Cancelada', 'Encerrada', 'Expirada'])
  status?: string;

  @IsUUID()
  @IsNotEmpty()
  site_id: string;

  @IsUUID()
  @IsOptional()
  apr_id?: string;

  @IsUUID()
  @IsNotEmpty()
  responsavel_id: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  @IsOptional()
  executantes?: string[];

  @IsBoolean()
  @IsOptional()
  trabalho_altura?: boolean;

  @IsBoolean()
  @IsOptional()
  espaco_confinado?: boolean;

  @IsBoolean()
  @IsOptional()
  trabalho_quente?: boolean;

  @IsBoolean()
  @IsOptional()
  eletricidade?: boolean;

  @IsBoolean()
  @IsOptional()
  escavacao?: boolean;

  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  probability?: number;

  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  severity?: number;

  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  exposure?: number;

  @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  @IsOptional()
  residual_risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  @IsString()
  @IsOptional()
  evidence_photo?: string;

  @IsString()
  @IsOptional()
  evidence_document?: string;

  @IsString()
  @IsOptional()
  control_description?: string;

  @IsBoolean()
  @IsOptional()
  control_evidence?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HeightChecklistItemDto)
  trabalho_altura_checklist?: HeightChecklistItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HeightChecklistItemDto)
  trabalho_eletrico_checklist?: HeightChecklistItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HeightChecklistItemDto)
  trabalho_quente_checklist?: HeightChecklistItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HeightChecklistItemDto)
  trabalho_espaco_confinado_checklist?: HeightChecklistItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HeightChecklistItemDto)
  trabalho_escavacao_checklist?: HeightChecklistItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RecommendationChecklistItemDto)
  recomendacoes_gerais_checklist?: RecommendationChecklistItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RapidRiskChecklistItemDto)
  analise_risco_rapida_checklist?: RapidRiskChecklistItemDto[];

  @IsString()
  @IsOptional()
  analise_risco_rapida_observacoes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PtAtmosphericReadingDto)
  medicoes_atmosfericas?: PtAtmosphericReadingDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  epis_obrigatorios?: string[];

  @IsString()
  @IsOptional()
  @MaxLength(200)
  contato_emergencia?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  plano_resgate?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  ponto_encontro?: string;

  @IsUUID()
  @IsOptional()
  vigia_user_id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  vigia_nome?: string;

  @IsUUID()
  @IsOptional()
  auditado_por_id?: string;

  @IsDateString()
  @IsOptional()
  data_auditoria?: string;

  @IsString()
  @IsOptional()
  resultado_auditoria?: string;

  @IsString()
  @IsOptional()
  notas_auditoria?: string;
}
