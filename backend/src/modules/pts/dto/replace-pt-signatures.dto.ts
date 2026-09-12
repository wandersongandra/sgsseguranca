import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PtSignatureInputDto {
  @IsUUID()
  user_id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  signature_data: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  type: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'PIN deve ter 4 a 6 dígitos numéricos.' })
  pin?: string;
}

export class ReplacePtSignaturesDto {
  @IsArray()
  @ArrayMaxSize(60, { message: 'Máximo 60 assinaturas por requisição.' })
  @ArrayUnique((signature: PtSignatureInputDto) => signature.user_id, {
    message: 'Cada usuário só pode aparecer uma vez nas assinaturas.',
  })
  @ValidateNested({ each: true })
  @Type(() => PtSignatureInputDto)
  signatures: PtSignatureInputDto[];
}
