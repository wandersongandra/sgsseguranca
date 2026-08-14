import { Exclude, Expose } from 'class-transformer';
import type { AprLog } from '../entities/apr-log.entity';

/**
 * Projection returned by the timeline endpoint.
 *
 * Storage keys, original file names and free-form metadata are deliberately
 * not exposed over HTTP.  Those values are operational internals and can
 * contain personal data or reveal the storage layout.
 */
@Exclude()
export class AprLogResponseDto {
  @Expose()
  id: string;

  @Expose()
  apr_id: string;

  @Expose()
  usuario_id?: string | null;

  @Expose()
  acao: string;

  @Expose()
  metadata?: Record<string, string | number | boolean>;

  @Expose()
  data_hora: Date;
}

const SAFE_METADATA_KEYS = new Set([
  'status',
  'previousStatus',
  'currentStatus',
  'versao',
  'siteId',
  'participantCount',
  'riskItemCount',
  'approvalStepCount',
  'sourceAprId',
  'novaAprId',
  'reopenedFromStep',
  'generated',
]);

function projectMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!metadata) return undefined;

  const projected: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      continue;
    }
    // Keep audit responses bounded even when a malformed row contains a very
    // large scalar value. Free-form reasons are intentionally excluded.
    if (typeof value === 'string' && value.length > 120) continue;
    projected[key] = value;
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

type AprLogResponseInput = Pick<
  AprLog,
  'id' | 'apr_id' | 'usuario_id' | 'acao' | 'metadata' | 'data_hora'
>;

export function toAprLogResponseDto(
  log: AprLogResponseInput,
): AprLogResponseDto {
  const dto = new AprLogResponseDto();
  dto.id = log.id;
  dto.apr_id = log.apr_id;
  dto.usuario_id = log.usuario_id ?? null;
  dto.acao = log.acao;
  dto.metadata = projectMetadata(log.metadata);
  dto.data_hora = log.data_hora;
  return dto;
}
