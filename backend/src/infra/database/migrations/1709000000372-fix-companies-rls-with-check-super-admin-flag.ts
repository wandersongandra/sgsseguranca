import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fecha a metade que a migration 364 deixou para trás.
 *
 * A 364 corrigiu a policy `companies_tenant_isolation` trocando
 * `is_super_admin()` (inerte para `sgs_app` desde a 361) pela leitura direta da
 * flag de sessão — mas só no `USING`. `ALTER POLICY ... USING (...)` não toca no
 * `WITH CHECK`, então o predicado de **escrita** continuou exigindo
 * `is_super_admin()`.
 *
 * Consequência: `sgs_app` passou a LER todas as empresas (o que a 364 queria) e
 * seguiu sem conseguir ESCREVER em nenhuma fora do próprio tenant. Como
 * `WITH CHECK` é avaliado na linha resultante de INSERT/UPDATE, todo o ciclo de
 * vida comercial do tenant parava em silêncio — sem erro, com `affected = 0`:
 *
 *   - `markExpiredTrials()` — trials nunca eram marcados como expirados;
 *   - `activateTenant()` — empresa não saía de trial para `active`;
 *   - `extendTrial()` / `resetTrial()` — idem;
 *   - provisionamento de tenant — o INSERT da empresa nova era barrado.
 *
 * Todas essas chamadas rodam sem `current_company()` (jobs agendados e rotas de
 * ADMIN_GERAL, que está em GLOBAL_TENANT_OPTIONAL_PATHS), então caíam
 * exatamente no ramo quebrado.
 *
 * Simetria é deliberada: `USING` e `WITH CHECK` passam a usar o mesmo
 * predicado. Assimetria entre leitura e escrita numa policy é o tipo de coisa
 * que só aparece em produção, meses depois, como "o botão não faz nada".
 *
 * Nota de risco, para quem revisar: isto NÃO afrouxa o isolamento além do que a
 * 364 já decidiu. A flag `app.is_super_admin` só é setada pelo
 * `TenantDbContextService` quando o principal autenticado é ADMIN_GERAL, ou
 * explicitamente por serviços de sistema. `companies` foi conscientemente
 * classificada como tabela de baixo risco nessa troca (ela não guarda PII de
 * trabalhador); tabelas sensíveis — `users`, `aprs` etc. — mantêm o gate por
 * papel de propósito, e para elas o caminho correto continua sendo a conexão
 * privilegiada `sgs_admin`.
 */
export class FixCompaniesRlsWithCheckSuperAdminFlag1709000000372 implements MigrationInterface {
  name = 'FixCompaniesRlsWithCheckSuperAdminFlag1709000000372';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename = 'companies'
             AND policyname = 'companies_tenant_isolation'
        ) THEN
          ALTER POLICY companies_tenant_isolation ON "companies"
            USING (
              (id = current_company())
              OR (current_setting('app.is_super_admin', true)::boolean = true)
            )
            WITH CHECK (
              (id = current_company())
              OR (current_setting('app.is_super_admin', true)::boolean = true)
            );
        END IF;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Restaura o estado pós-364: USING com a flag, WITH CHECK com a função.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename = 'companies'
             AND policyname = 'companies_tenant_isolation'
        ) THEN
          ALTER POLICY companies_tenant_isolation ON "companies"
            USING (
              (id = current_company())
              OR (current_setting('app.is_super_admin', true)::boolean = true)
            )
            WITH CHECK (
              (id = current_company())
              OR (is_super_admin() = true)
            );
        END IF;
      END $$;
    `);
  }
}
