import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPhotoConditionsToReportImages1709000000369 implements MigrationInterface {
  name = 'AddPhotoConditionsToReportImages1709000000369';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "photographic_report_images"
        ADD COLUMN IF NOT EXISTS "photo_conditions" jsonb NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "photographic_report_images"
        DROP COLUMN IF EXISTS "photo_conditions"
    `);
  }
}
