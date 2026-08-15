import { Client } from 'pg';

/**
 * E2E contra PostgreSQL REAL com RLS ligada — sem mock em ponto nenhum.
 *
 * Prova, no banco, a premissa que sustenta todas as correções de fail-open:
 *
 *   `SELECT COUNT(*)` não responde "quantas linhas existem".
 *   Responde "quantas linhas esta sessão está autorizada a enxergar".
 *
 * O job `backend-e2e` do CI monta exatamente a topologia de produção:
 *   - `sgs_app`   — NOSUPERUSER, NOBYPASSRLS, **não** membro de sgs_rls_bypass
 *   - `sgs_admin` — NOSUPERUSER, NOBYPASSRLS, **membro** de sgs_rls_bypass
 *   - `neondb_owner` — dono do schema, roda as migrations
 *
 * Se estes testes começarem a falhar, a leitura correta não é "ajustar o
 * teste": é que alguma migration mudou o contrato de RLS, e todo guard que
 * depende dele precisa ser reavaliado.
 */
const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

const HOST = process.env.E2E_DATABASE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.E2E_DATABASE_PORT ?? 5433);
const DB = process.env.E2E_DATABASE_NAME ?? 'sst_test';

/** Conexão de runtime — o que a aplicação usa no dia a dia. */
const asApp = () =>
  new Client({
    host: HOST,
    port: PORT,
    database: DB,
    user: 'sgs_app',
    password: process.env.E2E_SGS_APP_PASSWORD ?? 'sgs_app_e2e',
  });

/** Conexão privilegiada — DATABASE_ADMIN_URL. */
const asAdmin = () =>
  new Client({
    host: HOST,
    port: PORT,
    database: DB,
    user: 'sgs_admin',
    password: process.env.E2E_SGS_ADMIN_PASSWORD ?? 'sgs_admin_e2e',
  });

/** Conexão de migrations — dona do schema, enxerga tudo. */
const asOwner = () =>
  new Client({
    host: HOST,
    port: PORT,
    database: DB,
    user: process.env.E2E_DATABASE_USER ?? 'neondb_owner',
    password: process.env.E2E_DATABASE_PASSWORD ?? 'neondb_owner_e2e',
  });

