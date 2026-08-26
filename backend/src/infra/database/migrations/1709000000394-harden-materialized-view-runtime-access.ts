import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove as materialized views cross-tenant do alcance do runtime comum.
 *
 * Elas são snapshots globais sem RLS próprio. O acesso administrativo passa
 * pela conexão dedicada `sgs_admin`, com a flag de sessão já protegida por
 * membership em `sgs_rls_bypass`; `sgs_app` não recebe SELECT nem ownership.
 */
export class HardenMaterializedViewRuntimeAccess1709000000394 implements MigrationInterface {
  name = 'HardenMaterializedViewRuntimeAccess1709000000394';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin') THEN
          IF to_regclass('public.company_dashboard_metrics') IS NOT NULL THEN
            ALTER MATERIALIZED VIEW public.company_dashboard_metrics OWNER TO sgs_admin;
            REVOKE ALL PRIVILEGES ON TABLE public.company_dashboard_metrics FROM PUBLIC, sgs_app;
            GRANT SELECT ON TABLE public.company_dashboard_metrics TO sgs_admin;
          END IF;

          IF to_regclass('public.apr_risk_rankings') IS NOT NULL THEN
            ALTER MATERIALIZED VIEW public.apr_risk_rankings OWNER TO sgs_admin;
            REVOKE ALL PRIVILEGES ON TABLE public.apr_risk_rankings FROM PUBLIC, sgs_app;
            GRANT SELECT ON TABLE public.apr_risk_rankings TO sgs_admin;
          END IF;

          IF to_regclass('public.companies') IS NOT NULL THEN
            GRANT SELECT ON TABLE public.companies TO sgs_admin;
          END IF;
          IF to_regclass('public.aprs') IS NOT NULL THEN
            GRANT SELECT ON TABLE public.aprs TO sgs_admin;
          END IF;
          IF to_regclass('public.pts') IS NOT NULL THEN
            GRANT SELECT ON TABLE public.pts TO sgs_admin;
          END IF;
          IF to_regclass('public.nonconformities') IS NOT NULL THEN
            GRANT SELECT ON TABLE public.nonconformities TO sgs_admin;
          END IF;
          IF to_regclass('public.trainings') IS NOT NULL THEN
            GRANT SELECT ON TABLE public.trainings TO sgs_admin;
          END IF;
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Não reabre acesso cross-tenant ao runtime em rollback automático.
  }
}
