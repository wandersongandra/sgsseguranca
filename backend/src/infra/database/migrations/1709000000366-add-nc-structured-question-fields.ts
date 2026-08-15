import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNcStructuredQuestionFields1709000000366 implements MigrationInterface {
  transaction = false;
  name = 'AddNcStructuredQuestionFields1709000000366';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "tipo_categoria" varchar(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "tipo_subcategoria" varchar(120)`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "causa_categoria" varchar(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "causa_fator_humano" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "causa_fator_equipamento" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "causa_fator_processo" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "causa_fator_ambiente" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "causa_fator_gerencial" boolean`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "requisito_nr_categoria" varchar(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "risco_categoria" varchar(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "risco_fonte" varchar(120)`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "evidencia_descricao_foto" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "evidencia_foto1_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "evidencia_foto2_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "evidencia_foto3_key" text`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "verificacao_descricao_foto" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "verificacao_foto1_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "verificacao_foto2_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" ADD COLUMN IF NOT EXISTS "verificacao_foto3_key" text`,
    );

    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_nonconformities_tipo_categoria" ON "nonconformities" ("tipo_categoria")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_nonconformities_causa_categoria" ON "nonconformities" ("causa_categoria")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_nonconformities_requisito_nr_categoria" ON "nonconformities" ("requisito_nr_categoria")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_nonconformities_risco_categoria" ON "nonconformities" ("risco_categoria")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_nonconformities_risco_categoria"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_nonconformities_requisito_nr_categoria"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_nonconformities_causa_categoria"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_nonconformities_tipo_categoria"`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "verificacao_foto2_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "verificacao_foto3_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "verificacao_foto1_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "verificacao_descricao_foto"`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "evidencia_foto3_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "evidencia_foto2_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "evidencia_foto1_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "evidencia_descricao_foto"`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "risco_fonte"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "risco_categoria"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "requisito_nr_categoria"`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "causa_fator_gerencial"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "causa_fator_ambiente"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "causa_fator_processo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "causa_fator_equipamento"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "causa_fator_humano"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "causa_categoria"`,
    );

    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "tipo_subcategoria"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nonconformities" DROP COLUMN IF EXISTS "tipo_categoria"`,
    );
  }
}
