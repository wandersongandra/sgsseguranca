import { Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import * as argon2 from 'argon2';
import pLimit from 'p-limit';
// bcryptjs mantido para verificação de hashes legados durante migração gradual.
// Remover somente após confirmar que nenhum registro no banco usa prefixo $2b$/$2a$.
// Verificar com: SELECT COUNT(*) FROM users WHERE password LIKE '$2%';
import * as bcrypt from 'bcryptjs';

/**
 * Parâmetros argon2id — OWASP Password Storage Cheat Sheet.
 * Defaults equilibram segurança e previsibilidade sob carga:
 * - memoryCost: 19 MiB (19456 KiB)
 * - timeCost: 2 iterações
 * - parallelism: 1
 *
 * Em ambientes com recursos maiores, aumente via env:
 * PASSWORD_ARGON2_MEMORY_COST_KIB, PASSWORD_ARGON2_TIME_COST, PASSWORD_ARGON2_PARALLELISM.
 */
const DEFAULT_ARGON2_MEMORY_COST_KIB = 19_456;
const DEFAULT_ARGON2_TIME_COST = 2;
const DEFAULT_ARGON2_PARALLELISM = 1;
const DEFAULT_PASSWORD_WORK_MAX_CONCURRENCY = 8;
const DEFAULT_PASSWORD_VERIFY_MAX_CONCURRENCY = 8;

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.floor(parsed);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

export const ARGON2_OPTIONS: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: parseBoundedInt(
    process.env.PASSWORD_ARGON2_MEMORY_COST_KIB,
    DEFAULT_ARGON2_MEMORY_COST_KIB,
    12_288,
    131_072,
  ),
  timeCost: parseBoundedInt(
    process.env.PASSWORD_ARGON2_TIME_COST,
    DEFAULT_ARGON2_TIME_COST,
    1,
    6,
  ),
  parallelism: parseBoundedInt(
    process.env.PASSWORD_ARGON2_PARALLELISM,
    DEFAULT_ARGON2_PARALLELISM,
    1,
    4,
  ),
};

const LEGACY_PASSWORD_WORK_MAX_CONCURRENCY = parseBoundedInt(
  process.env.PASSWORD_HASH_MAX_CONCURRENCY,
  DEFAULT_PASSWORD_WORK_MAX_CONCURRENCY,
  1,
  64,
);
const PASSWORD_HASH_WRITE_MAX_CONCURRENCY = parseBoundedInt(
  process.env.PASSWORD_HASH_WRITE_MAX_CONCURRENCY,
  LEGACY_PASSWORD_WORK_MAX_CONCURRENCY,
  1,
  64,
);
const PASSWORD_VERIFY_MAX_CONCURRENCY = parseBoundedInt(
  process.env.PASSWORD_VERIFY_MAX_CONCURRENCY,
  Math.max(
    LEGACY_PASSWORD_WORK_MAX_CONCURRENCY,
    DEFAULT_PASSWORD_VERIFY_MAX_CONCURRENCY,
  ),
  1,
  64,
);
const passwordHashLimiter = pLimit(PASSWORD_HASH_WRITE_MAX_CONCURRENCY);
const passwordVerifyLimiter = pLimit(PASSWORD_VERIFY_MAX_CONCURRENCY);

/**
 * Detecta hashes bcrypt — formato legado.
 * Variantes cobertas:
 *   $2a$ — bcrypt original (1999)
 *   $2b$ — bcrypt corrigido (2011, padrão bcryptjs)
 *   $2x$ — variante PHP/OpenBSD com bug de implementação (raro)
 *   $2y$ — variante PHP "canônica" (equivalente a $2b$)
 * Todas são suportadas pelo bcryptjs.compare().
 */
const BCRYPT_REGEX = /^\$2[abxy]\$\d{2}\$/;

/**
 * Métricas de verificação de senha — TAREFA 7.3.
 *
 * `auth.hash_algorithm`: conta verificações por algoritmo.
 * Permite construir dashboard "% usuários migrados bcrypt → argon2id".
 *
 * `auth.password_verify_duration_ms`: histograma de latência por algoritmo.
 * Valida que argon2id não introduziu regressão de performance em produção.
 *
 * Zero-overhead quando OTel está desabilitado (OTEL_ENABLED=false):
 * o SDK OTel usa no-op meter que descarta as chamadas sem processamento.
 */
