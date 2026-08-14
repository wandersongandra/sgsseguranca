import { MigrationInterface, QueryRunner } from 'typeorm';

type TableNameRow = {
  table_name: string;
};

const isTableNameRow = (value: unknown): value is TableNameRow =>
  typeof value === 'object' &&
  value !== null &&
  'table_name' in value &&
  typeof value.table_name === 'string';

/**
 * O contexto HTTP já carregava `siteIds`, mas o RLS recebia somente o primeiro
 * site em `app.current_site_id`. Isso fazia TST/Supervisor multiobra enxergar
 * apenas uma obra, apesar de a autorização permitir várias. A migration usa
 * uma lista session-scoped e mantém o fallback do site único para jobs legados.
 */
export class EnableMultiSiteRlsScope1709000000367 implements MigrationInterface {
  name = 'EnableMultiSiteRlsScope1709000000367';

  // Cada ALTER POLICY recebe seu próprio commit. Isso evita reter locks de DDL
  // em todas as tabelas multiobra durante a migration inteira.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.current_site_ids()
      RETURNS uuid[] AS $$
      DECLARE
        configured_site_ids text;
        fallback_site_id uuid;
      BEGIN
        configured_site_ids := current_setting('app.current_site_ids', true);
        IF configured_site_ids IS NULL OR btrim(configured_site_ids) = '' THEN
          fallback_site_id := current_site_id();
          IF fallback_site_id IS NULL THEN
            RETURN ARRAY[]::uuid[];
          END IF;
          RETURN ARRAY[fallback_site_id];
        END IF;

