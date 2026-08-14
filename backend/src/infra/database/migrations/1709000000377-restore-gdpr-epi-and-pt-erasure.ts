import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restaura a cobertura de exclusão LGPD perdida silenciosamente na migration
 * 1709000000345.
 *
 * HISTÓRICO DA REGRESSÃO
 * ----------------------
 * `gdpr_delete_user_data()` é recriada inteira (CREATE OR REPLACE) por várias
 * migrations, e cada uma precisa repetir TODOS os blocos anteriores. Quem
 * esquece, apaga:
 *
 *   312 → activities, audit_logs, user_sessions, document_registry,
 *         ai_interactions, user_consents, **pts_text_fields**
 *   314 → os 7 acima **+ epi_assignments**
 *   345 → audit_logs, user_sessions, document_registry, ai_interactions,
 *         user_consents, apr_risk_evidences, users
 *         ✗ perdeu `pts_text_fields` (312)
 *         ✗ perdeu `epi_assignments` (314)
 *         ✓ removeu `activities` de propósito (a tabela não tem user_id — a
 *           referência era fantasma e abortava a função no primeiro UPDATE)
 *
 * Efeito prático desde a 345: um pedido de exclusão do titular NÃO anonimizava
 * a assinatura do trabalhador na ficha de EPI (`assinatura_entrega` /
 * `assinatura_devolucao`, que carregam nome e o traço da assinatura) nem os
 * campos de texto livre da PT onde o titular aparece como aprovador/reprovador.
 *
 * Esta migration reconstrói a função da 345 na íntegra e reintroduz os dois
 * blocos perdidos, com guarda `to_regclass` para permanecer idempotente em
 * ambientes que não tenham as tabelas.
 */
export class RestoreGdprEpiAndPtErasure1709000000377 implements MigrationInterface {
  name = 'RestoreGdprEpiAndPtErasure1709000000377';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.gdpr_delete_user_data(p_user_id uuid)
      RETURNS TABLE(table_name text, deleted_count integer)
      LANGUAGE plpgsql
      SET search_path TO 'public'
      AS $function$
      DECLARE
        v_count INTEGER;
      BEGIN
        -- NOTA: 'activities' permanece fora — a tabela não possui vínculo com
        -- usuário (sem coluna user_id). A referência era fantasma e abortava a
        -- função inteira no primeiro UPDATE.

        -- Audit logs: desvincular do titular e apagar rastros de rede.
        -- A tabela não tem deleted_at — o registro é MANTIDO (obrigação legal
        -- de trilha), porém anonimizado.
        UPDATE audit_logs
        SET user_id     = NULL,
            "userId"    = NULL,
            ip          = '[LGPD: anonimizado]',
            "userAgent" = NULL
        WHERE user_id = p_user_id OR "userId" = p_user_id::text;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'audit_logs'::text, v_count;

        -- Sessões do titular: eliminação completa.
        DELETE FROM user_sessions
        WHERE user_id = p_user_id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'user_sessions'::text, v_count;

        -- Registro governado de documentos: desvincular o autor.
        -- O documento é PRESERVADO (retenção legal SST).
        UPDATE document_registry
        SET created_by = NULL
        WHERE created_by = p_user_id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'document_registry'::text, v_count;

        -- Interações de IA: anonimizar conteúdo e desvincular.
        UPDATE ai_interactions
        SET deleted_at = NOW(),
            user_id    = '[LGPD: anonimizado]',
            question   = '[LGPD: dado apagado a pedido do titular]',
            response   = NULL
        WHERE user_id = p_user_id::text AND deleted_at IS NULL;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'ai_interactions'::text, v_count;

        -- Consentimentos: revogar preservando a prova histórica.
        UPDATE user_consents
        SET revoked_at = NOW(),
            revoked_ip = 'gdpr-erasure',
            notes = COALESCE(notes || ' | ', '') || 'Revogado por gdpr_delete_user_data()'
        WHERE user_id = p_user_id AND revoked_at IS NULL;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'user_consents'::text, v_count;

        -- Evidências fotográficas de APR: apagar PII de captura.
        UPDATE apr_risk_evidences
        SET uploaded_by_id = NULL,
            ip_address     = NULL,
            device_id      = NULL,
            latitude       = NULL,
            longitude      = NULL
        WHERE uploaded_by_id = p_user_id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'apr_risk_evidences'::text, v_count;

        -- ─────────────────────────────────────────────────────────────────
        -- RESTAURADO (perdido entre a 312 e a 345)
        -- PT: campos de texto livre onde o titular aparece como decisor.
        -- A PT em si é preservada (retenção legal SST).
        -- ─────────────────────────────────────────────────────────────────
        IF to_regclass('public.pts') IS NOT NULL THEN
          UPDATE pts
          SET
            aprovado_motivo = CASE
              WHEN aprovado_por_id = p_user_id THEN '[anonimizado-LGPD]'
              ELSE aprovado_motivo
            END,
            reprovado_motivo = CASE
              WHEN reprovado_por_id = p_user_id THEN '[anonimizado-LGPD]'
              ELSE reprovado_motivo
            END
          WHERE (aprovado_por_id = p_user_id OR reprovado_por_id = p_user_id)
            AND deleted_at IS NULL;
          GET DIAGNOSTICS v_count = ROW_COUNT;
        ELSE
          v_count := 0;
        END IF;
        RETURN QUERY SELECT 'pts_text_fields'::text, v_count;

