import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

// SGS-EPI-BACK-013: raw user_id/epi_id strings reached Postgres unvalidated,
// causing 500s on malformed UUIDs. ValidationPipe now rejects non-UUID values
// before they touch the service.
export class FindEpiAssignmentsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(['entregue', 'devolvido', 'substituido'])
  status?: 'entregue' | 'devolvido' | 'substituido';

  @IsOptional()
  @IsUUID('4')
  user_id?: string;

  @IsOptional()
  @IsUUID('4')
  epi_id?: string;
}
