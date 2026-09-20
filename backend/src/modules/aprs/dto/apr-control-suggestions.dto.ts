import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Sem esta classe, `@Body()` tipado com objeto inline faz `design:paramtypes`
 * virar `Object` e o ValidationPipe global fica sem efeito neste endpoint
 * (armadilha conhecida do projeto — ver memória
 * `armadilha-basecontroller-validationpipe-nest.md`).
 */
export class AprControlSuggestionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  probability?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  severity?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  exposure?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  activity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  condition?: string;
}