        RETURN string_to_array(configured_site_ids, ',')::uuid[];
      EXCEPTION
        WHEN others THEN
          -- Contexto malformado nunca amplia acesso; a policy falha fechada.
          RETURN ARRAY[]::uuid[];
      END;
      $$ LANGUAGE plpgsql STABLE
         SET search_path = public;
    `);

    const siteScopedTablesResult: unknown = await queryRunner.query(`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('company_id', 'site_id')
      GROUP BY table_name
      HAVING COUNT(DISTINCT column_name) = 2
      ORDER BY table_name
    `);
    const siteScopedTables = Array.isArray(siteScopedTablesResult)
      ? siteScopedTablesResult.filter(isTableNameRow)
      : [];

    for (const { table_name: tableName } of siteScopedTables) {
      if (tableName === 'users') {
        continue;
      }
      await this.recreateSiteScopedPolicy(queryRunner, tableName, true);
    }

    await this.recreateUsersPolicy(queryRunner, true);
    await this.recreateSitesPolicies(queryRunner, true);

    if (await this.roleExists(queryRunner, 'sgs_app')) {
      await queryRunner.query(
        `GRANT EXECUTE ON FUNCTION public.current_site_ids() TO sgs_app`,
      );
    }
    await queryRunner.query(`RESET lock_timeout`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    const siteScopedTablesResult: unknown = await queryRunner.query(`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('company_id', 'site_id')
      GROUP BY table_name
      HAVING COUNT(DISTINCT column_name) = 2
      ORDER BY table_name
    `);
    const siteScopedTables = Array.isArray(siteScopedTablesResult)
      ? siteScopedTablesResult.filter(isTableNameRow)
      : [];

    for (const { table_name: tableName } of siteScopedTables) {
      if (tableName === 'users') {
        continue;
      }
      await this.recreateSiteScopedPolicy(queryRunner, tableName, false);
    }

    await this.recreateUsersPolicy(queryRunner, false);
    await this.recreateSitesPolicies(queryRunner, false);

    if (await this.roleExists(queryRunner, 'sgs_app')) {
      await queryRunner.query(
        `REVOKE EXECUTE ON FUNCTION public.current_site_ids() FROM sgs_app`,
      );
    }
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS public.current_site_ids()`,
    );
    await queryRunner.query(`RESET lock_timeout`);
  }

  private async recreateSiteScopedPolicy(
    queryRunner: QueryRunner,
    tableName: string,
    useMultiSiteScope: boolean,
  ): Promise<void> {
    if (!(await queryRunner.hasTable(tableName))) {
      return;
    }

    const table = this.quoteIdentifier(tableName);
    const sitePredicate = useMultiSiteScope
      ? 'site_id = ANY(current_site_ids())'
      : 'site_id = current_site_id()';
    const predicate = `
      is_super_admin() = true
      OR (
        company_id = current_company()
        AND (
          current_site_scope() = 'all'
          OR ${sitePredicate}
        )
      )
    `;

    await this.ensureRlsEnabled(queryRunner, table);
    if (
      await this.policyExists(
        queryRunner,
        tableName,
        'site_scope_isolation_policy',
      )
    ) {
      await queryRunner.query(`
        ALTER POLICY "site_scope_isolation_policy"
        ON ${table}
        USING (${predicate})
        WITH CHECK (${predicate})
      `);
      return;
    }

    await queryRunner.query(`
      CREATE POLICY "site_scope_isolation_policy"
      ON ${table}
      AS RESTRICTIVE
      FOR ALL
      USING (${predicate})
      WITH CHECK (${predicate})
    `);
  }

  private async recreateUsersPolicy(
    queryRunner: QueryRunner,
    useMultiSiteScope: boolean,
  ): Promise<void> {
    if (!(await queryRunner.hasTable('users'))) {
      return;
    }

    const sitePredicate = useMultiSiteScope
      ? 'site_id = ANY(current_site_ids())'
      : 'site_id = current_site_id()';
    const predicate = `
      is_super_admin() = true
      OR (
        company_id = current_company()
        AND (
          current_site_scope() = 'all'
          OR id = current_app_user_id()
          OR site_id IS NULL
          OR ${sitePredicate}
          OR EXISTS (
            SELECT 1 FROM user_sites us
            WHERE us.user_id = current_app_user_id()
              AND us.site_id = users.site_id
          )
        )
      )
    `;
    await this.ensureRlsEnabled(queryRunner, '"users"');
    if (
      await this.policyExists(
        queryRunner,
        'users',
        'users_site_isolation_policy',
      )
    ) {
      await queryRunner.query(`
        ALTER POLICY "users_site_isolation_policy"
        ON "users"
        USING (${predicate})
        WITH CHECK (${predicate})
      `);
      return;
    }

    await queryRunner.query(`
      CREATE POLICY "users_site_isolation_policy"
      ON "users"
      AS RESTRICTIVE
      FOR ALL
      USING (${predicate})
      WITH CHECK (${predicate})
    `);
  }

  private async recreateSitesPolicies(
    queryRunner: QueryRunner,
    useMultiSiteScope: boolean,
  ): Promise<void> {
    if (!(await queryRunner.hasTable('sites'))) {
      return;
    }

    const sitePredicate = useMultiSiteScope
      ? 'id = ANY(current_site_ids())'
      : 'id = current_site_id()';
    const visible = `
      is_super_admin() = true
      OR (
        company_id = current_company()
        AND (
          current_site_scope() = 'all'
          OR ${sitePredicate}
        )
      )
    `;

    await this.ensureRlsEnabled(queryRunner, '"sites"');
    await this.ensureSitesPolicy(
      queryRunner,
      'sites_tenant_select_policy',
      'SELECT',
      visible,
    );
    await this.ensureSitesPolicy(
      queryRunner,
      'sites_tenant_update_policy',
      'UPDATE',
      visible,
    );
    await this.ensureSitesPolicy(
      queryRunner,
      'sites_tenant_delete_policy',
      'DELETE',
      visible,
    );
  }

  private async ensureSitesPolicy(
    queryRunner: QueryRunner,
    policyName: string,
    command: 'SELECT' | 'UPDATE' | 'DELETE',
    predicate: string,
  ): Promise<void> {
    if (await this.policyExists(queryRunner, 'sites', policyName)) {
      const withCheck =
        command === 'UPDATE' ? ` WITH CHECK (${predicate})` : '';
      await queryRunner.query(`
        ALTER POLICY "${policyName}"
        ON "sites"
        USING (${predicate})${withCheck}
      `);
      return;
    }

    const withCheck = command === 'UPDATE' ? ` WITH CHECK (${predicate})` : '';
    await queryRunner.query(`
      CREATE POLICY "${policyName}"
      ON "sites" FOR ${command} USING (${predicate})${withCheck}
    `);
  }

  private async ensureRlsEnabled(
    queryRunner: QueryRunner,
    quotedTableName: string,
  ): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE ${quotedTableName} ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE ${quotedTableName} FORCE ROW LEVEL SECURITY`,
    );
  }

  private async policyExists(
    queryRunner: QueryRunner,
    tableName: string,
    policyName: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = $1
          AND policyname = $2
        LIMIT 1
      `,
      [tableName, policyName],
    )) as Array<Record<string, unknown>>;
    return rows.length > 0;
  }

  private quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private async roleExists(
    queryRunner: QueryRunner,
    roleName: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1`,
      [roleName],
    )) as Array<Record<string, unknown>>;
    return rows.length > 0;
  }
}
