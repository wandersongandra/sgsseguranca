import { createHash } from 'crypto';

export const SIGNATURE_VERIFICATION_MODES = {
  SERVER_VERIFIABLE: 'server_verifiable',
  OPERATIONAL_ACK: 'operational_ack',
  LEGACY_CLIENT_HASH: 'legacy_client_hash',
} as const;

export const SIGNATURE_PROOF_SCOPES = {
  GOVERNED_FINAL_DOCUMENT: 'governed_final_document',
  DOCUMENT_REVISION: 'document_revision',
  DOCUMENT_IDENTITY: 'document_identity',
  OPERATIONAL_SNAPSHOT: 'operational_snapshot',
} as const;

export const SIGNATURE_LEGAL_ASSURANCE = {
  NOT_LEGAL_STRONG: 'not_legal_strong',
} as const;

/**
 * Tipos de assinatura aceitos pela API.
 *
 * O `type` define o RÓTULO DE PROVA impresso no PDF governado. Sem allowlist,
 * o cliente escolhia o rótulo livremente — era possível registrar
 * `type: 'digital'` (impresso como "Assinatura Digital") sem que nenhuma
 * verificação criptográfica tivesse ocorrido. Só `hmac` é verificado
 * server-side (PIN via PBKDF2/HMAC-SHA256); os demais são captura de
 * evidência (imagem/aceite) e devem ser rotulados como tal.
 *
 * - `hmac`: PIN do signatário validado no servidor. Única prova verificada.
 * - `drawn`: imagem da assinatura desenhada no dispositivo.
 * - `upload`: imagem de assinatura enviada por arquivo.
 * - `acknowledgement`: aceite operacional registrado (sem imagem).
 *
 * Tipos legados aceitos apenas para compatibilidade com dados já gravados
 * (`digital`, `facial`, `simple`, `cpf_pin`) — mapeados para o rótulo honesto
 * correspondente e NÃO aceitos em novas assinaturas.
 */
export const SIGNATURE_TYPES = {
  HMAC: 'hmac',
  DRAWN: 'drawn',
  UPLOAD: 'upload',
  ACKNOWLEDGEMENT: 'acknowledgement',
} as const;

export const SIGNATURE_TYPE_VALUES = Object.values(SIGNATURE_TYPES);

/** Prefixo dos tipos de foto de equipe do DDS (team_photo_1, _2, ...). */
export const TEAM_PHOTO_SIGNATURE_TYPE_PREFIX = 'team_photo_';

/** Tipo especial do DDS para justificar reuso de foto de equipe. */
export const TEAM_PHOTO_REUSE_JUSTIFICATION_TYPE =
  'team_photo_reuse_justification';

/**
 * Tipos gravados antes da allowlist. Aceitos em leitura/validação de
 * documentos existentes, recusados em novas assinaturas.
 */
export const LEGACY_SIGNATURE_TYPES = new Set([
  'digital',
  'facial',
  'simple',
  'cpf_pin',
]);

export function isTeamPhotoSignatureType(type: string): boolean {
  return (
    type.startsWith(TEAM_PHOTO_SIGNATURE_TYPE_PREFIX) ||
    type === TEAM_PHOTO_REUSE_JUSTIFICATION_TYPE
  );
}

/** Tipo aceito para NOVAS assinaturas (allowlist estrita). */
export function isAcceptedSignatureType(type: string): boolean {
  return (
    (SIGNATURE_TYPE_VALUES as readonly string[]).includes(type) ||
    isTeamPhotoSignatureType(type)
  );
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function canonicalizeSignaturePayload(
  value: unknown,
): CanonicalJsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value.normalize('NFC');
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeSignaturePayload(item));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalizedEntries = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const original = record[key];
        const normalized = canonicalizeSignaturePayload(original);
        if (normalized === null && original === undefined) {
          return [];
        }

        return [[key, normalized] as const];
      });

    return Object.fromEntries(normalizedEntries);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return '[function]';
  }

  return '[unknown]';
}

export function hashCanonicalSignaturePayload(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeSignaturePayload(value)))
    .digest('hex');
}

export function hashSignatureEvidence(rawValue: string): string {
  return createHash('sha256')
    .update(String(rawValue || ''))
    .digest('hex');
}
