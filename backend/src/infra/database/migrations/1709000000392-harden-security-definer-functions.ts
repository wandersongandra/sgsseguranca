import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-011 — hardening das funções SECURITY DEFINER.
 *
 * As funções de autenticação e validação pública precisam atravessar RLS em
 * pontos muito específicos, mas não devem ser propriedade do superusuário de
 * migração nem resolver objetos por search_path controlável. O owner dedicado
 * é NOLOGIN, não é superusuário e recebe somente os privilégios de leitura e
 * atualização necessários às cinco funções aprovadas.
 */
export class HardenSecurityDefinerFunctions1709000000392 implements MigrationInterface {
  name = 'HardenSecurityDefinerFunctions1709000000392';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'sgs_function_owner'
        ) THEN
          CREATE ROLE sgs_function_owner
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOINHERIT
            BYPASSRLS;
        ELSE
          ALTER ROLE sgs_function_owner
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOINHERIT
            BYPASSRLS;
        END IF;
      END $$;
    `);

    await queryRunner.query(
      `GRANT USAGE ON SCHEMA public TO sgs_function_owner`,
    );
    await queryRunner.query(`
      GRANT SELECT ON TABLE
        public.users,
        public.profiles,
        public.user_sites,
        public.signatures
      TO sgs_function_owner
    `);
    await queryRunner.query(`
      GRANT UPDATE (password, must_change_password)
      ON TABLE public.users TO sgs_function_owner
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.find_login_user(
        p_cpf_hash text,
        p_cpf_legacy text DEFAULT NULL
      )
      RETURNS TABLE (
        id uuid,
        nome character varying,
        cpf character varying,
        cpf_ciphertext text,
        email character varying,
        funcao character varying,
        password character varying,
        auth_user_id uuid,
        company_id uuid,
        site_id uuid,
        profile_id uuid,
        status boolean,
        must_change_password boolean,
        profile_nome character varying
      )
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
        SELECT
          u.id,
          u.nome,
          u.cpf,
          u.cpf_ciphertext,
          u.email,
          u.funcao,
          u.password,
          u.auth_user_id,
          u.company_id,
          u.site_id,
          u.profile_id,
          u.status,
          u.must_change_password,
          p.nome AS profile_nome
        FROM public.users AS u
        LEFT JOIN public.profiles AS p ON p.id = u.profile_id
        WHERE (
          u.cpf_hash = p_cpf_hash
          OR (p_cpf_legacy IS NOT NULL AND u.cpf = p_cpf_legacy)
        )
          AND u.deleted_at IS NULL
        LIMIT 1;
      $$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.update_login_user_password_hash(
        p_user_id uuid,
        p_new_hash text
      )
      RETURNS void
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
        UPDATE public.users AS u
        SET password = p_new_hash
        WHERE u.id = p_user_id
          AND u.deleted_at IS NULL;
      $$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.find_user_bridge(
        p_app_user_id uuid DEFAULT NULL,
        p_auth_user_id uuid DEFAULT NULL
      )
      RETURNS TABLE (
        id uuid,
        auth_user_id uuid,
        cpf character varying,
        cpf_ciphertext text,
        company_id uuid,
        site_id uuid,
        site_ids uuid[],
        profile_nome character varying
      )
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
        SELECT
          u.id,
          u.auth_user_id,
          u.cpf,
          u.cpf_ciphertext,
          u.company_id,
          u.site_id,
          COALESCE(
            ARRAY_AGG(us.site_id ORDER BY us.created_at)
              FILTER (WHERE us.site_id IS NOT NULL),
            ARRAY[]::uuid[]
          ) AS site_ids,
          p.nome AS profile_nome
        FROM public.users AS u
        LEFT JOIN public.profiles AS p ON p.id = u.profile_id
        LEFT JOIN public.user_sites AS us
          ON us.user_id = u.id
         AND us.company_id = u.company_id
        WHERE u.status = true
          AND u.deleted_at IS NULL
          AND (
            (p_auth_user_id IS NOT NULL AND u.auth_user_id = p_auth_user_id)
            OR (p_app_user_id IS NOT NULL AND u.id = p_app_user_id)
          )
        GROUP BY
          u.id, u.auth_user_id, u.cpf, u.cpf_ciphertext,
          u.company_id, u.site_id, p.nome
        ORDER BY
          CASE
            WHEN p_auth_user_id IS NOT NULL AND u.auth_user_id = p_auth_user_id
              THEN 0
            ELSE 1
          END
        LIMIT 1;
      $$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.reset_login_user_password(
        p_user_id uuid,
        p_new_hash text
      )
      RETURNS TABLE (user_id uuid, company_id uuid)
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
        UPDATE public.users AS u
        SET password = p_new_hash,
            must_change_password = false
        WHERE u.id = p_user_id
          AND u.deleted_at IS NULL
        RETURNING u.id, u.company_id;
      $$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.verify_signature_by_hash_public(
        p_hash text
      )
      RETURNS TABLE (
        signature_hash text,
        signed_at timestamptz,
        timestamp_authority text,
        type text,
        timestamp_token text,
        integrity_payload jsonb
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
      BEGIN
        IF NOT (p_hash ~ '^[a-f0-9]{64}$') THEN
          RETURN;
        END IF;

        RETURN QUERY
        SELECT
          s.signature_hash::text,
          s.signed_at AT TIME ZONE 'UTC',
          s.timestamp_authority::text,
          s.type::text,
          s.timestamp_token::text,
          s.integrity_payload
        FROM public.signatures AS s
        WHERE s.signature_hash = p_hash
          AND s.deleted_at IS NULL
        LIMIT 1;
      END;
      $$;
    `);

    for (const statement of [
      `ALTER FUNCTION public.find_login_user(text, text) OWNER TO sgs_function_owner`,
      `ALTER FUNCTION public.update_login_user_password_hash(uuid, text) OWNER TO sgs_function_owner`,
      `ALTER FUNCTION public.find_user_bridge(uuid, uuid) OWNER TO sgs_function_owner`,
      `ALTER FUNCTION public.reset_login_user_password(uuid, text) OWNER TO sgs_function_owner`,
      `ALTER FUNCTION public.verify_signature_by_hash_public(text) OWNER TO sgs_function_owner`,
    ]) {
      await queryRunner.query(statement);
    }

    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION
        public.find_login_user(text, text),
        public.update_login_user_password_hash(uuid, text),
        public.find_user_bridge(uuid, uuid),
        public.reset_login_user_password(uuid, text),
        public.verify_signature_by_hash_public(text)
      FROM PUBLIC, sgs_admin
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION
        public.find_login_user(text, text),
        public.update_login_user_password_hash(uuid, text),
        public.find_user_bridge(uuid, uuid),
        public.reset_login_user_password(uuid, text),
        public.verify_signature_by_hash_public(text)
      TO sgs_app
    `);

    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION
        public.gdpr_delete_user_data(uuid),
        public.cleanup_expired_data()
      FROM PUBLIC, sgs_app
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION
        public.gdpr_delete_user_data(uuid),
        public.cleanup_expired_data()
      TO sgs_admin
    `);

    for (const role of ['sgs_migrator', 'neondb_owner']) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE ${role} IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM sgs_app';
          END IF;
        END $$;
      `);
    }

    // Reaplica somente o contrato de funções que o runtime realmente usa.
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
    ]) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const statement of [
      `ALTER FUNCTION public.find_login_user(text, text) OWNER TO sgs_migrator`,
      `ALTER FUNCTION public.update_login_user_password_hash(uuid, text) OWNER TO sgs_migrator`,
      `ALTER FUNCTION public.find_user_bridge(uuid, uuid) OWNER TO sgs_migrator`,
      `ALTER FUNCTION public.reset_login_user_password(uuid, text) OWNER TO sgs_migrator`,
      `ALTER FUNCTION public.verify_signature_by_hash_public(text) OWNER TO sgs_migrator`,
      `REVOKE EXECUTE ON FUNCTION public.find_login_user(text, text), public.update_login_user_password_hash(uuid, text), public.find_user_bridge(uuid, uuid), public.reset_login_user_password(uuid, text), public.verify_signature_by_hash_public(text) FROM sgs_app`,
      `GRANT EXECUTE ON FUNCTION public.find_login_user(text, text), public.update_login_user_password_hash(uuid, text), public.find_user_bridge(uuid, uuid), public.reset_login_user_password(uuid, text), public.verify_signature_by_hash_public(text) TO sgs_app`,
    ]) {
      await queryRunner.query(statement);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_function_owner') THEN
          DROP OWNED BY sgs_function_owner;
          DROP ROLE sgs_function_owner;
        END IF;
      END $$;
    `);
  }
}
