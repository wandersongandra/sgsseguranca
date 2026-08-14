import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corrige as políticas RLS das 4 tabelas de relatórios fotográficos para não
 * depender de is_super_admin(), que após a migration 361 sempre retorna false
 * para o role sgs_app (pois sgs_rls_bypass foi revogado). Padrão idêntico ao
 * aplicado em companies pela migration 364.
 *
 * Também re-executa o GRANT idempotente de SELECT/INSERT/UPDATE/DELETE para
 * sgs_app, pois o GRANT condicional da migration 204 pode não ter sido
 * executado se sgs_app não existia na época.
 */
export class FixPhotographicReportsRlsSuperAdminFlag1709000000368 implements MigrationInterface {
  name = 'FixPhotographicReportsRlsSuperAdminFlag1709000000368';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // photographic_reports — política direta na tabela
    await queryRunner.query(`
      ALTER POLICY "tenant_isolation_policy" ON "photographic_reports"
        USING (
          company_id = current_company()
          OR (current_setting('app.is_super_admin', true)::boolean = true)
        )
        WITH CHECK (
          company_id = current_company()
          OR (current_setting('app.is_super_admin', true)::boolean = true)
        )
    `);

    // photographic_report_days — EXISTS sobre photographic_reports
    await queryRunner.query(`
      ALTER POLICY "tenant_isolation_policy" ON "photographic_report_days"
        USING (
          EXISTS (
            SELECT 1 FROM photographic_reports pr
            WHERE pr.id = photographic_report_days.report_id
              AND (
                pr.company_id = current_company()
                OR (current_setting('app.is_super_admin', true)::boolean = true)
              )
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM photographic_reports pr
            WHERE pr.id = photographic_report_days.report_id
              AND (
                pr.company_id = current_company()
                OR (current_setting('app.is_super_admin', true)::boolean = true)
              )
          )
        )
    `);

    // photographic_report_images — EXISTS sobre photographic_reports
    await queryRunner.query(`
      ALTER POLICY "tenant_isolation_policy" ON "photographic_report_images"
        USING (
          EXISTS (
            SELECT 1 FROM photographic_reports pr
            WHERE pr.id = photographic_report_images.report_id
              AND (
                pr.company_id = current_company()
                OR (current_setting('app.is_super_admin', true)::boolean = true)
              )
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM photographic_reports pr
            WHERE pr.id = photographic_report_images.report_id
              AND (
                pr.company_id = current_company()
                OR (current_setting('app.is_super_admin', true)::boolean = true)
              )
          )
        )
    `);

    // photographic_report_exports — EXISTS sobre photographic_reports
    await queryRunner.query(`
      ALTER POLICY "tenant_isolation_policy" ON "photographic_report_exports"
        USING (
          EXISTS (
            SELECT 1 FROM photographic_reports pr
            WHERE pr.id = photographic_report_exports.report_id
              AND (
                pr.company_id = current_company()
                OR (current_setting('app.is_super_admin', true)::boolean = true)
              )
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM photographic_reports pr
            WHERE pr.id = photographic_report_exports.report_id
              AND (
                pr.company_id = current_company()
                OR (current_setting('app.is_super_admin', true)::boolean = true)
              )
          )
        )
    `);

    // Re-GRANT idempotente: garante que sgs_app tem as permissões necessárias
    // mesmo que o GRANT condicional da migration 204 não tenha sido executado.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON
            "photographic_reports",
            "photographic_report_days",
            "photographic_report_images",
            "photographic_report_exports"
          TO sgs_app;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restaura as políticas originais com is_super_admin()
    await queryRunner.query(`
      ALTER POLICY "tenant_isolation_policy" ON "photographic_reports"
        USING (company_id = current_company() OR is_super_admin() = true)
        WITH CHECK (company_id = current_company() OR is_super_admin() = true)
    `);

    for (const tableName of [
      'photographic_report_days',
      'photographic_report_images',
      'photographic_report_exports',
    ]) {
      await queryRunner.query(`
        ALTER POLICY "tenant_isolation_policy" ON "${tableName}"
          USING (
            EXISTS (
              SELECT 1 FROM photographic_reports pr
              WHERE pr.id = ${tableName}.report_id
                AND (pr.company_id = current_company() OR is_super_admin() = true)
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1 FROM photographic_reports pr
              WHERE pr.id = ${tableName}.report_id
                AND (pr.company_id = current_company() OR is_super_admin() = true)
            )
          )
      `);
    }
  }
}
