import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permite a validação pública de evidência sem depender de um GUC de
 * super-admin na sessão de aplicação. O retorno é deliberadamente mínimo:
 * somente informa se o hash corresponde ao original ou à marca d'água.
 */
export class CreatePublicAprEvidenceVerifyFunction1709000000396 implements MigrationInterface {
  name = 'CreatePublicAprEvidenceVerifyFunction1709000000396';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      GRANT SELECT ON TABLE public.apr_risk_evidences TO sgs_function_owner
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.verify_apr_evidence_by_hash_public(
        p_hash text
      )
      RETURNS TABLE (matched_in text)
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
        SELECT CASE
          WHEN e.hash_sha256 = p_hash THEN 'original'::text
          ELSE 'watermarked'::text
        END AS matched_in
        FROM public.apr_risk_evidences AS e
        WHERE p_hash ~ '^[a-f0-9]{64}$'
          AND (
            e.hash_sha256 = p_hash
            OR e.watermarked_hash_sha256 = p_hash
          )
        ORDER BY CASE WHEN e.hash_sha256 = p_hash THEN 0 ELSE 1 END
        LIMIT 1;
      $$;
    `);

    await queryRunner.query(`
      ALTER FUNCTION public.verify_apr_evidence_by_hash_public(text)
      OWNER TO sgs_function_owner
    `);

    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION public.verify_apr_evidence_by_hash_public(text)
      FROM PUBLIC, sgs_admin
    `);

    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.verify_apr_evidence_by_hash_public(text)
      TO sgs_app
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION public.verify_apr_evidence_by_hash_public(text)
      FROM PUBLIC, sgs_app, sgs_admin
    `);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS public.verify_apr_evidence_by_hash_public(text)`,
    );
    await queryRunner.query(
      `REVOKE SELECT ON TABLE public.apr_risk_evidences FROM sgs_function_owner`,
    );
  }
}
