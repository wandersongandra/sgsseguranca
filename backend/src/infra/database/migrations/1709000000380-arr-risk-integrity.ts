import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SGS-ARR-DB-003: add CHECK constraints for nivel_risco, probabilidade,
 * severidade — the DTO's @IsIn is the only guard today; direct writes via
 * manager, DR restore and backfills bypass it.
 *
 * SGS-ARR-DB-007: the unique index UQ_arrs_document_code_active is global
 * (no company_id), so two companies whose ARR IDs share the same last-8
 * characters permanently block each other from emitting a PDF. Drop and
 * recreate scoped to (company_id, document_code).
 *
 * Both are non-transactional (CONCURRENTLY, NOT VALID) to avoid table locks.
 */
export class ArrRiskIntegrity1709000000380 implements MigrationInterface {
  name = 'ArrRiskIntegrity1709000000380';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      queryRunner.connection.options.type === 'sqlite' ||
      queryRunner.connection.options.type === 'better-sqlite3'
    ) {
      return;
    }

    // 1. CHECK constraints for risk-domain fields (NOT VALID = no table lock)
    await queryRunner.query(`
      ALTER TABLE "arrs"
        ADD CONSTRAINT "chk_arrs_nivel_risco"
          CHECK ("nivel_risco" IN ('baixo', 'medio', 'alto', 'critico'))
          NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE "arrs"
        ADD CONSTRAINT "chk_arrs_probabilidade"
          CHECK ("probabilidade" IN ('baixa', 'media', 'alta'))
          NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE "arrs"
        ADD CONSTRAINT "chk_arrs_severidade"
          CHECK ("severidade" IN ('leve', 'moderada', 'grave', 'critica'))
          NOT VALID;
    `);

    // Validate against existing rows (separate statements — each holds a share
    // lock only briefly; split so one bad row doesn't block all three)
    await queryRunner.query(`
      ALTER TABLE "arrs" VALIDATE CONSTRAINT "chk_arrs_nivel_risco";
    `);
    await queryRunner.query(`
      ALTER TABLE "arrs" VALIDATE CONSTRAINT "chk_arrs_probabilidade";
    `);
    await queryRunner.query(`
      ALTER TABLE "arrs" VALIDATE CONSTRAINT "chk_arrs_severidade";
    `);

    // 2. Recreate document_code unique index scoped to company_id
    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "UQ_arrs_document_code_active";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_arrs_document_code_company_active"
        ON "arrs" ("company_id", "document_code")
        WHERE "document_code" IS NOT NULL AND "deleted_at" IS NULL;
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
      DROP INDEX CONCURRENTLY IF EXISTS "UQ_arrs_document_code_company_active";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_arrs_document_code_active"
        ON "arrs" ("document_code")
        WHERE "document_code" IS NOT NULL AND "deleted_at" IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "arrs" DROP CONSTRAINT IF EXISTS "chk_arrs_severidade";
    `);
    await queryRunner.query(`
      ALTER TABLE "arrs" DROP CONSTRAINT IF EXISTS "chk_arrs_probabilidade";
    `);
    await queryRunner.query(`
      ALTER TABLE "arrs" DROP CONSTRAINT IF EXISTS "chk_arrs_nivel_risco";
    `);
  }
}
