import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApprovePtDto {
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  reason?: string;
}
