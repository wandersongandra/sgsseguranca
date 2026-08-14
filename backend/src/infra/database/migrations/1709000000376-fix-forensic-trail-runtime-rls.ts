import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corrige o INSERT da trilha forense para exigir contexto tenant explícito.
 * A policy permissiva anterior (1709000000360) usava WITH CHECK (true), mas
 * também existia uma policy restritiva; isso quebrava o login sem ALS e não
 * expressava corretamente a regra de contexto ausente = deny.
 */
export class FixForensicTrailRuntimeRls1709000000376 implements MigrationInterface {
  name = 'FixForensicTrailRuntimeRls1709000000376';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('forensic_trail_events'))) return;

    await queryRunner.query(`
      DROP POLICY IF EXISTS "forensic_trail_events_insert"
      ON "forensic_trail_events"
    `);
    await queryRunner.query(`
      CREATE POLICY "forensic_trail_events_insert"
      ON "forensic_trail_events"
      AS PERMISSIVE
      FOR INSERT
      TO sgs_app
      WITH CHECK (
        company_id IS NOT NULL
        AND (company_id)::text = (current_company())::text
      )
    `);

    await queryRunner.query(`
      DROP POLICY IF EXISTS "forensic_trail_events_select"
      ON "forensic_trail_events"
    `);
    await queryRunner.query(`
      CREATE POLICY "forensic_trail_events_select"
      ON "forensic_trail_events"
      AS PERMISSIVE
      FOR SELECT
      TO sgs_app
      USING (
        company_id IS NOT NULL
        AND (company_id)::text = (current_company())::text
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('forensic_trail_events'))) return;

    await queryRunner.query(`
      DROP POLICY IF EXISTS "forensic_trail_events_insert"
      ON "forensic_trail_events"
    `);
    await queryRunner.query(`
      CREATE POLICY "forensic_trail_events_insert"
      ON "forensic_trail_events"
      AS PERMISSIVE
      FOR INSERT
      TO sgs_app
      WITH CHECK (true)
    `);

    await queryRunner.query(`
      DROP POLICY IF EXISTS "forensic_trail_events_select"
      ON "forensic_trail_events"
    `);
    await queryRunner.query(`
      CREATE POLICY "forensic_trail_events_select"
      ON "forensic_trail_events"
      AS PERMISSIVE
      FOR SELECT
      TO sgs_app
      USING (
        company_id = current_company()
        OR company_id IS NULL
        OR is_super_admin() = true
      )
    `);
  }
}
