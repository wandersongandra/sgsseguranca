import { Repository, getMetadataArgsStorage } from 'typeorm';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { TenantService } from '../../shared/tenant/tenant.service';

describe('NotificationsService', () => {
  let repo: jest.Mocked<Partial<Repository<Notification>>>;
  let userRepository: jest.Mocked<Partial<Repository<User>>>;
  let gateway: { sendToUser: jest.Mock };
  let tenantService: Pick<TenantService, 'run'>;
  let service: NotificationsService;
  let insertQueryBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    onConflict: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(() => {
    repo = {
      save: jest.fn().mockImplementation((data) =>
        Promise.resolve({
          id: 'notification-1',
          ...(data as Record<string, unknown>),
        }),
      ),
      findOne: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findAndCount: jest.fn(),
    };
    userRepository = {
      createQueryBuilder: jest.fn(),
    };
    gateway = {
      sendToUser: jest.fn(),
    };
    tenantService = {
      run: jest.fn((_, callback) => callback()),
    };

    insertQueryBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };
    repo.createQueryBuilder = jest.fn(() => insertQueryBuilder as never);

    service = new NotificationsService(
      repo as Repository<Notification>,
      userRepository as Repository<User>,
      gateway as never,
      tenantService as TenantService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('persiste a notificação mesmo quando o envio em tempo real falha', async () => {
    gateway.sendToUser.mockImplementation(() => {
      throw new Error('socket unavailable');
    });

    await expect(
      service.create({
        companyId: 'company-1',
        userId: 'user-1',
        type: 'warning',
        title: 'Fila degradada',
        message: 'A fila operacional foi carregada com falhas.',
      }),
    ).resolves.toMatchObject({
      id: 'notification-1',
      userId: 'user-1',
    });

    expect(repo.save).toHaveBeenCalled();
    expect(gateway.sendToUser).toHaveBeenCalled();
  });

  it('normaliza paginação inválida para valores seguros', async () => {
    repo.findAndCount = jest.fn().mockResolvedValue([[], 0]);

    await service.findAll('user-1', 'company-1', Number.NaN, Number.NaN);

    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 20,
        where: { userId: 'user-1', company_id: 'company-1' },
      }),
    );
  });

  it('mapeia soft delete da entidade para a coluna deleted_at do banco', () => {
    const column = getMetadataArgsStorage().columns.find(
      (entry) =>
        entry.target === Notification && entry.propertyName === 'deletedAt',
    );

    expect(column?.options?.name).toBe('deleted_at');
  });

  it('insere atomicamente e envia realtime apenas para a linha vencedora', async () => {
    const notification = {
      id: 'notification-1',
      company_id: 'company-1',
      userId: 'user-1',
      type: 'warning',
      title: 'Alerta',
      message: 'Mensagem',
      data: undefined,
      read: false,
      createdAt: new Date('2026-09-03T12:00:00.000Z'),
      readAt: null,
      dedupeKey: 'dds:alert:123',
    } as unknown as Notification;
    insertQueryBuilder.execute.mockResolvedValue({
      identifiers: [{ id: notification.id }],
      raw: [{ id: notification.id }],
    });
    repo.findOne = jest.fn().mockResolvedValue(notification);

    await expect(
      service.createDeduped({
        companyId: 'company-1',
        userId: 'user-1',
        type: 'warning',
        title: 'Alerta',
        message: 'Mensagem',
        dedupeKey: ' dds:alert:123 ',
      }),
    ).resolves.toBe(notification);

    expect(insertQueryBuilder.onConflict).toHaveBeenCalledWith(
      expect.stringContaining('DO NOTHING'),
    );
    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        id: notification.id,
        company_id: 'company-1',
        userId: 'user-1',
      },
    });
    expect(gateway.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('retorna a linha existente após conflito sem duplicar realtime', async () => {
    const existing = {
      id: 'notification-existing',
      company_id: 'company-1',
      userId: 'user-1',
      type: 'warning',
      title: 'Título antigo',
      message: 'Mensagem antiga',
      dedupeKey: 'stable:event:1',
    } as unknown as Notification;
    insertQueryBuilder.execute.mockResolvedValue({
      identifiers: [],
      raw: [],
    });
    repo.findOne = jest.fn().mockResolvedValue(existing);

    await expect(
      service.createDeduped({
        companyId: 'company-1',
        userId: 'user-1',
        type: 'warning',
        title: 'Título novo',
        message: 'Mensagem nova',
        dedupeKey: 'stable:event:1',
      }),
    ).resolves.toBe(existing);

    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        company_id: 'company-1',
        userId: 'user-1',
        dedupeKey: 'stable:event:1',
      },
    });
    expect(gateway.sendToUser).not.toHaveBeenCalled();
  });

  it('rejeita chave vazia ou maior que o limite sem tocar no tenant', async () => {
    await expect(
      service.createDeduped({
        companyId: 'company-1',
        userId: 'user-1',
        type: 'info',
        title: 'Título',
        message: 'Mensagem',
        dedupeKey: '   ',
      }),
    ).rejects.toThrow('cannot be empty');

    await expect(
      service.createDeduped({
        companyId: 'company-1',
        userId: 'user-1',
        type: 'info',
        title: 'Título',
        message: 'Mensagem',
        dedupeKey: 'x'.repeat(256),
      }),
    ).rejects.toThrow('exceeds 255 characters');

    expect(tenantService.run).not.toHaveBeenCalled();
  });

  it('declara o índice único parcial no metadata da entidade', () => {
    const index = getMetadataArgsStorage().indices.find(
      (entry) =>
        entry.target === Notification &&
        entry.name === 'UQ_notifications_company_user_dedupe_active',
    );

    expect(index?.unique).toBe(true);
    expect(index?.columns).toEqual(['company_id', 'userId', 'dedupeKey']);
    expect(index?.where).toContain('deleted_at');
  });
});
