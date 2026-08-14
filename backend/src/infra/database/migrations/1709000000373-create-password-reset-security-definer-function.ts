import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Completa a fase 1c do hardening de bypass de RLS (migration 359), que cobriu
 * o **login** e deixou a **recuperação de senha** para trás.
 *
 * A 359 documenta o problema com todas as letras: "Após o REVOKE (migration
 * 361), a busca retornaria 0 linhas e o login quebraria para todos". Ela criou
 * `find_login_user()` e `update_login_user_password_hash()` para o login — mas
 * `forgotPassword()` e `resetPassword()` continuaram usando o padrão condenado
 * (`SET LOCAL app.is_super_admin = 'true'` na conexão `sgs_app`), e ninguém
 * percebeu porque **os dois falham em silêncio**:
 *
 * - `forgotPassword` não encontra o usuário → `canIssueRealToken = false` → o
 *   e-mail simplesmente não é enviado. A resposta ao usuário é genérica de
 *   propósito (anti-enumeração), então a tela diz "se o CPF existir, você
 *   receberá um e-mail" e o e-mail nunca chega.
 * - `resetPassword` faz `UPDATE users` que a RLS descarta com 0 linhas
 *   afetadas, mas o TypeORM não reclama: o código segue, invalida os refresh
 *   tokens e responde "senha alterada com sucesso". A senha continua a antiga.
 *
 * Esta função é o equivalente de `update_login_user_password_hash` para o fluxo
 * de redefinição: além do hash, zera `must_change_password` e devolve
 * `(user_id, company_id)` — o `company_id` porque `resetPassword` precisa dele
 * para encerrar as sessões ativas do usuário no tenant correto.
 *
 * `RETURNS TABLE` e não um escalar: um `SELECT funcao_escalar(...)` devolve
 * sempre exatamente uma linha, mesmo quando o UPDATE não tocou em nada — o
 * chamador não conseguiria distinguir "atualizou" de "não achou". Com RETURNS
 * TABLE, zero linhas significa zero linhas, e o chamador pode falhar alto em vez
 * de responder "senha alterada" sem ter alterado.
 *
 * Superfície de privilégio: nenhuma novidade material. `sgs_app` já podia
 * trocar o hash de senha de qualquer usuário por id via
 * `update_login_user_password_hash`. O que autoriza a operação continua sendo o
 * token de redefinição de 32 bytes validado no Redis, antes desta chamada.
 */
export class CreatePasswordResetSecurityDefinerFunction1709000000373 implements MigrationInterface {
  name = 'CreatePasswordResetSecurityDefinerFunction1709000000373';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.reset_login_user_password(
        p_user_id  uuid,
        p_new_hash text
      )
      RETURNS TABLE (
        user_id    uuid,
        company_id uuid
      )
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = public
      AS $$
        UPDATE users
           SET password = p_new_hash,
               must_change_password = false
         WHERE id = p_user_id
           AND deleted_at IS NULL
        RETURNING id, company_id;
      $$;
    `);

    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.reset_login_user_password(uuid, text) TO sgs_app
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.reset_login_user_password(uuid, text)
    `);
  }
}