const _meter = metrics.getMeter('auth-service');

const hashAlgorithmCounter = _meter.createCounter('auth.hash_algorithm', {
  description: 'Contagem de verificações de senha por algoritmo de hash',
});

const verifyDurationHistogram = _meter.createHistogram(
  'auth.password_verify_duration_ms',
  {
    description:
      'Duração da verificação de senha em milissegundos, por algoritmo',
    unit: 'ms',
  },
);

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly MIN_LENGTH = this.getMinPasswordLength();

  private getMinPasswordLength(): number {
    const value = Number(process.env.PASSWORD_MIN_LENGTH || 10);
    if (!Number.isFinite(value)) {
      return 10;
    }
    return Math.min(Math.max(Math.floor(value), 8), 32);
  }

  /**
   * Gera hash argon2id para a senha fornecida.
   * Todas as novas senhas e rehashes usam argon2id.
   */
  async hash(password: string): Promise<string> {
    return passwordHashLimiter(() => argon2.hash(password, ARGON2_OPTIONS));
  }

  /**
   * Verifica senha contra hash armazenado.
   * Detecta automaticamente o algoritmo pelo prefixo do hash:
   *   - `$argon2id$` → argon2id (padrão atual)
   *   - `$2b$` / `$2a$` → bcrypt (legado, migração gradual)
   *
   * Após verificação bem-sucedida de um hash bcrypt, o caller deve
   * agendar um rehash para argon2id (fire-and-forget via setImmediate).
   */
  async verify(password: string, storedHash: string): Promise<boolean> {
    const algorithm = this.isLegacyHash(storedHash) ? 'bcrypt' : 'argon2id';
    const t0 = Date.now();
    try {
      return await passwordVerifyLimiter(async () => {
        if (algorithm === 'bcrypt') {
          return await bcrypt.compare(password, storedHash);
        }
        return await argon2.verify(storedHash, password);
      });
    } catch (error) {
      this.logger.warn(
        `Password verification failed and was treated as invalid credentials: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    } finally {
      const durationMs = Date.now() - t0;
      hashAlgorithmCounter.add(1, { algorithm });
      verifyDurationHistogram.record(durationMs, { algorithm });
    }
  }

  /**
   * Alias de `verify()` — mantido para retrocompatibilidade com chamadas existentes.
   * Prefer `verify()` em código novo.
   */
  async compare(password: string, storedHash: string): Promise<boolean> {
    return this.verify(password, storedHash);
  }

  /**
   * Retorna true se o hash armazenado é bcrypt ($2b$/$2a$/$2y$).
   * Usado para decidir se é necessário rehash para argon2id após login.
   */
  isLegacyHash(storedHash: string): boolean {
    return BCRYPT_REGEX.test(storedHash);
  }

  validate(password: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const normalized = password.trim().toLowerCase();

    if (password.length < this.MIN_LENGTH) {
      errors.push(`Senha deve ter no mínimo ${this.MIN_LENGTH} caracteres`);
    }
    if (!/[A-Z]/.test(password)) {
      errors.push('Senha deve conter ao menos uma letra maiúscula');
    }
    if (!/[a-z]/.test(password)) {
      errors.push('Senha deve conter ao menos uma letra minúscula');
    }
    if (!/[0-9]/.test(password)) {
      errors.push('Senha deve conter ao menos um número');
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      errors.push('Senha deve conter ao menos um caractere especial');
    }
    if (/\s/.test(password)) {
      errors.push('Senha não pode conter espaços');
    }

    const blocked = [
      'password',
      'senha',
      'admin',
      '123456',
      '12345678',
      '123456789',
      '1234567890',
      'qwerty',
      'gandra2026',
      'abc123',
      'letmein',
      'welcome',
      'monkey',
      'master',
      'dragon',
      'login',
      'passw0rd',
      'iloveyou',
      'trustno1',
      'changeme',
      'seguranca',
      'mudar123',
    ];
    const stripped = normalized.replace(/[^a-z0-9]/g, '');
    if (blocked.some((item) => stripped === item || stripped.includes(item))) {
      errors.push('Senha contém padrões comuns e inseguros');
    }
    // Reject sequential/repeated characters (e.g., "aaaaaa", "AAAA")
    if (/(.)\1{3,}/i.test(password)) {
      errors.push('Senha não pode conter caracteres repetidos em sequência');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
