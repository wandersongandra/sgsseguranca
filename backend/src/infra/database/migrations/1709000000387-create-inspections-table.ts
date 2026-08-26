import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reconciles the Inspection entity with clean database rebuilds.
 *
 * Some older environments already contained `inspections` outside the
 * migration chain. The conditional creation preserves those installations
 * while making a new database complete and tenant/site isolated.
 */
export class CreateInspectionsTable1709000000387 implements MigrationInterface {
  name = 'CreateInspectionsTable1709000000387';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inspections" (
        "id" uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
        "company_id" uuid NOT NULL,
        "site_id" uuid NOT NULL,
        "setor_area" varchar NOT NULL,
        "tipo_inspecao" varchar NOT NULL,
        "data_inspecao" date NOT NULL,
        "horario" varchar NOT NULL,
        "responsavel_id" uuid NOT NULL,
        "objetivo" text NULL,
        "descricao_local_atividades" text NULL,
        "metodologia" jsonb NULL,
        "perigos_riscos" jsonb NULL,
        "plano_acao" jsonb NULL,
        "evidencias" jsonb NULL,
        "conclusao" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz NULL,
        CONSTRAINT "FK_inspections_company_id" FOREIGN KEY ("company_id") REFERENCES "companies"("id"),
        CONSTRAINT "FK_inspections_site_id" FOREIGN KEY ("site_id") REFERENCES "sites"("id"),
        CONSTRAINT "FK_inspections_responsavel_id" FOREIGN KEY ("responsavel_id") REFERENCES "users"("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_inspections_company_site_deleted"
      ON "inspections" ("company_id", "site_id", "deleted_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_inspections_responsavel"
      ON "inspections" ("responsavel_id")
    `);

    await queryRunner.query(
      `ALTER TABLE "inspections" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "inspections" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS "tenant_isolation_policy" ON "inspections"`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS "site_scope_isolation_policy" ON "inspections"`,
    );
    await queryRunner.query(`
      CREATE POLICY "site_scope_isolation_policy"
      ON "inspections"
      AS RESTRICTIVE
      FOR ALL
      USING (
        is_super_admin() = true
        OR (
          company_id = current_company()
          AND (
            current_site_scope() = 'all'
            OR site_id = ANY(current_site_ids())
          )
        )
      )
      WITH CHECK (
        is_super_admin() = true
        OR (
          company_id = current_company()
          AND (
            current_site_scope() = 'all'
            OR site_id = ANY(current_site_ids())
          )
        )
      )
    `);

    await queryRunner.query(`
      DO $do$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_app') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inspections" TO sgs_app;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inspections" TO sgs_admin;
        END IF;
      END
      $do$
    `);
  }

  public async down(): Promise<void> {
    // Intentionally non-destructive: older production databases may have
    // received this table outside the migration chain.
  }
}
