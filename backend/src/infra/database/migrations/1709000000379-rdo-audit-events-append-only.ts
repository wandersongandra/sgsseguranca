import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SGS-RDO-INT-001 — rdo_audit_events é append-only mas a migration 187 instalou
 * as policies rls_parent_tenant_update e rls_parent_tenant_delete via template
 * genérico, tornando a trilha mutável para qualquer sessão de runtime com o
 * tenant correto. Esta migration:
 *   1. Dropa as policies UPDATE e DELETE (SELECT e INSERT ficam).
 *   2. Revoga UPDATE e DELETE do role sgs_app na tabela.
 *   3. Instala trigger append-only idêntico ao já existente em forensic_trail_events.
 */
export class RdoAuditEventsAppendOnly1709000000379 implements MigrationInterface {
  name = 'RdoAuditEventsAppendOnly1709000000379';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      queryRunner.connection.options.type === 'sqlite' ||
      queryRunner.connection.options.type === 'better-sqlite3'
    ) {
      return;
    }

    // 1. Remove as políticas RLS que permitiam UPDATE e DELETE
    await queryRunner.query(`
      DROP POLICY IF EXISTS "rls_parent_tenant_update" ON "rdo_audit_events";
    `);
    await queryRunner.query(`
      DROP POLICY IF EXISTS "rls_parent_tenant_delete" ON "rdo_audit_events";
    `);

    // 2. Revoga os privilégios de modificação do role de runtime
    await queryRunner.query(`
      REVOKE UPDATE, DELETE ON "rdo_audit_events" FROM sgs_app;
    `);

    // 3. Instala trigger append-only (mesmo padrão de forensic_trail_events)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.prevent_rdo_audit_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        RAISE EXCEPTION 'rdo_audit_events is append-only — updates and deletes are not allowed';
      END;
      $$;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_rdo_audit_events_append_only"
        BEFORE UPDATE OR DELETE ON "rdo_audit_events"
        FOR EACH ROW EXECUTE FUNCTION public.prevent_rdo_audit_mutation();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (
      queryRunner.connection.options.type === 'sqlite' ||
      queryRunner.connection.options.type === 'better-sqlite3'
    ) {
      return;
    }

    // Restaura o estado anterior (políticas e privilégios voltam)
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_rdo_audit_events_append_only" ON "rdo_audit_events";
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.prevent_rdo_audit_mutation();
    `);
    await queryRunner.query(`
      GRANT UPDATE, DELETE ON "rdo_audit_events" TO sgs_app;
    `);
    await queryRunner.query(`
      CREATE POLICY "rls_parent_tenant_update" ON "rdo_audit_events"
        FOR UPDATE
        USING (EXISTS (
          SELECT 1 FROM rdos p
          WHERE p.id = rdo_audit_events.rdo_id
            AND (p.company_id = current_setting('app.current_company_id', true)::uuid
                 OR current_setting('app.is_super_admin', true) = 'true')
        ))
        WITH CHECK (EXISTS (
          SELECT 1 FROM rdos p
          WHERE p.id = rdo_audit_events.rdo_id
            AND (p.company_id = current_setting('app.current_company_id', true)::uuid
                 OR current_setting('app.is_super_admin', true) = 'true')
        ));
    `);
    await queryRunner.query(`
      CREATE POLICY "rls_parent_tenant_delete" ON "rdo_audit_events"
        FOR DELETE
        USING (EXISTS (
          SELECT 1 FROM rdos p
          WHERE p.id = rdo_audit_events.rdo_id
            AND (p.company_id = current_setting('app.current_company_id', true)::uuid
                 OR current_setting('app.is_super_admin', true) = 'true')
        ));
    `);
  }
}
