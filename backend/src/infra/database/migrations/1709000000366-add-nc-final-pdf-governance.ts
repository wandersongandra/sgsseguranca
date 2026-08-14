import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migração: governança do PDF final oficial da Não Conformidade (NC).
 *
 * - final_pdf_hash_sha256: SHA-256 (hex) do PDF final, computado server-side em
 *   NonConformitiesPdfService.generateFinalPdf via DocumentGovernanceService.
 *   Espelha final_pdf_hash_sha256 de aprs/pts/dds.
 * - verification_code: código público de verificação da NC (portal /validar).
 * - pdf_generated_at: timestamp da última emissão/regeneração do PDF final.
 *
 * Todas nullable; RLS herdada da tabela nonconformities (company_id).
 * Sem índices: consultadas apenas no fetch da própria NC / registro governado.
 */
export class AddNcFinalPdfGovernance1709000000366 implements MigrationInterface {
  name = 'AddNcFinalPdfGovernance1709000000366';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await queryRunner.hasTable('nonconformities');
    if (!tableExists) {
      console.warn(
        'Table nonconformities not found, skipping final PDF governance columns',
      );
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "nonconformities"
      ADD COLUMN IF NOT EXISTS "final_pdf_hash_sha256" varchar(64),
      ADD COLUMN IF NOT EXISTS "verification_code" varchar(24),
      ADD COLUMN IF NOT EXISTS "pdf_generated_at" timestamp
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await queryRunner.hasTable('nonconformities');
    if (!tableExists) {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "nonconformities"
      DROP COLUMN IF EXISTS "final_pdf_hash_sha256",
      DROP COLUMN IF EXISTS "verification_code",
      DROP COLUMN IF EXISTS "pdf_generated_at"
    `);
  }
}
