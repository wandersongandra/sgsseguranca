import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectPtDto {
  @IsString()
  @IsNotEmpty({ message: 'O motivo da rejeição é obrigatório.' })
  @MaxLength(2000)
  reason: string;
}
