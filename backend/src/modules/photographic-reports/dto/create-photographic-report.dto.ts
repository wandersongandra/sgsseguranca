import {
  ArrayMaxSize,
  IsArray,
  IsEmpty,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import {
  PhotographicReportAreaStatus,
  PhotographicReportShift,
  PhotographicReportTone,
} from '../entities/photographic-report.entity';
import {
  MAX_APPLICABLE_NRS,
  REGISTRATION_TYPE_OPTIONS,
  type PhotographicReportRegistrationType,
} from '../photographic-reports.constants';

export class CreatePhotographicReportDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  client_id?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  project_id?: string;

  @IsString()
  @Length(2, 160)
  client_name: string;

  @IsString()
  @Length(2, 160)
  project_name: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  unit_name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 220)
  location?: string;

  @IsString()
  @Length(2, 120)
  activity_type: string;

  @IsOptional()
  @IsEnum(PhotographicReportTone)
  report_tone?: PhotographicReportTone;

  @IsOptional()
  @IsEnum(PhotographicReportAreaStatus)
  area_status?: PhotographicReportAreaStatus;

  @IsOptional()
  @IsEnum(PhotographicReportShift)
  shift?: PhotographicReportShift;

  @IsDateString()
  start_date: string;

  @IsOptional()
  @IsDateString()
  end_date?: string;

  @IsString()
  @Length(4, 5)
  start_time: string;

  @IsString()
  @Length(4, 5)
  end_time: string;

  @IsString()
  @Length(2, 160)
  responsible_name: string;

  @IsOptional()
  @IsIn(REGISTRATION_TYPE_OPTIONS)
  responsible_registration_type?: PhotographicReportRegistrationType;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  responsible_registration_number?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  responsible_registration_state?: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  art_number?: string;

  @IsString()
  @Length(2, 180)
  contractor_company: string;

  /**
   * A pertinência de cada NR é conferida no serviço, não aqui: uma norma
   * desconhecida é descartada em vez de derrubar com 400 um relatório que no
   * mais está válido.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_APPLICABLE_NRS)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  applicable_nrs?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  inspection_methodology?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  scope_and_limitations?: string;

  @IsOptional()
  @IsString()
  general_observations?: string;

  @IsOptional()
  @IsEmpty({
    message:
      'created_by não é permitido no payload. O usuário autenticado define a autoria.',
  })
  created_by?: never;

  // Campos de governança são escritos apenas pelo backend, na transação de
  // registerFinalDocument. Aceitá-los do cliente permitiria forjar o código de
  // validação e o hash do PDF — exatamente o que o QR público atesta.
  @IsOptional()
  @IsEmpty({
    message:
      'verification_code não é permitido no payload. O código é emitido pelo sistema.',
  })
  verification_code?: never;

  @IsOptional()
  @IsEmpty({
    message:
      'final_pdf_hash_sha256 não é permitido no payload. O hash é calculado na emissão.',
  })
  final_pdf_hash_sha256?: never;
}
