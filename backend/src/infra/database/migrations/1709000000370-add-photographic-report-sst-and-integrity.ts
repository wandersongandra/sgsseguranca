import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Completude técnica de SST e integridade probatória no Relatório Fotográfico.
 *
 * MOTIVAÇÃO
 *   O relatório era emitido sem nada que o sustentasse como documento técnico:
 *   nenhum registro profissional do responsável, nenhuma norma aplicável,
 *   nenhuma metodologia declarada — e, num documento cujo conteúdo *é* a
 *   fotografia, nenhuma prova de que a imagem não foi trocada depois do envio.
 *   Também não havia como marcar uma foto como não conformidade, então uma
 *   evidência de risco não gerava nenhum item acionável.
 *
 * O QUE ENTRA
 *   1. SST — registro profissional (CREA/CFT/MTE), ART, NRs aplicáveis,
 *      metodologia de inspeção e escopo/limitações.
 *   2. Governança — verification_code, hash do PDF final e ponteiros do
 *      arquivo emitido, seguindo o que `nonconformities` já faz. São
 *      preenchidos exclusivamente pelo backend, dentro da transação de
 *      `registerFinalDocument`; nunca vêm do cliente.
 *   3. Não conformidade por foto — flag, ação recomendada, prazo e responsável.
 *   4. Integridade da evidência — hash SHA-256, tamanho, mime, nome original,
 *      data de captura, geolocalização, dispositivo, IP e EXIF, espelhando o
 *      conjunto que `apr_risk_evidences` já grava.
 *
 * DESVIOS DELIBERADOS EM RELAÇÃO A apr_risk_evidences
 *   - Sem `uploaded_at`: `photographic_report_images` estende BaseAuditEntity,
 *     então `created_at` já é o carimbo de upload. `AprRiskEvidence` precisou da
 *     coluna por não ter base de auditoria. Duas timestamps para o mesmo fato
 *     divergem com o tempo.
 *   - Sem colunas `watermarked_*`: marca d'água não está implementada em lugar
 *     nenhum (na APR as três colunas são sempre nulas). Três colunas mortas
 *     convidam a uma feature pela metade.
 *   - `hash_sha256` nullable: linhas anteriores a esta migration não têm como
 *     ser preenchidas sem baixar cada objeto do storage. O manifesto de
 *     evidências no PDF mostra "—" e uma nota de rodapé para elas — distinguir
 *     "sem hash registrado" de "hash confere" é parte do valor do documento.
 *
 * SOBRE O QUE O HASH PROVA
 *   O frontend re-encoda a imagem via canvas antes do upload, então o hash é
 *   dos bytes recebidos e não do arquivo original da câmera. Ele comprova
 *   integridade desde o recebimento, não autoria da captura. `integrity_flags`
 *   carrega `client_reencoded` para que o PDF possa declarar isso ao leitor.
 *
 * TIPOS
 *   `responsible_registration_type` é varchar + validação por @IsIn na
 *   aplicação, não enum do Postgres: `ALTER TYPE ... ADD VALUE` não roda dentro
 *   de transação, dor que este projeto já carrega em report_tone/area_status/
 *   shift. O conjunto CREA|CFT|MTE|Outro vai crescer.
 *
 * RLS
 *   Nenhuma mudança de política é necessária. `photographic_reports` tem
 *   `tenant_isolation_policy` por company_id e as tabelas filhas resolvem o
 *   tenant por EXISTS sobre a pai (migration 368). Políticas são por tabela,
 *   não por coluna — as novas colunas já nascem cobertas.
 *
 * SEGURANÇA DA APLICAÇÃO
 *   `is_nonconformity` entra NOT NULL DEFAULT false. No PostgreSQL 11+ isso é
 *   alteração só de catálogo (sem reescrita da tabela) porque o default é
 *   constante. Em PG 10 seria reescrita completa sob ACCESS EXCLUSIVE.
 */
