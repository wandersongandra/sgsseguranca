import { Repository } from 'typeorm';
import { TenantService } from '../../shared/tenant/tenant.service';
import { CorrectiveAction } from './entities/corrective-action.entity';
import { CorrectiveActionsService } from './corrective-actions.service';
import { User } from '../users/entities/user.entity';
import { Notification } from '../notifications/entities/notification.entity';

const cloneAction = (
  dto: Partial<CorrectiveAction>,
): Partial<CorrectiveAction> => ({ ...dto });

function makeService(overrides: {
  correctiveActionsRepository?: Partial<Repository<CorrectiveAction>>;
  tenantId?: string;
  nonConformitiesService?: { findOne: jest.Mock };
}) {
  const repo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((dto: Partial<CorrectiveAction>) => cloneAction(dto)),
    save: jest.fn((entity: Partial<CorrectiveAction>) =>
      Promise.resolve(entity as CorrectiveAction),
    ),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue({
        total: '0',
        overdue: '0',
        done: '0',
        dueSoon: '0',
        criticalOpen: '0',
        highOpen: '0',
      }),
      getMany: jest.fn().mockResolvedValue([]),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    }),
    ...overrides.correctiveActionsRepository,
  } as unknown as Repository<CorrectiveAction>;

  const usersRepository = {} as Repository<User>;
  const notificationsRepository = {} as Repository<Notification>;
  const tenantService = {
    getTenantId: jest.fn().mockReturnValue(overrides.tenantId ?? 'company-1'),
  } as unknown as TenantService;
  const nonConformitiesService = (overrides.nonConformitiesService ??
    {}) as never;
  const auditsService = {} as never;
  const notificationsService = {} as never;

  return new CorrectiveActionsService(
    repo,
    usersRepository,
    notificationsRepository,
    nonConformitiesService,
    auditsService,
    notificationsService,
    tenantService,
  );
}

