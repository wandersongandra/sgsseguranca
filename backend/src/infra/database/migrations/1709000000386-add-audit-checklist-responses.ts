import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuditChecklistResponses1709000000386 implements MigrationInterface {
  name = 'AddAuditChecklistResponses1709000000386';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audits"
      ADD COLUMN IF NOT EXISTS "checklist_respostas" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audits"
      DROP COLUMN IF EXISTS "checklist_respostas"
    `);
  }
}