export class AddPhotographicReportSstAndIntegrity1709000000370 implements MigrationInterface {
  name = 'AddPhotographicReportSstAndIntegrity1709000000370';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('photographic_reports')) {
      await queryRunner.query(`
        ALTER TABLE "photographic_reports"
          ADD COLUMN IF NOT EXISTS "responsible_registration_type"   varchar(12) NULL,
          ADD COLUMN IF NOT EXISTS "responsible_registration_number" varchar(60) NULL,
          ADD COLUMN IF NOT EXISTS "responsible_registration_state"  varchar(2)  NULL,
          ADD COLUMN IF NOT EXISTS "art_number"                      varchar(60) NULL,
          ADD COLUMN IF NOT EXISTS "applicable_nrs"                  jsonb       NULL,
          ADD COLUMN IF NOT EXISTS "inspection_methodology"          text        NULL,
          ADD COLUMN IF NOT EXISTS "scope_and_limitations"           text        NULL,
          ADD COLUMN IF NOT EXISTS "verification_code"               varchar(24) NULL,
          ADD COLUMN IF NOT EXISTS "final_pdf_hash_sha256"           varchar(64) NULL,
          ADD COLUMN IF NOT EXISTS "pdf_file_key"                    text        NULL,
          ADD COLUMN IF NOT EXISTS "pdf_folder_path"                 text        NULL,
          ADD COLUMN IF NOT EXISTS "pdf_original_name"               text        NULL,
          ADD COLUMN IF NOT EXISTS "pdf_generated_at"                timestamp   NULL
      `);

      await queryRunner.query(`
        COMMENT ON COLUMN "photographic_reports"."verification_code" IS
          'Codigo publico de validacao (RFP-<ano>-<8>). Escrito pelo backend em registerFinalDocument; nunca aceito do cliente.'
      `);
      await queryRunner.query(`
        COMMENT ON COLUMN "photographic_reports"."final_pdf_hash_sha256" IS
          'SHA-256 do PDF final emitido. Escrito na mesma transacao do registro de governanca.'
      `);
      await queryRunner.query(`
        COMMENT ON COLUMN "photographic_reports"."applicable_nrs" IS
          'Array JSON de NRs aplicaveis (ex.: ["NR-06","NR-35"]). Validado contra APPLICABLE_NR_OPTIONS na aplicacao.'
      `);
    }

    if (await queryRunner.hasTable('photographic_report_images')) {
      await queryRunner.query(`
        ALTER TABLE "photographic_report_images"
          ADD COLUMN IF NOT EXISTS "is_nonconformity"   boolean      NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS "recommended_action" text         NULL,
          ADD COLUMN IF NOT EXISTS "action_deadline"    date         NULL,
          ADD COLUMN IF NOT EXISTS "action_responsible" varchar(160) NULL,
          ADD COLUMN IF NOT EXISTS "original_name"      text         NULL,
          ADD COLUMN IF NOT EXISTS "mime_type"          varchar(100) NULL,
          ADD COLUMN IF NOT EXISTS "file_size_bytes"    integer      NULL,
          ADD COLUMN IF NOT EXISTS "hash_sha256"        varchar(64)  NULL,
          ADD COLUMN IF NOT EXISTS "captured_at"        timestamp    NULL,
          ADD COLUMN IF NOT EXISTS "latitude"           numeric(10,7) NULL,
          ADD COLUMN IF NOT EXISTS "longitude"          numeric(10,7) NULL,
          ADD COLUMN IF NOT EXISTS "accuracy_m"         numeric(10,2) NULL,
          ADD COLUMN IF NOT EXISTS "device_id"          varchar(120) NULL,
          ADD COLUMN IF NOT EXISTS "ip_address"         varchar(64)  NULL,
          ADD COLUMN IF NOT EXISTS "exif_datetime"      timestamp    NULL,
          ADD COLUMN IF NOT EXISTS "integrity_flags"    jsonb        NULL
      `);

      await queryRunner.query(`
        COMMENT ON COLUMN "photographic_report_images"."hash_sha256" IS
          'SHA-256 dos bytes recebidos. Nulo em linhas anteriores a esta migration. Nao prova autoria da captura: a imagem e re-encodada no cliente antes do envio.'
      `);
      await queryRunner.query(`
        COMMENT ON COLUMN "photographic_report_images"."latitude" IS
          'Arredondada para 2 casas (~1 km) por privacidade, via roundCoordinate.'
      `);
      await queryRunner.query(`
        COMMENT ON COLUMN "photographic_report_images"."device_id" IS
          'HMAC-SHA256 do identificador de dispositivo. O valor cru nunca e persistido.'
      `);
      await queryRunner.query(`
        COMMENT ON COLUMN "photographic_report_images"."ip_address" IS
          'IP mascarado: IPv4 em /24, IPv6 em /48.'
      `);
      await queryRunner.query(`
        COMMENT ON COLUMN "photographic_report_images"."integrity_flags" IS
          'Presenca de cada metadado: gps, accuracy, device, ip, exif, client_reencoded.'
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('photographic_report_images')) {
      await queryRunner.query(`
        ALTER TABLE "photographic_report_images"
          DROP COLUMN IF EXISTS "is_nonconformity",
          DROP COLUMN IF EXISTS "recommended_action",
          DROP COLUMN IF EXISTS "action_deadline",
          DROP COLUMN IF EXISTS "action_responsible",
          DROP COLUMN IF EXISTS "original_name",
          DROP COLUMN IF EXISTS "mime_type",
          DROP COLUMN IF EXISTS "file_size_bytes",
          DROP COLUMN IF EXISTS "hash_sha256",
          DROP COLUMN IF EXISTS "captured_at",
          DROP COLUMN IF EXISTS "latitude",
          DROP COLUMN IF EXISTS "longitude",
          DROP COLUMN IF EXISTS "accuracy_m",
          DROP COLUMN IF EXISTS "device_id",
          DROP COLUMN IF EXISTS "ip_address",
          DROP COLUMN IF EXISTS "exif_datetime",
          DROP COLUMN IF EXISTS "integrity_flags"
      `);
    }

    if (await queryRunner.hasTable('photographic_reports')) {
      await queryRunner.query(`
        ALTER TABLE "photographic_reports"
          DROP COLUMN IF EXISTS "responsible_registration_type",
          DROP COLUMN IF EXISTS "responsible_registration_number",
          DROP COLUMN IF EXISTS "responsible_registration_state",
          DROP COLUMN IF EXISTS "art_number",
          DROP COLUMN IF EXISTS "applicable_nrs",
          DROP COLUMN IF EXISTS "inspection_methodology",
          DROP COLUMN IF EXISTS "scope_and_limitations",
          DROP COLUMN IF EXISTS "verification_code",
          DROP COLUMN IF EXISTS "final_pdf_hash_sha256",
          DROP COLUMN IF EXISTS "pdf_file_key",
          DROP COLUMN IF EXISTS "pdf_folder_path",
          DROP COLUMN IF EXISTS "pdf_original_name",
          DROP COLUMN IF EXISTS "pdf_generated_at"
      `);
    }
  }
}
