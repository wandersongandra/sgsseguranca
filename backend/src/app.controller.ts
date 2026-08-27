import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Public } from './shared/decorators/public.decorator';
import { shouldRequireNoPendingMigrations } from './shared/database/migration-startup.guard';
import { RedisService } from './shared/redis/redis.service';
import migrationCompatibility from '../migration-history-compatibility.json';

const LEGACY_MIGRATION_ALIASES: Record<string, string> =
  migrationCompatibility.aliases;

function getMigrationName(migration: {
  name?: string;
  constructor?: { name?: string };
}): string {
  return String(migration.name || migration.constructor?.name || '');
}

function isEffectivelyExecuted(
  migrationName: string,
  executedMigrationNames: Set<string>,
): boolean {
  if (executedMigrationNames.has(migrationName)) {
    return true;
  }

  return Object.entries(LEGACY_MIGRATION_ALIASES).some(
    ([legacyName, canonicalName]) =>
      canonicalName === migrationName && executedMigrationNames.has(legacyName),
  );
}

@Controller()
export class AppController {
  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly redisService: RedisService,
  ) {}

  @Public()
  @Get('health/public')
  publicHealthCheck() {
    return { status: 'ok' };
  }

  @Public()
  @Get('health')
  async healthCheck() {
    const database = await this.checkDatabase();
    const redis = await this.checkRedis();
    const ready =
      database.status === 'up' &&
      (redis.status === 'up' || redis.status === 'disabled');

    const statusPayload = {
      status: ready ? 'ok' : 'degraded',
    };

    if (!ready) {
      throw new ServiceUnavailableException(statusPayload);
    }

    return statusPayload;
  }

  @Public()
  @Get('api')
  apiInfo() {
    // Não expor versão nem nome do sistema para evitar fingerprinting.
    return { status: 'online' };
  }

  @Public()
  @Get('favicon.ico')
  @HttpCode(204)
  favicon(): void {}

  private async checkDatabase() {
    if (!this.dataSource.isInitialized) {
      return {
        status: 'down' as const,
        message: 'DataSource ainda não inicializado',
      };
    }

    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'up' as const };
    } catch (error) {
      return {
        status: 'down' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkRedis() {
    const redisDisabled = /^true$/i.test(
      this.configService.get<string>('REDIS_DISABLED', 'false'),
    );

    if (redisDisabled) {
      return {
        status: 'disabled' as const,
        message: 'REDIS_DISABLED=true',
      };
    }

    try {
      const response = await this.redisService.getClient().ping();
      return {
        status: response === 'PONG' ? ('up' as const) : ('down' as const),
        message: response,
      };
    } catch (error) {
      return {
        status: 'down' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkMigrations() {
    const nodeEnv =
      this.configService.get<string>('NODE_ENV') || process.env.NODE_ENV;
    const pendingMigrationPolicy =
      this.configService.get<string>('REQUIRE_NO_PENDING_MIGRATIONS') ||
      process.env.REQUIRE_NO_PENDING_MIGRATIONS;
    const requireNoPendingMigrations = shouldRequireNoPendingMigrations({
      ...process.env,
      NODE_ENV: nodeEnv,
      REQUIRE_NO_PENDING_MIGRATIONS: pendingMigrationPolicy,
    });

    if (!requireNoPendingMigrations) {
      return { status: 'skipped' as const };
    }

    if (!this.dataSource.isInitialized) {
      return {
        status: 'down' as const,
        message: 'DataSource indisponível para verificar migrations',
      };
    }

    try {
      const executedRows: Array<{ name?: string }> =
        await this.dataSource.query('SELECT name FROM "migrations"');
      const executedMigrationNames = new Set(
        executedRows.map((row) => String(row.name || '')).filter(Boolean),
      );
      const hasPendingMigrations = this.dataSource.migrations.some(
        (migration) =>
          !isEffectivelyExecuted(
            getMigrationName(migration),
            executedMigrationNames,
          ),
      );
      if (hasPendingMigrations) {
        return {
          status: 'down' as const,
          message: 'Pending database migrations detected',
        };
      }

      return { status: 'up' as const };
    } catch (error) {
      return {
        status: 'down' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
