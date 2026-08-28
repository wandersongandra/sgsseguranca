import type { QueryRunner } from 'typeorm';
import { RestrictRuntimeDatabasePrivileges1709000000398 } from '../../infra/database/migrations/1709000000398-restrict-runtime-database-privileges';

type QueryRunnerDouble = Pick<QueryRunner, 'query'> & {
  query: jest.MockedFunction<QueryRunner['query']>;
};

const makeQueryRunner = (): QueryRunnerDouble => {
  const query = jest.fn() as jest.MockedFunction<QueryRunner['query']>;
  query.mockResolvedValue([]);
  return { query };
};

const flattenSql = (queryRunner: QueryRunnerDouble): string =>
  queryRunner.query.mock.calls
    .map(([sql]) => String(sql))
    .join('\n')
    .replace(/\s+/g, ' ')
    .toLowerCase();

describe('runtime database privilege migration contract', () => {
  it('revoga DDL relacional, escrita do ledger e privilégios default excessivos', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new RestrictRuntimeDatabasePrivileges1709000000398();

    await migration.up(queryRunner as unknown as QueryRunner);

    const sql = flattenSql(queryRunner);

    expect(sql).toContain(
      'revoke references, trigger on all tables in schema public from sgs_app',
    );
    expect(sql).toContain(
      'revoke insert, update, delete, truncate, references, trigger on table public."migrations" from sgs_app',
    );
    expect(sql).toContain(
      'alter default privileges for role %i in schema public revoke references, trigger',
    );
    expect(sql).toContain("['sgs_migrator', 'neondb_owner']");
    expect(sql).not.toMatch(/revoke\s+select[^;]*public\."migrations"/i);
    expect(sql).not.toMatch(/grant\s+.*(?:references|trigger)/i);
  });

  it('não altera RLS, membership privilegiada, ownership ou BYPASSRLS', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new RestrictRuntimeDatabasePrivileges1709000000398();

    await migration.up(queryRunner as unknown as QueryRunner);

    const sql = flattenSql(queryRunner);

    expect(sql).not.toMatch(/row level security|alter policy|create policy/i);
    expect(sql).not.toMatch(/bypassrls|sgs_rls_bypass|set role|alter role/i);
    expect(sql).not.toMatch(/owner\s+to\s+sgs_app|grant\s+.*ownership/i);
  });

  it('mantém o down seguro e não reintroduz grants', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new RestrictRuntimeDatabasePrivileges1709000000398();

    await migration.down(queryRunner as unknown as QueryRunner);

    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
