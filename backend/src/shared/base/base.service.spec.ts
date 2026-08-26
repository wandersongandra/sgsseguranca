import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { ObjectLiteral, Repository } from 'typeorm';
import { BaseService } from './base.service';
import { TenantService } from '../tenant/tenant.service';

type ProbeEntity = ObjectLiteral & {
  id: string;
  company_id: string;
  status?: string;
};

class ProbeService extends BaseService<ProbeEntity> {
  constructor(
    repository: Repository<ProbeEntity>,
    tenantService: TenantService,
  ) {
    super(repository, tenantService, 'Probe');
  }
}

describe('BaseService tenant contract', () => {
  let repository: jest.Mocked<Repository<ProbeEntity>>;
  let tenantService: TenantService;
  let service: ProbeService;

  beforeEach(() => {
    repository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({
        id: 'probe-1',
        company_id: 'tenant-a',
      }),
      create: jest.fn((value) => value as ProbeEntity),
      save: jest.fn().mockResolvedValue({
        id: 'probe-1',
        company_id: 'tenant-a',
      }),
      merge: jest.fn(),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as jest.Mocked<Repository<ProbeEntity>>;
    tenantService = new TenantService();
    service = new ProbeService(repository, tenantService);
  });

  it('aplica o tenant autenticado à consulta', async () => {
    await tenantService.run(
      { companyId: 'tenant-a', isSuperAdmin: false },
      () => service.findAll({ status: 'open' }),
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.find).toHaveBeenCalledWith({
      where: { status: 'open', company_id: 'tenant-a' },
    });
  });

  it('bloqueia findAll, findOne, update, delete e create sem chamar o repository', async () => {
    const operations = [
      () => service.findAll(),
      () => service.findOne('probe-1'),
      () => service.update('probe-1', { status: 'closed' }),
      () => service.remove('probe-1'),
      () => service.create({ status: 'open' }),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(BadRequestException);
    }

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.find).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.findOne).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.create).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.save).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.merge).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.softDelete).not.toHaveBeenCalled();
  });

  it('emite evento estruturado sem token, payload ou PII', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(service.findAll()).rejects.toBeInstanceOf(BadRequestException);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tenant_context_required',
        scope: 'TENANT_REQUIRED',
        service: 'Probe',
        operation: 'findAll',
        requestId: null,
      }),
    );
    const loggedEvent = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(loggedEvent).not.toHaveProperty('token');
    expect(loggedEvent).not.toHaveProperty('payload');
    expect(loggedEvent).not.toHaveProperty('email');

    warn.mockRestore();
  });

  it('não transforma ausência de tenant em operação global, mesmo para super-admin', async () => {
    await expect(
      tenantService.run(
        { companyId: undefined, isSuperAdmin: true, siteScope: 'all' },
        () => service.findAll(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.find).not.toHaveBeenCalled();
  });

  it('mantém o tenant B no filtro quando tenta acessar o ID de A', async () => {
    repository.findOne.mockResolvedValueOnce(null);

    await expect(
      tenantService.run({ companyId: 'tenant-b', isSuperAdmin: false }, () =>
        service.findOne('tenant-a-record'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: 'tenant-a-record', company_id: 'tenant-b' },
      relations: undefined,
    });
  });
});
