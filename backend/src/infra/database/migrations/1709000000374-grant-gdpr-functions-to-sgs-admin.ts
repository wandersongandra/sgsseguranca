import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Devolve a capacidade de executar as funções de GDPR à conexão privilegiada.
 *
 * ## O que estava acontecendo
 *
 * A migration `341` (`RevokeGdprFunctionsFromPublic`) revogou `EXECUTE` de
 * `PUBLIC` sobre `gdpr_delete_user_data()` e `cleanup_expired_data()`, deixando
 * apenas o dono (`neondb_owner`). Correto como hardening — funções que
 * anonimizam ou apagam dados em massa não devem ser executáveis por qualquer
 * papel.
 *
 * O problema é que, naquele momento, o runtime de produção **era**
 * `neondb_owner`. A revogação não teve efeito prático e ninguém percebeu que a
 * aplicação passara a depender de ser dona das funções.
 *
 * Em 2026-07-25, o hardening de RLS trocou o runtime para `sgs_app`. A partir
 * dali as duas chamadas passaram a dar `permission denied for function`:
 *
 *   - `deleteExpiredData()` — a política de retenção parou de rodar. Evidência
 *     no banco: `gdpr_retention_cleanup_runs` tem 71 execuções e a última é de
 *     2026-07-24 23:30, véspera exata da troca. Nada desde então.
 *   - `deleteUserData()` — o direito de exclusão da LGPD (Art. 18, VI) ficaria
 *     inoperante. Não houve dano porque `gdpr_deletion_requests` está vazia: a
 *     funcionalidade nunca foi exercida em produção.
 *
 * ## A correção
 *
 * `GRANT EXECUTE` para `sgs_admin` — o papel da conexão privilegiada
 * (`DATABASE_ADMIN_URL`), membro de `sgs_rls_bypass`, já com os GRANTs de
 * tabela necessários em `users`, `audit_logs`, `user_sessions`,
 * `document_registry`, `ai_interactions`, `user_consents` e
 * `apr_risk_evidences`.
 *
 * **Deliberadamente NÃO concedido a `sgs_app`.** Duas razões:
 *
 *  1. Mesmo com EXECUTE, `sgs_app` não conseguiria fazer o trabalho: as funções
 *     não são `SECURITY DEFINER`, rodam com o privilégio do chamador, e desde a
 *     migration 361 `is_super_admin()` é falso para `sgs_app` — o FORCE RLS das
 *     tabelas alvo filtraria as linhas e a anonimização afetaria 0 registros.
 *  2. Conceder ao papel de runtime daria a qualquer sessão da aplicação a
 *     capacidade de disparar anonimização em massa. É exatamente o que a
 *     migration 341 quis impedir.
 *
 * Também foi considerado — e descartado — tornar as funções `SECURITY DEFINER`.
 * Elas rodariam como `neondb_owner` (dono do banco), ampliando muito a
 * superfície de escalonamento para ganhar nada: a conexão `sgs_admin` já existe
 * exatamente para este tipo de operação.
 *
 * Sem DDL de schema: apenas GRANT. Idempotente e reversível.
 */
export class GrantGdprFunctionsToSgsAdmin1709000000374 implements MigrationInterface {
  name = 'GrantGdprFunctionsToSgsAdmin1709000000374';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `to_regprocedure` e nao `pg_proc.proname`: o nome sozinho casa com
    // qualquer sobrecarga. Se existisse `gdpr_delete_user_data(text)` alem da
    // de `uuid`, a checagem por nome passaria e o GRANT seguinte falharia com
    // "function does not exist" — abortando a migration por um motivo que o
    // erro nao explica. `to_regprocedure` devolve NULL quando a assinatura
    // exata nao existe, sem lancar.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin') THEN
          RAISE NOTICE 'Role sgs_admin inexistente — GRANT ignorado.';
          RETURN;
        END IF;

        IF to_regprocedure('public.gdpr_delete_user_data(uuid)') IS NOT NULL THEN
          EXECUTE 'GRANT EXECUTE ON FUNCTION public.gdpr_delete_user_data(uuid) TO sgs_admin';
        ELSE
          RAISE NOTICE 'public.gdpr_delete_user_data(uuid) inexistente — GRANT ignorado.';
        END IF;

        IF to_regprocedure('public.cleanup_expired_data()') IS NOT NULL THEN
          EXECUTE 'GRANT EXECUTE ON FUNCTION public.cleanup_expired_data() TO sgs_admin';
        ELSE
          RAISE NOTICE 'public.cleanup_expired_data() inexistente — GRANT ignorado.';
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin') THEN
          RETURN;
        END IF;

        IF to_regprocedure('public.gdpr_delete_user_data(uuid)') IS NOT NULL THEN
          EXECUTE 'REVOKE EXECUTE ON FUNCTION public.gdpr_delete_user_data(uuid) FROM sgs_admin';
        END IF;

        IF to_regprocedure('public.cleanup_expired_data()') IS NOT NULL THEN
          EXECUTE 'REVOKE EXECUTE ON FUNCTION public.cleanup_expired_data() FROM sgs_admin';
        END IF;
      END $$;
    `);
  }
}
