import type { QueryRunner } from 'typeorm';
import { RemoveMutableSuperAdminPolicyAuthority1709000000397 } from '../../infra/database/migrations/1709000000397-remove-mutable-super-admin-policy-authority';

const FORBIDDEN_MUTABLE_AUTHORITY = [
  "current_setting('app.is_super_admin'",
  'current_setting("app.is_super_admin"',
  "set_config('app.is_super_admin'",
  'set_config("app.is_super_admin"',
];

type QueryRunnerDouble = Pick<QueryRunner, 'query'> & {
  query: jest.MockedFunction<QueryRunner['query']>;
};

const makeQueryRunner = (): QueryRunnerDouble => {
  const query = jest.fn() as jest.MockedFunction<QueryRunner['query']>;
  query.mockResolvedValue(undefined);
  return { query };
};

describe('RLS super-admin policy authority contract', () => {
  it('uses the role-gated authority in USING and WITH CHECK', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new RemoveMutableSuperAdminPolicyAuthority1709000000397();

    await migration.up(queryRunner as unknown as QueryRunner);

    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    const sql = String(queryRunner.query.mock.calls[0]?.[0]).replace(
      /\s+/g,
      ' ',
    );

    expect(sql).toContain(
      'ALTER POLICY "companies_tenant_isolation" ON public."companies"',
    );
    expect(sql.match(/public\.is_super_admin\(\)/g)).toHaveLength(2);
    expect(sql.match(/public\.current_company\(\)/g)).toHaveLength(2);
    expect(sql).toContain('USING');
    expect(sql).toContain('WITH CHECK');
    expect(sql).not.toContain('TO sgs_app');

    for (const forbidden of FORBIDDEN_MUTABLE_AUTHORITY) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it('não reabre a autoridade mutável durante o down seguro', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new RemoveMutableSuperAdminPolicyAuthority1709000000397();

    await migration.down(queryRunner as unknown as QueryRunner);

    const sql = String(queryRunner.query.mock.calls[0]?.[0]);

    expect(sql).toContain('WITH CHECK');
    expect(sql.match(/public\.is_super_admin\(\)/g)).toHaveLength(2);
    expect(sql).not.toMatch(/current_setting\s*\(/i);
    expect(sql).not.toMatch(/set_config\s*\(/i);
  });
});
