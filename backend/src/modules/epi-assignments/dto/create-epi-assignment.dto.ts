import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EpiSignatureInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(400_000)
  signature_data: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  signature_type: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  signer_name?: string;
}

export class CreateEpiAssignmentDto {
  @IsUUID()
  @IsNotEmpty()
  epi_id: string;

  @IsUUID()
  @IsNotEmpty()
  user_id: string;

  @IsOptional()
  @IsUUID()
  site_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  quantidade?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observacoes?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => EpiSignatureInputDto)
  assinatura_entrega: EpiSignatureInputDto;
}
