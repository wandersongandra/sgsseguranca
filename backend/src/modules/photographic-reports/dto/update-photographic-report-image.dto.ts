import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PHOTO_CONDITIONS } from '../photographic-reports.constants';

export class UpdatePhotographicReportImageDto {
  @IsOptional()
  @IsUUID()
  report_day_id?: string | null;

  @IsOptional()
  @IsString()
  manual_caption?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  image_order?: number;

  @IsOptional()
  @IsString()
  ai_title?: string | null;

  @IsOptional()
  @IsString()
  ai_description?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(8)
  ai_positive_points?: string[] | null;

  @IsOptional()
  @IsString()
  ai_technical_assessment?: string | null;

  @IsOptional()
  @IsString()
  ai_condition_classification?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  ai_recommendations?: string[] | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(MAX_PHOTO_CONDITIONS)
  photo_conditions?: string[] | null;

  // ── Não conformidade ──────────────────────────────────────────────────────
  // Marcar a foto sem informar a ação produz uma pendência sem dono — o
  // frontend bloqueia o salvamento nesse caso. Aqui os campos são
  // independentes de propósito: desmarcar a NC não deve exigir reenviar a
  // ação, e limpar a ação não deve exigir desmarcar a NC.

  @IsOptional()
  @IsBoolean()
  is_nonconformity?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  recommended_action?: string | null;

  @IsOptional()
  @IsDateString()
  action_deadline?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  action_responsible?: string | null;
}
