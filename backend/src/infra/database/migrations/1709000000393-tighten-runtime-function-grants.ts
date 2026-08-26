import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove o grant histórico `EXECUTE ON ALL FUNCTIONS` que o provisionamento
 * antigo podia deixar no role de runtime. O contrato funcional é reaplicado
 * por allowlist, incluindo as funções SECURITY DEFINER já endurecidas na
 * migration 0392.
 */
export class TightenRuntimeFunctionGrants1709000000393 implements MigrationInterface {
  name = 'TightenRuntimeFunctionGrants1709000000393';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM sgs_app`,
    );

    for (const statement of [
      `GRANT EXECUTE ON FUNCTION public.current_company() TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.is_super_admin() TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.current_user_role() TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.current_site_id() TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.current_site_scope() TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.current_site_ids() TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.try_parse_uuid(text) TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.find_login_user(text, text) TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.update_login_user_password_hash(uuid, text) TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.find_user_bridge(uuid, uuid) TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.reset_login_user_password(uuid, text) TO sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.verify_signature_by_hash_public(text) TO sgs_app`,
    ]) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM sgs_app`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO sgs_app`,
    );
  }
}
