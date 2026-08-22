import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SGS-PT-DB-011: add CHECK constraint for pts.status so only valid state-machine
 * values can be persisted. The DTO @IsIn is the only guard today; direct writes
 * via EntityManager (bulk expiry, GDPR, DR restore) bypass it silently.
 *
 * NOT VALID avoids a full table scan during ALTER; VALIDATE runs as a separate
 * statement so it holds only a ShareUpdateExclusiveLock (non-blocking reads/writes).
 */
export class PtStatusIntegrity1709000000381 implements MigrationInterface {
  name = 'PtStatusIntegrity1709000000381';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      queryRunner.connection.options.type === 'sqlite' ||
      queryRunner.connection.options.type === 'better-sqlite3'
    ) {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "pts"
        ADD CONSTRAINT "chk_pts_status"
          CHECK ("status" IN ('Pendente', 'Aprovada', 'Cancelada', 'Encerrada', 'Expirada'))
          NOT VALID;
    `);

    await queryRunner.query(`
      ALTER TABLE "pts" VALIDATE CONSTRAINT "chk_pts_status";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (
      queryRunner.connection.options.type === 'sqlite' ||
      queryRunner.connection.options.type === 'better-sqlite3'
    ) {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "pts" DROP CONSTRAINT IF EXISTS "chk_pts_status";
    `);
  }
}
