import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Metadados explícitos para o binding criptográfico de novas assinaturas.
 * Registros históricos permanecem NULL e são reportados como LEGACY, sem
 * backfill fictício.
 */
export class AddAprSignatureContentIntegrity1709000000375 implements MigrationInterface {
  name = 'AddAprSignatureContentIntegrity1709000000375';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "signatures"
        ADD COLUMN IF NOT EXISTS "content_hash" varchar(64),
        ADD COLUMN IF NOT EXISTS "hash_algorithm" varchar(32),
        ADD COLUMN IF NOT EXISTS "canonicalization_version" integer,
        ADD COLUMN IF NOT EXISTS "integrity_scheme" varchar(32)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "signatures"
        DROP COLUMN IF EXISTS "integrity_scheme",
        DROP COLUMN IF EXISTS "canonicalization_version",
        DROP COLUMN IF EXISTS "hash_algorithm",
        DROP COLUMN IF EXISTS "content_hash"
    `);
  }
}
