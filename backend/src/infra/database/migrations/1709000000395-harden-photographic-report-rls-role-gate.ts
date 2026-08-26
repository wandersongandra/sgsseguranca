import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A flag `app.is_super_admin` sozinha não é autorização: uma sessão SQL pode
 * tentar definir uma GUC customizada. As políticas fotográficas precisam usar
 * `is_super_admin()`, que também exige membership em `sgs_rls_bypass`.
 */
export class HardenPhotographicReportRlsRoleGate1709000000395 implements MigrationInterface {
  name = 'HardenPhotographicReportRlsRoleGate1709000000395';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.photographic_reports') IS NOT NULL THEN
          DROP POLICY IF EXISTS tenant_isolation_policy
            ON public.photographic_reports;
          CREATE POLICY tenant_isolation_policy
            ON public.photographic_reports
            FOR ALL TO sgs_app
            USING (
              company_id = current_company()
              OR is_super_admin() = true
            )
            WITH CHECK (
              company_id = current_company()
              OR is_super_admin() = true
            );
        END IF;

        IF to_regclass('public.photographic_report_days') IS NOT NULL THEN
          DROP POLICY IF EXISTS tenant_isolation_policy
            ON public.photographic_report_days;
          CREATE POLICY tenant_isolation_policy
            ON public.photographic_report_days
            FOR ALL TO sgs_app
            USING (
              EXISTS (
                SELECT 1
                FROM public.photographic_reports pr
                WHERE pr.id = photographic_report_days.report_id
                  AND (
                    pr.company_id = current_company()
                    OR is_super_admin() = true
                  )
              )
            )
            WITH CHECK (
              EXISTS (
                SELECT 1
                FROM public.photographic_reports pr
                WHERE pr.id = photographic_report_days.report_id
                  AND (
                    pr.company_id = current_company()
                    OR is_super_admin() = true
                  )
              )
            );
        END IF;

        IF to_regclass('public.photographic_report_images') IS NOT NULL THEN
          DROP POLICY IF EXISTS tenant_isolation_policy
            ON public.photographic_report_images;
          CREATE POLICY tenant_isolation_policy
            ON public.photographic_report_images
            FOR ALL TO sgs_app
            USING (
              EXISTS (
                SELECT 1
                FROM public.photographic_reports pr
                WHERE pr.id = photographic_report_images.report_id
                  AND (
                    pr.company_id = current_company()
                    OR is_super_admin() = true
                  )
              )
            )
            WITH CHECK (
              EXISTS (
                SELECT 1
                FROM public.photographic_reports pr
                WHERE pr.id = photographic_report_images.report_id
                  AND (
                    pr.company_id = current_company()
                    OR is_super_admin() = true
                  )
              )
            );
        END IF;

        IF to_regclass('public.photographic_report_exports') IS NOT NULL THEN
          DROP POLICY IF EXISTS tenant_isolation_policy
            ON public.photographic_report_exports;
          CREATE POLICY tenant_isolation_policy
            ON public.photographic_report_exports
            FOR ALL TO sgs_app
            USING (
              EXISTS (
                SELECT 1
                FROM public.photographic_reports pr
                WHERE pr.id = photographic_report_exports.report_id
                  AND (
                    pr.company_id = current_company()
                    OR is_super_admin() = true
                  )
              )
            )
            WITH CHECK (
              EXISTS (
                SELECT 1
                FROM public.photographic_reports pr
                WHERE pr.id = photographic_report_exports.report_id
                  AND (
                    pr.company_id = current_company()
                    OR is_super_admin() = true
                  )
              )
            );
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Não restaura policies que aceitam uma GUC sem validação de role.
  }
}
