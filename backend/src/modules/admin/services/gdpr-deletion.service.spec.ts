import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GDPRDeletionService } from './gdpr-deletion.service';
import { GdprDeletionRequest } from '../entities/gdpr-deletion-request.entity';
import { GdprRetentionCleanupRun } from '../entities/gdpr-retention-cleanup-run.entity';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { TenantService } from '../../../shared/tenant/tenant.service';
import { PrivilegedDbService } from '../../../shared/database/privileged-db.service';
import { ProvisioningDataSourceService } from '../../../shared/database/provisioning-datasource.service';
import { ServiceUnavailableException } from '@nestjs/common';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_UUID = '550e8400-e29b-41d4-a716-446655440001';

describe('GDPRDeletionService', () => {
  let service: GDPRDeletionService;
  let mockDataSource: {
    query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
    transaction: jest.Mock;
  };
  let mockRepo: {
    create: jest.Mock<unknown, [Record<string, unknown>]>;
    save: jest.Mock<Promise<unknown>, [unknown]>;
    findOne: jest.Mock;
    find: jest.Mock;
  };
  let mockRetentionRunRepo: {
    create: jest.Mock<unknown, [Record<string, unknown>]>;
    save: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    find: jest.Mock;
  };
  let mockTenantService: {
    run: jest.Mock;
  };
  /**
   * Client `pg` da conexão privilegiada (sgs_admin). Registra o SQL executado
   * para que os testes possam afirmar POR ONDE a operação passou — o defeito
   * corrigido era justamente rodar pelo caminho errado, não com o SQL errado.
   */
  let privilegedQueries: string[];
  let privilegedRows: unknown[];
  let mockPrivilegedDb: {
    isEnabled: jest.Mock;
    withPrivilegedClient: jest.Mock;
    withRequiredPrivilegedClient: jest.Mock;
  };
  let mockProvisioningDataSource: {
    isDedicated: jest.Mock;
    requiredTransaction: jest.Mock;
  };

  beforeEach(async () => {
    privilegedQueries = [];
    privilegedRows = [];
    // O client privilegiado delega ao mesmo mock de query do DataSource: os
    // testes continuam expressando "o banco devolve X" sem precisar saber por
    // qual conexão a chamada passou. `privilegedQueries` é o que permite
    // afirmar o caminho quando isso importa.
    const privilegedClient = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        privilegedQueries.push(sql);
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET )/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        const rows = (await mockDataSource.query(sql, params)) as unknown[];
        privilegedRows = Array.isArray(rows) ? rows : [];
        return { rows: privilegedRows, rowCount: privilegedRows.length || 3 };
      }),
    };
    mockPrivilegedDb = {
      isEnabled: jest.fn(() => true),
      withPrivilegedClient: jest.fn((fn: (c: unknown) => unknown) =>
        fn(privilegedClient),
      ),
      withRequiredPrivilegedClient: jest.fn(
        (_op: string, fn: (c: unknown) => unknown) => fn(privilegedClient),
      ),
    };
    // Delega ao mock do repositório de runs para que as asserções já
    // existentes (`mockRetentionRunRepo.save` com tal payload) continuem
    // válidas — o que mudou foi a CONEXÃO, não o conteúdo gravado.
    mockProvisioningDataSource = {
      isDedicated: jest.fn(() => true),
      requiredTransaction: jest.fn((_op: string, fn: (m: unknown) => unknown) =>
        fn({
          save: (_entity: unknown, run: Record<string, unknown>) =>
            mockRetentionRunRepo.save(run),
        }),
      ),
    };

    mockDataSource = {
      query: jest.fn<Promise<unknown>, [string, unknown[]?]>(),
      transaction: jest
        .fn()
        .mockImplementation(
          async (cb: (manager: { query: jest.Mock }) => Promise<void>) => {
            const mockManager = { query: jest.fn().mockResolvedValue([3]) };
            await cb(mockManager);
          },
        ),
    };
    mockRepo = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    mockRetentionRunRepo = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn((entity) =>
        Promise.resolve({
          id: 'retention-run-1',
          ...entity,
        }),
      ),
      find: jest.fn(),
    };
    mockTenantService = {
      run: jest.fn((_context, callback: () => unknown) => callback()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GDPRDeletionService,
        { provide: DataSource, useValue: mockDataSource },
        {
          provide: getRepositoryToken(GdprDeletionRequest),
          useValue: mockRepo,
        },
        {
          provide: getRepositoryToken(GdprRetentionCleanupRun),
          useValue: mockRetentionRunRepo,
        },
        {
          provide: TenantService,
          useValue: mockTenantService,
        },
        {
          provide: PrivilegedDbService,
          useValue: mockPrivilegedDb,
        },
        {
          provide: ProvisioningDataSourceService,
          useValue: mockProvisioningDataSource,
        },
      ],
    }).compile();

    service = module.get<GDPRDeletionService>(GDPRDeletionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('deleteUserData', () => {
    it('anonymiza dados e retorna status completed', async () => {
      mockDataSource.query.mockResolvedValue([
        { table_name: 'activities', deleted_count: '5' },
        { table_name: 'audit_logs', deleted_count: '10' },
        { table_name: 'user_sessions', deleted_count: '2' },
      ]);

      const result = await service.deleteUserData(VALID_UUID);

      expect(result.status).toBe('completed');
      expect(result.user_id).toBe(VALID_UUID);
      expect(result.tables_processed).toHaveLength(3);
      expect(result.tables_processed[0].rows_deleted).toBe(5);
    });

    it('retorna UUID valido como request ID', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.deleteUserData(VALID_UUID);

      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('executa pela conexão PRIVILEGIADA, não pela de runtime', async () => {
      // Regressão do defeito real, e da correção anterior que não corrigia.
      //
      // `gdpr_delete_user_data()` não é SECURITY DEFINER: roda com o privilégio
      // de quem chama. Duas camadas impediam o runtime de fazer o trabalho:
      //   1. a migration 341 revogou EXECUTE de PUBLIC — `sgs_app` sequer pode
      //      executar a função;
      //   2. desde a migration 361, `is_super_admin()` é falso para `sgs_app`,
      //      então o FORCE RLS das tabelas alvo filtraria as linhas do titular
      //      e a função anonimizaria 0 registros, reportando "completed".
      //
      // A versão anterior deste teste afirmava `tenantService.run({isSuperAdmin})`
      // — e passava, porque o wrap de fato acontecia. Ele só não resolvia nada.
      // Verificar a intenção não é verificar o efeito.
      await service.deleteUserData(VALID_UUID);

      expect(
        mockPrivilegedDb.withRequiredPrivilegedClient,
      ).toHaveBeenCalledWith('gdpr_delete_user_data', expect.any(Function));
      expect(privilegedQueries).toEqual(
        expect.arrayContaining([
          expect.stringContaining('gdpr_delete_user_data'),
        ]),
      );
      // E dentro de uma transação explícita, com a flag de sessão setada —
      // é o `sgs_admin` que a torna efetiva.
      expect(privilegedQueries).toEqual(
        expect.arrayContaining([
          'BEGIN',
          "SET LOCAL app.is_super_admin = 'true'",
          'COMMIT',
        ]),
      );
    });

    it('falha (status=failed) quando a conexão privilegiada está indisponível', async () => {
      // Fail-closed: sem conexão privilegiada não há como provar que a
      // anonimização ocorreu, e "não consegui provar" não pode virar
      // "completed".
      mockPrivilegedDb.withRequiredPrivilegedClient.mockRejectedValueOnce(
        new ServiceUnavailableException('conexão privilegiada indisponível'),
      );

      const result = await service.deleteUserData(VALID_UUID);

      expect(result.status).toBe('failed');
      expect(result.error_message).toContain('privilegiada');
    });

    it('persiste o registro duas vezes (criacao + atualizacao final)', async () => {
      mockDataSource.query.mockResolvedValue([]);

      await service.deleteUserData(VALID_UUID);

      expect(mockRepo.save).toHaveBeenCalledTimes(2);
    });

    it('rejeita user ID com formato invalido antes de criar o registro', async () => {
      await expect(service.deleteUserData('not-a-uuid')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('marca status como failed e persiste em caso de erro no banco', async () => {
      mockDataSource.query.mockRejectedValue(
        new Error('Database connection failed'),
      );

      const result = await service.deleteUserData(VALID_UUID);

      expect(result.status).toBe('failed');
      expect(result.error_message).toContain('Database connection failed');
      expect(mockRepo.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteExpiredData', () => {
    it('executa cleanup TTL com sucesso', async () => {
      mockDataSource.query.mockResolvedValue([
        { table_name: 'mail_logs', deleted_count: '100' },
        { table_name: 'user_sessions', deleted_count: '25' },
        { table_name: 'forensic_trail_events', deleted_count: '5' },
        { table_name: 'activities', deleted_count: '10' },
        { table_name: 'audit_logs', deleted_count: '8' },
      ]);

      const result = await service.deleteExpiredData();

      expect(result.status).toBe('success');
      expect(result.run_id).toBe('retention-run-1');
      expect(result.total_rows_deleted).toBe(148);
      expect(result.tables_cleaned).toHaveLength(5);
      expect(mockRetentionRunRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          triggered_by: 'manual',
          trigger_source: 'admin:gdpr-cleanup-expired',
          total_rows_deleted: 148,
        }),
      );
    });

    it('retorna contagem por tabela', async () => {
      mockDataSource.query.mockResolvedValue([
        { table_name: 'mail_logs', deleted_count: '100' },
      ]);

      const result = await service.deleteExpiredData();

      expect(result.tables_cleaned[0].table).toBe('mail_logs');
      expect(result.tables_cleaned[0].rows_deleted).toBe(100);
      expect(mockTenantService.run).toHaveBeenCalledWith(
        { companyId: undefined, isSuperAdmin: true, siteScope: 'all' },
        expect.any(Function),
      );
    });

    it('inclui duracao da execucao', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const before = Date.now();
      const result = await service.deleteExpiredData();
      const after = Date.now();

      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.duration_ms).toBeLessThanOrEqual(after - before + 100);
    });

    it('retorna status error em caso de falha', async () => {
      mockDataSource.query.mockRejectedValue(
        new Error('TTL function not found'),
      );

      const result = await service.deleteExpiredData();

      expect(result.status).toBe('error');
      expect(result.run_id).toBe('retention-run-1');
      expect(mockRetentionRunRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error_message: 'TTL function not found',
        }),
      );
    });

    it('marca execucao agendada quando chamada pelo worker', async () => {
      mockDataSource.query.mockResolvedValue([]);

      await service.deleteExpiredData({
        triggeredBy: 'scheduled',
        triggerSource: 'worker:gdpr-retention-cleanup',
      });

      expect(mockRetentionRunRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          triggered_by: 'scheduled',
          trigger_source: 'worker:gdpr-retention-cleanup',
        }),
      );
    });
  });

  describe('deleteCompanyData', () => {
    it('soft-deleta dados da empresa atomicamente em todas as tabelas', async () => {
      mockDataSource.query.mockResolvedValue([
        { table_name: 'companies' },
        { table_name: 'sites' },
        { table_name: 'users' },
      ]);

      const result = await service.deleteCompanyData(VALID_UUID);

      expect(result.status).toBe('success');
      expect(result.company_id).toBe(VALID_UUID);
      if (result.status === 'success') {
        expect(result.tables_affected).toBe(3);
        expect(result.total_rows_deleted).toBeGreaterThan(0);
      }
    });

    it('rejeita company ID invalido', async () => {
      await expect(service.deleteCompanyData('invalid-uuid')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('inclui aviso sobre soft-delete e retencao no resultado de sucesso', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.deleteCompanyData(VALID_UUID);

      if (result.status === 'success') {
        expect(result.warning).toContain('soft-deleted');
        expect(result.warning).toContain('retention policy');
      } else {
        fail('Expected status success');
      }
    });

    it('retorna status failed e lista de falhas quando a transacao falha', async () => {
      mockDataSource.query.mockResolvedValue([
        { table_name: 'companies' },
        { table_name: 'users' },
      ]);
      mockPrivilegedDb.withRequiredPrivilegedClient.mockRejectedValueOnce(
        new Error('relation "companies" does not exist'),
      );

      const result = await service.deleteCompanyData(VALID_UUID);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.company_id).toBe(VALID_UUID);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].error).toContain('does not exist');
      }
    });

    it('opera pela conexão privilegiada, sem fallback para o runtime', async () => {
      // O ramo `else` que existia aqui rodava os mesmos UPDATE em `sgs_app`
      // com `SET LOCAL app.is_super_admin = 'true'`. Pós-361 a flag é inerte:
      // cada UPDATE afetaria 0 linhas SEM erro, e o método retornaria
      // `status: 'success'` com `total_rows_deleted: 0` — offboarding de tenant
      // reportado como concluído sem ter soft-deletado nada.
      mockDataSource.query.mockResolvedValue([{ table_name: 'companies' }]);

      await service.deleteCompanyData(VALID_UUID);

      expect(
        mockPrivilegedDb.withRequiredPrivilegedClient,
      ).toHaveBeenCalledWith('gdpr_delete_company_data', expect.any(Function));
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('propaga 503 quando não há conexão privilegiada, em vez de "failed" genérico', async () => {
      mockDataSource.query.mockResolvedValue([{ table_name: 'companies' }]);
      mockPrivilegedDb.withRequiredPrivilegedClient.mockRejectedValueOnce(
        new ServiceUnavailableException('conexão privilegiada indisponível'),
      );

      await expect(service.deleteCompanyData(VALID_UUID)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('nao executa transacao quando nenhuma tabela e descoberta', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.deleteCompanyData(VALID_UUID);

      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.tables_affected).toBe(0);
        expect(result.total_rows_deleted).toBe(0);
      }
    });
  });

  describe('getRetentionCleanupRuns', () => {
    it('lista runs de limpeza de retencao com limite saneado', async () => {
      mockRetentionRunRepo.find.mockResolvedValue([
        { id: 'run-1', status: 'success' },
      ]);

      const result = await service.getRetentionCleanupRuns(500);

      expect(result).toHaveLength(1);
      expect(mockRetentionRunRepo.find).toHaveBeenCalledWith({
        order: { created_at: 'DESC' },
        take: 200,
      });
    });
  });

  describe('getDeleteRequestStatus', () => {
    it('retorna o registro quando encontrado', async () => {
      const fakeRecord = { id: VALID_UUID, status: 'completed' };
      mockRepo.findOne.mockResolvedValue(fakeRecord);

      const status = await service.getDeleteRequestStatus(VALID_UUID);

      expect(status).toBeDefined();
      expect(status?.status).toBe('completed');
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: VALID_UUID },
      });
    });

    it('retorna null quando nao encontrado', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const status = await service.getDeleteRequestStatus('non-existent-id');

      expect(status).toBeNull();
    });
  });

  describe('getPendingRequests', () => {
    it('retorna lista de requisicoes pending/in_progress', async () => {
      const fakeRecords = [
        { id: VALID_UUID, status: 'pending', user_id: OTHER_UUID },
      ];
      mockRepo.find.mockResolvedValue(fakeRecords);

      const pending = await service.getPendingRequests();

      expect(Array.isArray(pending)).toBe(true);
      expect(pending).toHaveLength(1);
    });
  });

  describe('validateUserConsent', () => {
    it('permite delecao quando usuario existe e sem requisicao ativa', async () => {
      mockDataSource.query.mockResolvedValue([{ id: VALID_UUID }]);
      mockRepo.findOne.mockResolvedValue(null);

      const result = await service.validateUserConsent(VALID_UUID);

      expect(result.can_delete).toBe(true);
    });

    it('bloqueia quando usuario nao existe', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.validateUserConsent(VALID_UUID);

      expect(result.can_delete).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('bloqueia quando ja existe requisicao pending para o usuario', async () => {
      mockDataSource.query.mockResolvedValue([{ id: VALID_UUID }]);
      mockRepo.findOne.mockResolvedValue({
        id: OTHER_UUID,
        status: 'pending',
        user_id: VALID_UUID,
      });

      const result = await service.validateUserConsent(VALID_UUID);

      expect(result.can_delete).toBe(false);
      expect(result.reason).toContain('pending');
      expect(result.reason).toContain(OTHER_UUID);
    });

    it('bloqueia quando ja existe requisicao in_progress para o usuario', async () => {
      mockDataSource.query.mockResolvedValue([{ id: VALID_UUID }]);
      mockRepo.findOne.mockResolvedValue({
        id: OTHER_UUID,
        status: 'in_progress',
        user_id: VALID_UUID,
      });

      const result = await service.validateUserConsent(VALID_UUID);

      expect(result.can_delete).toBe(false);
      expect(result.reason).toContain('in_progress');
    });
  });
});