describeE2E('RLS — semântica de guardas fail-open (PostgreSQL real)', () => {
  const companyId = '3f1d2c4a-0000-4000-8000-000000000901';
  const siteId = '3f1d2c4a-0000-4000-8000-000000000902';
  const userId = '3f1d2c4a-0000-4000-8000-000000000903';
  /**
   * CNPJ exclusivo desta suite, com digitos verificadores validos.
   *
   * Nao reutilizar CNPJ de outro fixture: `UQ_companies_cnpj_active` e um
   * indice unico parcial, e a colisao derruba o beforeAll — fazendo falhar ate
   * os testes que so consultam o catalogo do PostgreSQL.
   */
  const CNPJ = '99887766000105';
  /** E-mail exclusivo desta suite, pelo mesmo motivo do CNPJ. */
  const EMAIL = 'rls.guard@e2e.test';

  let owner: Client;

  beforeAll(async () => {
    owner = asOwner();
    await owner.connect();

    // Limpeza defensiva antes de semear.
    //
    // `ON CONFLICT (id)` cobre só a PK. `companies` tem tambem o indice unico
    // parcial `UQ_companies_cnpj_active`, e um CNPJ compartilhado com outro
    // fixture derruba o beforeAll inteiro — o que faz TODOS os testes desta
    // suite falharem, inclusive os que so consultam catalogo. Foi o que
    // aconteceu na primeira execucao em CI.
    await owner.query(`DELETE FROM users WHERE id = $1 OR email = $2`, [
      userId,
      EMAIL,
    ]);
    await owner.query(`DELETE FROM sites WHERE id = $1`, [siteId]);
    await owner.query(`DELETE FROM companies WHERE id = $1 OR cnpj = $2`, [
      companyId,
      CNPJ,
    ]);

    // Semeia um tenant mínimo com UM usuário. É a linha que os testes abaixo
    // tentam enxergar por conexões diferentes.
    await owner.query(
      `INSERT INTO companies (id, razao_social, cnpj, endereco, responsavel, email_contato, status)
       VALUES ($1, 'RLS Guard E2E', $2, 'Rua E2E', 'Resp', $3, true)`,
      [companyId, CNPJ, EMAIL],
    );
    await owner.query(
      `INSERT INTO sites (id, company_id, nome, local, status)
       VALUES ($1, $2, 'Geral', 'Geral', true)`,
      [siteId, companyId],
    );
    const profile = await owner.query<{ id: string }>(
      `SELECT id FROM profiles WHERE status = true ORDER BY created_at LIMIT 1`,
    );
    const profileId = profile.rows[0]?.id;
    // Sem esta guarda, `undefined` iria para o INSERT e o teste morreria com
    // violação de constraint — um erro que aponta para a linha errada. Um teste
    // de segurança tem que falhar dizendo o que está faltando no ambiente.
    if (!profileId) {
      throw new Error(
        'Seed E2E: nenhum profile ativo encontrado. As migrations rodaram e ' +
          'semearam os perfis padrão? Sem um profile ativo não há como criar o ' +
          'usuário que estes testes usam para provar o comportamento da RLS.',
      );
    }
    await owner.query(
      `INSERT INTO users (id, nome, email, funcao, company_id, site_id, profile_id, status, ai_processing_consent)
       VALUES ($1, 'Usuario RLS E2E', $5, 'Teste', $2, $3, $4, true, false)`,
      [userId, companyId, siteId, profileId, EMAIL],
    );
  }, 60_000);

  afterAll(async () => {
    if (owner) {
      await owner.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM sites WHERE id = $1`, [siteId]);
      await owner.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
      await owner.end();
    }
  });

  describe('topologia de papéis', () => {
    it('sgs_app NÃO é membro de sgs_rls_bypass', async () => {
      const r = await owner.query<{ m: boolean }>(
        `SELECT pg_has_role('sgs_app', 'sgs_rls_bypass', 'MEMBER') AS m`,
      );
      expect(r.rows[0].m).toBe(false);
    });

    it('sgs_admin É membro de sgs_rls_bypass', async () => {
      const r = await owner.query<{ m: boolean }>(
        `SELECT pg_has_role('sgs_admin', 'sgs_rls_bypass', 'MEMBER') AS m`,
      );
      expect(r.rows[0].m).toBe(true);
    });

    it('nenhum dos dois tem BYPASSRLS de verdade — o gate é a função, não o atributo', async () => {
      const r = await owner.query<{ rolname: string; rolbypassrls: boolean }>(
        `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('sgs_app','sgs_admin')`,
      );
      r.rows.forEach((row) => expect(row.rolbypassrls).toBe(false));
    });
  });

  describe('is_super_admin() — a flag de sessão sozinha não concede nada', () => {
    it('retorna FALSE para sgs_app mesmo com app.is_super_admin = true', async () => {
      const client = asApp();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.is_super_admin = 'true'");
        const r = await client.query<{ flag: string; efetivo: boolean }>(
          `SELECT current_setting('app.is_super_admin', true) AS flag, is_super_admin() AS efetivo`,
        );
        await client.query('ROLLBACK');

        // A flag ESTÁ setada — e mesmo assim a função nega. É este descompasso
        // que transformou `SET LOCAL app.is_super_admin` em no-op na migration 361.
        expect(r.rows[0].flag).toBe('true');
        expect(r.rows[0].efetivo).toBe(false);
      } finally {
        await client.end();
      }
    });

    it('retorna TRUE para sgs_admin com a mesma flag', async () => {
      const client = asAdmin();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.is_super_admin = 'true'");
        const r = await client.query<{ efetivo: boolean }>(
          `SELECT is_super_admin() AS efetivo`,
        );
        await client.query('ROLLBACK');
        expect(r.rows[0].efetivo).toBe(true);
      } finally {
        await client.end();
      }
    });
  });

  describe('COUNT(*) em users — o defeito de fail-open, reproduzido', () => {
    it('sgs_app SEM tenant conta 0 usuários, embora exista 1', async () => {
      const client = asApp();
      await client.connect();
      try {
        await client.query('BEGIN');
        // Exatamente o que `companies.remove()` fazia: setar a flag e contar.
        await client.query("SET LOCAL app.is_super_admin = 'true'");
        const r = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM users WHERE company_id = $1`,
          [companyId],
        );
        await client.query('ROLLBACK');

        // ESTE é o bug: a empresa tem usuário, e a guarda enxerga zero.
        expect(Number(r.rows[0].n)).toBe(0);
      } finally {
        await client.end();
      }
    });

    it('sgs_admin conta o número real', async () => {
      const client = asAdmin();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.is_super_admin = 'true'");
        const r = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM users WHERE company_id = $1`,
          [companyId],
        );
        await client.query('ROLLBACK');
        expect(Number(r.rows[0].n)).toBeGreaterThanOrEqual(1);
      } finally {
        await client.end();
      }
    });

    it('sgs_app COM tenant no contexto conta corretamente — o problema é a ausência de tenant, não o papel', async () => {
      const client = asApp();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_company_id', $1, true)`,
          [companyId],
        );
        const r = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM users WHERE company_id = $1`,
          [companyId],
        );
        await client.query('ROLLBACK');
        expect(Number(r.rows[0].n)).toBeGreaterThanOrEqual(1);
      } finally {
        await client.end();
      }
    });
  });

  describe('UPDATE silencioso — 0 linhas afetadas, sem erro', () => {
    it('sgs_app sem tenant atualiza 0 linhas e NÃO lança exceção', async () => {
      const client = asApp();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.is_super_admin = 'true'");
        const r = await client.query(
          `UPDATE users SET funcao = 'ALTERADO PELO TESTE' WHERE id = $1`,
          [userId],
        );
        await client.query('ROLLBACK');

        // É isto que fazia `resetPassword` responder "senha alterada com
        // sucesso" sem ter alterado nada: o driver não reclama, só devolve 0.
        expect(r.rowCount).toBe(0);
      } finally {
        await client.end();
      }
    });

    it('sgs_admin atualiza a linha de verdade', async () => {
      const client = asAdmin();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.is_super_admin = 'true'");
        const r = await client.query(
          `UPDATE users SET funcao = 'ALTERADO PELO TESTE' WHERE id = $1`,
          [userId],
        );
        await client.query('ROLLBACK');
        expect(r.rowCount).toBe(1);
      } finally {
        await client.end();
      }
    });
  });

  describe('funções de GDPR — executáveis pela conexão privilegiada (migration 374)', () => {
    it('sgs_admin pode EXECUTE gdpr_delete_user_data e cleanup_expired_data', async () => {
      const r = await owner.query<{
        proname: string;
        admin_exec: boolean;
        app_exec: boolean;
      }>(
        `SELECT p.proname,
                has_function_privilege('sgs_admin', p.oid, 'EXECUTE') AS admin_exec,
                has_function_privilege('sgs_app',   p.oid, 'EXECUTE') AS app_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN ('gdpr_delete_user_data','cleanup_expired_data')`,
      );

      expect(r.rows.length).toBe(2);
      r.rows.forEach((row) => {
        expect(row.admin_exec).toBe(true);
        // Deliberado: o papel de runtime NÃO recebe a capacidade de disparar
        // anonimização em massa. Ver migration 374.
        expect(row.app_exec).toBe(false);
      });
    });
  });

  describe('GDPR — prova de anonimização REAL, lendo o banco depois', () => {
    it('gdpr_delete_user_data limpa a PII do titular de verdade', async () => {
      const client = asAdmin();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.is_super_admin = 'true'");
        await client.query(`SELECT * FROM gdpr_delete_user_data($1)`, [userId]);

        // Lê o estado final DENTRO da mesma transação, pela conexão que
        // enxerga tudo. Não basta a função responder "completed": o teste
        // precisa provar o que sobrou na linha.
        const r = await client.query<{
          nome: string | null;
          cpf: string | null;
          cpf_hash: string | null;
          cpf_ciphertext: string | null;
          email: string | null;
          status: boolean | null;
          deleted_at: Date | null;
        }>(
          `SELECT nome, cpf, cpf_hash, cpf_ciphertext, email, status, deleted_at
             FROM users WHERE id = $1`,
          [userId],
        );
        const u = r.rows[0];

        expect(u).toBeDefined();
        expect(u.cpf).toBeNull();
        expect(u.cpf_hash).toBeNull();
        expect(u.cpf_ciphertext).toBeNull();
        expect(u.email).toBeNull();
        expect(u.status).toBe(false);
        expect(u.deleted_at).not.toBeNull();
        expect(u.nome).toContain('LGPD');

        // Rollback: o teste prova o efeito sem deixar rastro.
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    });

    it('a mesma chamada pela conexão de runtime é RECUSADA — não silenciosamente ineficaz', async () => {
      const client = asApp();
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.is_super_admin = 'true'");

        // Duas camadas impedem: EXECUTE revogado (migration 341) e, mesmo que
        // houvesse, is_super_admin() falso faria a função anonimizar 0 linhas.
        // A primeira camada é a que dispara, e é a preferível: erro alto em
        // vez de sucesso vazio.
        await expect(
          client.query(`SELECT * FROM gdpr_delete_user_data($1)`, [userId]),
        ).rejects.toThrow(/permission denied/i);

        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    });
  });
});
