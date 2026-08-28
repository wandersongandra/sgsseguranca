import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove a flag de sessão como fonte independente de autoridade global na
 * policy de companies. A policy dedicada de sgs_admin permanece inalterada;
 * sgs_app só pode sair do próprio tenant quando a função role-gated permitir.
 *
 * O down preserva a mesma postura segura. Reverter para current_setting()
 * reabriria o finding que esta migration fecha.
 */
export class RemoveMutableSuperAdminPolicyAuthority1709000000397 implements MigrationInterface {
  name = 'RemoveMutableSuperAdminPolicyAuthority1709000000397';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY "companies_tenant_isolation" ON public."companies"
        USING (
          ("id" = public.current_company())
          OR (public.is_super_admin() = true)
        )
        WITH CHECK (
          ("id" = public.current_company())
          OR (public.is_super_admin() = true)
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY "companies_tenant_isolation" ON public."companies"
        USING (
          ("id" = public.current_company())
          OR (public.is_super_admin() = true)
        )
        WITH CHECK (
          ("id" = public.current_company())
          OR (public.is_super_admin() = true)
        )
    `);
  }
}