describe('CorrectiveActionsService', () => {
  describe('create()', () => {
    it('uses DEFAULT_SLA_BY_PRIORITY when sla_days and due_date are not provided', async () => {
      const saved: Partial<CorrectiveAction> = {};
      const repo = {
        create: jest.fn((dto: Partial<CorrectiveAction>) => cloneAction(dto)),
        save: jest.fn((entity: Partial<CorrectiveAction>) => {
          Object.assign(saved, entity);
          return Promise.resolve(entity as CorrectiveAction);
        }),
      };
      const service = makeService({
        correctiveActionsRepository: repo as unknown as Partial<
          Repository<CorrectiveAction>
        >,
      });

      const now = new Date();
      await service.create({
        title: 'Test',
        description: 'Descrição',
        priority: 'high',
      });

      // high priority SLA = 3 days
      const due = saved.due_date as unknown as Date;
      expect(due).toBeDefined();
      const diffDays = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(Math.round(diffDays)).toBe(3);
    });

    it('defaults priority to medium and sla_days to 7 when not provided', async () => {
      const saved: Partial<CorrectiveAction> = {};
      const repo = {
        create: jest.fn((dto: Partial<CorrectiveAction>) => cloneAction(dto)),
        save: jest.fn((entity: Partial<CorrectiveAction>) => {
          Object.assign(saved, entity);
          return Promise.resolve(entity as CorrectiveAction);
        }),
      };
      const service = makeService({
        correctiveActionsRepository: repo as unknown as Partial<
          Repository<CorrectiveAction>
        >,
      });

      await service.create({ title: 'Test', description: 'Descrição' });

      expect(saved.priority).toBe('medium');
      expect(saved.sla_days).toBe(7);
    });

    it('sets escalation_level to 0 on creation', async () => {
      const saved: Partial<CorrectiveAction> = {};
      const repo = {
        create: jest.fn((dto: Partial<CorrectiveAction>) => cloneAction(dto)),
        save: jest.fn((entity: Partial<CorrectiveAction>) => {
          Object.assign(saved, entity);
          return Promise.resolve(entity as CorrectiveAction);
        }),
      };
      const service = makeService({
        correctiveActionsRepository: repo as unknown as Partial<
          Repository<CorrectiveAction>
        >,
      });

      await service.create({ title: 'Test', description: 'Descrição' });

      expect(saved.escalation_level).toBe(0);
      expect(saved.status).toBe('open');
    });
  });

  describe('createFromNonConformity()', () => {
    it('aceita acao_definitiva_data_prevista como string (retorno real do TypeORM para colunas type: "date")', async () => {
      // Regressão: colunas @Column({ type: 'date' }) voltam do TypeORM como
      // string ('2026-08-15'), não como instância de Date, apesar do tipo
      // TS declarar `Date` na entity — a chamada direta a .toISOString()
      // sem envolver em `new Date(...)` quebrava com TypeError em produção
      // toda vez que uma NC com prazo definitivo preenchido virava CAPA.
      const saved: Partial<CorrectiveAction> = {};
      const repo = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((dto: Partial<CorrectiveAction>) => cloneAction(dto)),
        save: jest.fn((entity: Partial<CorrectiveAction>) => {
          Object.assign(saved, entity);
          return Promise.resolve(entity as CorrectiveAction);
        }),
      };
      const nonConformitiesService = {
        findOne: jest.fn().mockResolvedValue({
          id: 'nc-1',
          codigo_nc: 'NC-001',
          descricao: 'Desvio de teste',
          site_id: 'site-1',
          risco_nivel: 'baixo',
          acao_definitiva_data_prevista: '2026-08-15',
          acao_definitiva_prazo: null,
          acao_definitiva_responsavel: 'Fulano',
        }),
      };
      const service = makeService({
        correctiveActionsRepository: repo as unknown as Partial<
          Repository<CorrectiveAction>
        >,
        nonConformitiesService,
      });

      const result = await service.createFromNonConformity('nc-1');

      expect(result).toBeDefined();
      expect(saved.due_date).toBeInstanceOf(Date);
      expect((saved.due_date as Date).toISOString()).toBe(
        '2026-08-15T00:00:00.000Z',
      );
    });
  });

  describe('findSummary()', () => {
    it('computes complianceRate as (done / total) * 100', async () => {
      const repo = {
        count: jest
          .fn()
          .mockResolvedValueOnce(10) // total
          .mockResolvedValueOnce(3) // open
          .mockResolvedValueOnce(2) // in_progress
          .mockResolvedValueOnce(1) // overdue
          .mockResolvedValueOnce(4), // done
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([]),
        }),
      };
      const service = makeService({
        correctiveActionsRepository: repo,
      });

      const result = await service.findSummary();

      expect(result.total).toBe(10);
      expect(result.done).toBe(4);
      expect(result.complianceRate).toBe(40);
    });

    it('returns complianceRate 100 when total is 0', async () => {
      const repo = {
        count: jest.fn().mockResolvedValue(0),
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([]),
        }),
      };
      const service = makeService({
        correctiveActionsRepository: repo,
      });

      const result = await service.findSummary();

      expect(result.complianceRate).toBe(100);
    });
  });

  describe('getSlaOverview()', () => {
    it('counts overdue and done correctly from aggregated counters', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          total: '3',
          overdue: '1',
          done: '1',
          dueSoon: '0',
          criticalOpen: '1',
          highOpen: '0',
        }),
        getMany: jest.fn().mockResolvedValue([]),
      };
      const repo = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      };
      const service = makeService({
        correctiveActionsRepository: repo,
      });

      const result = await service.getSlaOverview();

      expect(result.total).toBe(3);
      expect(result.overdue).toBe(1);
      expect(result.done).toBe(1);
    });

    it('returns avgResolutionDays 0.0 when no closed actions', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          total: '0',
          overdue: '0',
          done: '0',
          dueSoon: '0',
          criticalOpen: '0',
          highOpen: '0',
        }),
        getMany: jest.fn().mockResolvedValue([]),
      };
      const repo = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      };
      const service = makeService({
        correctiveActionsRepository: repo,
      });

      const result = await service.getSlaOverview();

      expect(result.avgResolutionDays).toBe('0.0');
    });

    it('calcula avgResolutionDays a partir da amostra de ações concluídas', async () => {
      const now = new Date('2026-03-20T00:00:00.000Z');
      const closedActions = [
        {
          id: 'ca-1',
          created_at: new Date(now.getTime() - 2 * 86400000),
          closed_at: now,
        },
      ] as unknown as CorrectiveAction[];
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          total: '1',
          overdue: '0',
          done: '1',
          dueSoon: '0',
          criticalOpen: '0',
          highOpen: '0',
        }),
        getMany: jest.fn().mockResolvedValue(closedActions),
      };
      const repo = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      };
      const service = makeService({
        correctiveActionsRepository: repo,
      });

      const result = await service.getSlaOverview();

      expect(result.avgResolutionDays).toBe('2.0');
    });
  });

  describe('getSlaBySite()', () => {
    it('agrupa por site.nome (coluna real da entidade Site, não site.name)', async () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            siteId: 'site-1',
            siteName: 'Obra Central',
            total: '2',
            overdue: '1',
            criticalOpen: '1',
          },
        ]),
      };
      const repo = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      };
      const service = makeService({
        correctiveActionsRepository: repo,
      });

      const result = await service.getSlaBySite();

      expect(qb.addSelect).toHaveBeenCalledWith('site.nome', 'siteName');
      expect(qb.groupBy).toHaveBeenCalledWith('site.nome');
      expect(result[0]).toMatchObject({
        siteId: 'site-1',
        site: 'Obra Central',
        total: 2,
        overdue: 1,
        criticalOpen: 1,
      });
    });
  });
});
