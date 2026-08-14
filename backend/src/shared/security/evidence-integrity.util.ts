import { createHmac } from 'node:crypto';

/**
 * Normalizadores de metadados de integridade de evidência fotográfica.
 *
 * Estas funções nasceram privadas em `AprsEvidenceService` e foram levantadas
 * para cá **sem alteração de comportamento** quando o módulo de Relatório
 * Fotográfico passou a registrar a mesma classe de metadados. Os dois módulos
 * precisam produzir exatamente os mesmos valores: linhas já gravadas em
 * `apr_risk_evidences` foram produzidas por estas implementações, e qualquer
 * "melhoria" aqui torna o histórico inconsistente com o novo.
 *
 * Fica em `shared/security/` (e não em `shared/utils/`) porque `hashDeviceId`
 * consome `FIELD_ENCRYPTION_KEY`, seguindo a vizinhança de `field-encryption.util.ts`.
 */

/**
 * Mascara o IP antes da persistência: IPv4 vira /24 (último octeto zerado) e
 * IPv6 é truncado ao /48.
 *
 * O ramo IPv6 é peculiar — só casa endereços com exatamente 4+ grupos e cai num
 * fallback que zera o último grupo. É o comportamento em produção desde a
 * primeira versão e está preservado deliberadamente.
 */
export function maskIpAddress(ip: string | null | undefined): string | null {
  if (!ip) return null;
  // Reduz IPv4 para /24 (último octeto zerado). IPv6: trunca ao /48.
  const ipv4 = ip.replace(/^(\d+\.\d+\.\d+\.)\d+$/, '$10');
  if (ipv4 !== ip) return ipv4;
  // IPv6: manter só os primeiros 3 grupos
  const ipv6 = ip.replace(/^([0-9a-fA-F:]+:){3}[0-9a-fA-F:]+$/, (m) => {
    const parts = m.split(':');
    return parts.slice(0, 3).join(':') + '::';
  });
  return ipv6 !== ip ? ipv6 : ip.replace(/[^:]+$/, '0');
}

/**
 * Deriva um identificador de dispositivo irreversível via HMAC-SHA256.
 *
 * O identificador cru nunca é persistido. Sem `FIELD_ENCRYPTION_KEY` cai numa
 * chave fixa de desenvolvimento — o que significa que hashes gerados em dev não
 * são comparáveis aos de produção, por construção.
 */
export function hashDeviceId(
  deviceId: string | null | undefined,
): string | null {
  if (!deviceId?.trim()) return null;
  const key = process.env.FIELD_ENCRYPTION_KEY ?? 'default-device-hash-key';
  return createHmac('sha256', key).update(deviceId.trim()).digest('hex');
}

/**
 * Arredonda coordenada para 2 casas decimais (~1 km).
 *
 * É uma proteção de privacidade intencional, não um detalhe de formatação: o
 * documento comprova a região do registro, não a posição exata do trabalhador.
 * Quem exibir a coordenada deve deixar a imprecisão explícita.
 */
export function roundCoordinate(
  value: number | null | undefined,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100; // 2 casas decimais (~1km precision)
}

/** Converte string ISO em Date, devolvendo null para vazio ou data inválida. */
export function parseOptionalDate(value?: string | null): Date | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type EvidenceIntegrityFlags = {
  /** Coordenadas de geolocalização foram informadas. */
  gps: boolean;
  /** Precisão da geolocalização foi informada. */
  accuracy: boolean;
  /** Identificador de dispositivo foi informado. */
  device: boolean;
  /** IP de origem foi capturado. */
  ip: boolean;
  /** Data/hora de EXIF foi informada. */
  exif: boolean;
  /**
   * A imagem foi re-encodada pelo cliente antes do upload.
   *
   * Quando verdadeiro, o hash armazenado é dos bytes recebidos, **não** do
   * arquivo original da câmera — o EXIF já não existe nesse ponto. Comprova
   * integridade desde o recebimento, não autoria da captura. Quem renderiza
   * o manifesto de evidências precisa dizer isso ao leitor.
   */
  client_reencoded?: boolean;
};

export function buildIntegrityFlags(input: {
  latitude?: number | null;
  longitude?: number | null;
  accuracy_m?: number | null;
  device_id?: string | null;
  ipAddress?: string | null;
  exif_datetime?: string | null;
  clientReencoded?: boolean;
}): EvidenceIntegrityFlags {
  const flags: EvidenceIntegrityFlags = {
    gps:
      typeof input.latitude === 'number' && typeof input.longitude === 'number',
    accuracy:
      typeof input.accuracy_m === 'number' && Number.isFinite(input.accuracy_m),
    device: Boolean(input.device_id),
    ip: Boolean(input.ipAddress),
    exif: Boolean(input.exif_datetime),
  };

  // Só emite a chave quando o chamador se pronunciou: ausência significa
  // "não informado", que é diferente de "não houve re-encode".
  if (input.clientReencoded !== undefined) {
    flags.client_reencoded = input.clientReencoded;
  }

  return flags;
}
