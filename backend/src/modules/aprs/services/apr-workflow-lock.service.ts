import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DistributedLockHandle,
  DistributedLockService,
} from '../../../shared/redis/distributed-lock.service';

const WORKFLOW_LOCK_NAME_PREFIX = 'lock:apr:workflow:';

// A geração síncrona de PDF pode combinar aquisição do browser (até 3 min) e
// renderização da página (até 3 min). O lease inicial de 10 min cobre esse
// orçamento mesmo antes da primeira renovação; o heartbeat mantém a posse em
// operações excepcionalmente lentas.
const DEFAULT_WORKFLOW_LOCK_LEASE_MS = 10 * 60_000;
const MIN_WORKFLOW_LOCK_LEASE_MS = 10 * 60_000;
const MAX_WORKFLOW_LOCK_LEASE_MS = 30 * 60_000;
const DEFAULT_WORKFLOW_LOCK_RENEW_INTERVAL_MS = 60_000;
const MIN_WORKFLOW_LOCK_RENEW_INTERVAL_MS = 10_000;

type LeaseHealth =
  | { kind: 'healthy' }
  | { kind: 'lost' }
  | { kind: 'unavailable'; cause: unknown };

type LeaseRenewal = {
  stop: () => Promise<void>;
  assertHealthy: () => void;
};

function readBoundedDurationMs(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(raw), min), max);
}

/**
 * Serializa a emissão do PDF final de uma APR entre réplicas sem reter
 * conexões do banco durante a renderização (achado da auditoria v2:
 * generateFinalPdf não tinha nenhuma exclusão, permitindo dois Puppeteer
 * renders simultâneos + objeto órfão no storage quando dois cliques em
 * "gerar PDF final" chegavam antes do primeiro terminar).
 *
 * O lock usa Redis com token aleatório e TTL: falha de Redis bloqueia a ação
 * em vez de permitir uma emissão concorrente sem coordenação. A persistência
 * condicional (recheck de pdf_file_key dentro da seção exclusiva) continua
 * sendo a barreira final caso uma réplica antiga ou um lease perdido consiga
 * chegar ao banco. Mesmo padrão de `NonConformityWorkflowLockService`.
 */
@Injectable()
export class AprWorkflowLockService {
  private readonly logger = new Logger(AprWorkflowLockService.name);

  constructor(private readonly distributedLock: DistributedLockService) {}

  async runExclusive<T>(
    aprId: string,
    operation: (assertLeaseHealthy: () => void) => Promise<T>,
  ): Promise<T> {
    const leaseMs = this.resolveLeaseMs();
    const lockName = `${WORKFLOW_LOCK_NAME_PREFIX}${aprId}`;
    let lock: DistributedLockHandle | null;

    try {
      // Fail-fast deliberado: não criamos waiters que possam sobreviver ao
      // timeout HTTP e executar a mutação depois da resposta ao usuário.
      lock = await this.distributedLock.tryAcquire(lockName, leaseMs);
    } catch (error) {
      this.logger.error(
        `Redis indisponível ao adquirir lock de workflow da APR ${aprId}: ${this.getErrorMessage(error)}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível garantir a exclusividade da APR. Tente novamente em instantes.',
      );
    }

    if (!lock) {
      throw new ConflictException(
        'Esta APR está sendo processada por outra operação (emissão de PDF em andamento). Aguarde alguns instantes e tente novamente.',
      );
    }

    const renewal = this.startLeaseRenewal(lock, leaseMs);

    try {
      // A operação recebe uma barreira que deve ser chamada imediatamente
      // antes da persistência. Assim, uma perda de lease detectada durante
      // trabalho lento (renderização/upload) não vira uma escrita tardia.
      renewal.assertHealthy();
      const result = await operation(renewal.assertHealthy);
      await renewal.stop();
      // Não transforme uma gravação já concluída em erro apenas porque o
      // heartbeat falhou depois dela. As mutações também usam lock de linha no
      // PostgreSQL; depois do último ponto de persistência não há efeito que
      // possa ser revertido com segurança por esta camada.
      return result;
    } finally {
      await renewal.stop();
      await this.releaseSafely(lock, aprId);
    }
  }

  private resolveLeaseMs(): number {
    return readBoundedDurationMs(
      'APR_WORKFLOW_LOCK_LEASE_MS',
      DEFAULT_WORKFLOW_LOCK_LEASE_MS,
      MIN_WORKFLOW_LOCK_LEASE_MS,
      MAX_WORKFLOW_LOCK_LEASE_MS,
    );
  }

  private resolveRenewIntervalMs(leaseMs: number): number {
    const maxIntervalMs = Math.max(
      MIN_WORKFLOW_LOCK_RENEW_INTERVAL_MS,
      Math.floor(leaseMs / 3),
    );
    return Math.min(
      readBoundedDurationMs(
        'APR_WORKFLOW_LOCK_RENEW_INTERVAL_MS',
        DEFAULT_WORKFLOW_LOCK_RENEW_INTERVAL_MS,
        MIN_WORKFLOW_LOCK_RENEW_INTERVAL_MS,
        maxIntervalMs,
      ),
      maxIntervalMs,
    );
  }

  private startLeaseRenewal(
    lock: DistributedLockHandle,
    leaseMs: number,
  ): LeaseRenewal {
    let health: LeaseHealth = { kind: 'healthy' };
    let renewalInFlight: Promise<void> | null = null;

    const renew = (): void => {
      if (renewalInFlight || health.kind !== 'healthy') {
        return;
      }

      renewalInFlight = (async () => {
        try {
          const extended = await this.distributedLock.extend(lock, leaseMs);
          if (!extended) {
            health = { kind: 'lost' };
            this.logger.error(
              `Lock Redis de workflow da APR perdeu a posse durante a operação (${lock.key}).`,
            );
          }
        } catch (error) {
          health = { kind: 'unavailable', cause: error };
          this.logger.error(
            `Redis indisponível ao renovar lock de workflow da APR (${lock.key}): ${this.getErrorMessage(error)}`,
          );
        } finally {
          renewalInFlight = null;
        }
      })();
    };

    const timer = setInterval(renew, this.resolveRenewIntervalMs(leaseMs));

    return {
      stop: async () => {
        clearInterval(timer);
        await renewalInFlight;
      },
      assertHealthy: () => {
        if (health.kind === 'lost') {
          throw new ConflictException(
            'A exclusividade da APR foi perdida durante a operação. Revise o registro e tente novamente.',
          );
        }
        if (health.kind === 'unavailable') {
          throw new ServiceUnavailableException(
            'Não foi possível confirmar a exclusividade da APR. Tente novamente em instantes.',
          );
        }
      },
    };
  }

  private async releaseSafely(
    lock: DistributedLockHandle,
    aprId: string,
  ): Promise<void> {
    try {
      await this.distributedLock.release(lock);
    } catch (error) {
      // O TTL continua como recuperação segura. Não sobrescrevemos o resultado
      // da operação já concluída, pois um retry poderia duplicar uma ação.
      this.logger.warn(
        `Redis indisponível ao liberar lock de workflow da APR ${aprId}: ${this.getErrorMessage(error)}`,
      );
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
