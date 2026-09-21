import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'notifications';
const COLUMN = 'dedupe_key';
const INDEX = 'UQ_notifications_company_user_dedupe_active';

function isSqlite(queryRunner: QueryRunner): boolean {
  return (
    queryRunner.connection.options.type === 'sqlite' ||
    queryRunner.connection.options.type === 'better-sqlite3'
  );
}

export class AddNotificationDurableDedupeKey1709000000406 implements MigrationInterface {
  name = 'AddNotificationDurableDedupeKey1709000000406';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertPreflight(queryRunner);

    if (!(await queryRunner.hasColumn(TABLE, COLUMN))) {
      await queryRunner.query(
        `ALTER TABLE "${TABLE}" ADD COLUMN "${COLUMN}" character varying(255) NULL`,
      );
    }

    if (isSqlite(queryRunner)) {
      await queryRunner.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX}"
        ON "${TABLE}" ("company_id", "userId", "${COLUMN}")
        WHERE "${COLUMN}" IS NOT NULL AND "deleted_at" IS NULL
      `);
      return;
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}"
      ON public."${TABLE}" ("company_id", "userId", "${COLUMN}")
      WHERE "${COLUMN}" IS NOT NULL AND "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable(TABLE))) {
      return;
    }

    await queryRunner.query(
      isSqlite(queryRunner)
        ? `DROP INDEX IF EXISTS "${INDEX}"`
        : `DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`,
    );
    if (await queryRunner.hasColumn(TABLE, COLUMN)) {
      await queryRunner.query(`ALTER TABLE "${TABLE}" DROP COLUMN "${COLUMN}"`);
    }
  }

  private async assertPreflight(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable(TABLE))) {
      throw new Error('0406 requires public.notifications');
    }
    for (const column of ['company_id', 'userId', 'deleted_at']) {
      if (!(await queryRunner.hasColumn(TABLE, column))) {
        throw new Error(`0406 requires notifications.${column}`);
      }
    }
  }
}
