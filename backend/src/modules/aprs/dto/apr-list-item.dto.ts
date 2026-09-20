import { Exclude, Expose, Transform, Type } from 'class-transformer';

@Exclude()
class AprListItemCompanyDto {
  @Expose()
  id: string;

  @Expose()
  razao_social: string;
}

@Exclude()
class AprListItemSiteDto {
  @Expose()
  id: string;

  @Expose()
  nome: string;
}

@Exclude()
class AprListItemUserDto {
  @Expose()
  id: string;

  @Expose()
  nome: string;

  @Expose()
  funcao?: string | null;
}

@Exclude()
export class AprListItemDto {
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
  data_inicio: Date;

  @Expose()
  data_fim: Date;

  @Expose()
  status: string;

  @Expose()
  versao: number;

  @Expose()
  is_modelo: boolean;

  @Expose()
  is_modelo_padrao: boolean;

  @Expose()
  company_id: string;

  @Expose()
  site_id: string;

  @Expose()
  elaborador_id: string;

  @Expose()
  auditado_por_id?: string | null;

  @Expose()
  aprovado_por_id?: string | null;

  @Expose()
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    Boolean(obj.pdf_file_key),
  )
  has_final_pdf: boolean;

  @Expose()
  pdf_original_name?: string | null;

  @Expose()
  classificacao_resumo?: {
    total: number;
    aceitavel: number;
    atencao: number;
    substancial: number;
    critico: number;
  };

  @Expose()
  participant_count?: number;

  @Expose()
  signature_count?: number;

  @Expose()
  created_at: Date;

  @Expose()
  updated_at: Date;

  @Expose()
  @Type(() => AprListItemCompanyDto)
  company?: AprListItemCompanyDto;

  @Expose()
  @Type(() => AprListItemSiteDto)
  site?: AprListItemSiteDto;

  @Expose()
  @Type(() => AprListItemUserDto)
  elaborador?: AprListItemUserDto;

  @Expose()
  @Type(() => AprListItemUserDto)
  auditado_por?: AprListItemUserDto;

  @Expose()
  @Type(() => AprListItemUserDto)
  aprovado_por?: AprListItemUserDto;
}
