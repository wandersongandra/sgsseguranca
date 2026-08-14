import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Payload multipart do upload de fotos.
 *
 * Tudo aqui chega como STRING — é `multipart/form-data`, não JSON. Os
 * transformadores abaixo são os mesmos de `apr-evidence-upload.dto.ts`,
 * copiados de propósito para que os dois módulos convirjam no mesmo
 * comportamento de coerção.
 */

const toOptionalFloat = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
};

const trimOptionalString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toOptionalBoolean = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

/**
 * Listas por arquivo chegam como JSON serializado num único campo do form.
 *
 * Em qualquer caminho de falha o valor original é devolvido intacto, para que a
 * mensagem de erro venha do @IsArray/@IsISO8601 e não de um parser silencioso.
 */
const toOptionalStringArray = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

export class UploadPhotographicReportImagesDto {
  @IsOptional()
  @IsUUID()
  report_day_id?: string | null;

  @IsOptional()
  @IsDateString()
  activity_date?: string;

  @IsOptional()
  @IsString()
  manual_caption?: string | null;

  // ── Contexto de captura (por lote) ────────────────────────────────────────
  // A geolocalização é UMA por ação de upload: é a posição do operador no
  // momento em que enviou o conjunto, não a de cada foto individual. As
  // coordenadas são arredondadas a ~1 km no servidor antes de gravar.

  @IsOptional()
  @Transform(toOptionalFloat)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @Transform(toOptionalFloat)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @Transform(toOptionalFloat)
  @IsNumber()
  @Min(0)
  @Max(10000)
  accuracy_m?: number;

  @IsOptional()
  @Transform(trimOptionalString)
  @IsString()
  @MaxLength(120)
  device_id?: string;

  /**
   * Sinaliza que o cliente re-encodou as imagens antes do envio (o que o
   * `processMobileImage` sempre faz). Vira `integrity_flags.client_reencoded`
   * e determina se o manifesto do PDF exibe a ressalva de que o hash não
   * comprova autoria da captura.
   */
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  client_reencoded?: boolean;

  // ── Carimbos por arquivo ──────────────────────────────────────────────────
  // CONTRATO DE ALINHAMENTO: estas listas são posicionais e devem ter o mesmo
  // comprimento e a mesma ordem de `files`. O índice N descreve o arquivo N.
  // Índices sobrando são ignorados; faltando viram null. É frágil por natureza
  // — se um dia o upload passar a aceitar reordenação, isto quebra em silêncio.

  @IsOptional()
  @Transform(toOptionalStringArray)
  @IsArray()
  @ArrayMaxSize(30)
  @IsISO8601({}, { each: true })
  captured_at_list?: string[];

  @IsOptional()
  @Transform(toOptionalStringArray)
  @IsArray()
  @ArrayMaxSize(30)
  @IsISO8601({}, { each: true })
  exif_datetime_list?: string[];
}