        -- ─────────────────────────────────────────────────────────────────
        -- RESTAURADO (perdido entre a 314 e a 345)
        -- Fichas de EPI: desvincular o titular e remover nome e traço da
        -- assinatura de entrega e de devolução.
        -- ─────────────────────────────────────────────────────────────────
        IF to_regclass('public.epi_assignments') IS NOT NULL THEN
          UPDATE epi_assignments
          SET deleted_at = NOW(),
              user_id = NULL,
              assinatura_entrega = jsonb_set(
                jsonb_set(
                  COALESCE(assinatura_entrega, '{}'::jsonb),
                  '{signer_name}', '"[LGPD: removido]"'
                ),
                '{signature_data}', '"[LGPD: removido]"'
              ),
              assinatura_devolucao = CASE
                WHEN assinatura_devolucao IS NOT NULL THEN
                  jsonb_set(
                    jsonb_set(assinatura_devolucao, '{signer_name}', '"[LGPD: removido]"'),
                    '{signature_data}', '"[LGPD: removido]"'
                  )
                ELSE assinatura_devolucao
              END
          WHERE user_id = p_user_id AND deleted_at IS NULL;
          GET DIAGNOSTICS v_count = ROW_COUNT;
        ELSE
          v_count := 0;
        END IF;
        RETURN QUERY SELECT 'epi_assignments'::text, v_count;

        -- ─────────────────────────────────────────────────────────────────
        -- users: ANONIMIZAÇÃO DOS IDENTIFICADORES DIRETOS DO TITULAR.
        -- A linha é preservada (FKs de assinaturas/aprovações com retenção
        -- legal própria), mas deixa de identificar pessoa natural.
        -- ─────────────────────────────────────────────────────────────────
        UPDATE users
        SET nome                  = '[LGPD: titular excluído]',
            cpf                   = NULL,
            cpf_hash              = NULL,
            cpf_ciphertext        = NULL,
            email                 = NULL,
            funcao                = NULL,
            password              = NULL,
            signature_pin_hash    = NULL,
            signature_pin_salt    = NULL,
            ai_processing_consent = false,
            status                = false,
            access_status         = 'no_login',
            module_access_keys    = '{}'::jsonb,
            deleted_at            = COALESCE(deleted_at, NOW()),
            updated_at            = NOW()
        WHERE id = p_user_id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'users'::text, v_count;
      END;
      $function$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverte para a definição da 345 — isto é, REINTRODUZ a regressão de
    // exclusão de `epi_assignments` e `pts_text_fields`. Mantido apenas para
    // reversibilidade formal; não deve ser executado em produção.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.gdpr_delete_user_data(p_user_id uuid)
      RETURNS TABLE(table_name text, deleted_count integer)
      LANGUAGE plpgsql
      SET search_path TO 'public'
      AS $function$
      DECLARE
        v_count INTEGER;
      BEGIN
        UPDATE audit_logs
        SET user_id     = NULL,
            "userId"    = NULL,
            ip          = '[LGPD: anonimizado]',
            "userAgent" = NULL
        WHERE user_id = p_user_id OR "userId" = p_user_id::text;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'audit_logs'::text, v_count;

        DELETE FROM user_sessions
        WHERE user_id = p_user_id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'user_sessions'::text, v_count;

        UPDATE document_registry
        SET created_by = NULL
        WHERE created_by = p_user_id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'document_registry'::text, v_count;

        UPDATE ai_interactions
        SET deleted_at = NOW(),
            user_id    = '[LGPD: anonimizado]',
            question   = '[LGPD: dado apagado a pedido do titular]',
            response   = NULL
        WHERE user_id = p_user_id::text AND deleted_at IS NULL;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'ai_interactions'::text, v_count;

        UPDATE user_consents
        SET revoked_at = NOW(),
            revoked_ip = 'gdpr-erasure',
            notes = COALESCE(notes || ' | ', '') || 'Revogado por gdpr_delete_user_data()'
        WHERE user_id = p_user_id AND revoked_at IS NULL;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'user_consents'::text, v_count;

        UPDATE apr_risk_evidences
        SET uploaded_by_id = NULL,
            ip_address     = NULL,
            device_id      = NULL,
            latitude       = NULL,
            longitude      = NULL
        WHERE uploaded_by_id = p_user_id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'apr_risk_evidences'::text, v_count;

        UPDATE users
        SET nome                  = '[LGPD: titular excluído]',
            cpf                   = NULL,
            cpf_hash              = NULL,
            cpf_ciphertext        = NULL,
            email                 = NULL,
            funcao                = NULL,
            password              = NULL,
            signature_pin_hash    = NULL,
            signature_pin_salt    = NULL,
            ai_processing_consent = false,
            status                = false,
            access_status         = 'no_login',
            module_access_keys    = '{}'::jsonb,
            deleted_at            = COALESCE(deleted_at, NOW()),
            updated_at            = NOW()
        WHERE id = p_user_id;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN QUERY SELECT 'users'::text, v_count;
      END;
      $function$;
    `);
  }
}
