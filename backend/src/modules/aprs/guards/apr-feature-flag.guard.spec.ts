import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { AprFeatureFlag } from '../entities/apr-feature-flag.entity';
import { AprFeatureFlagService } from '../services/apr-feature-flag.service';
import { AprFeatureFlagGuard } from './apr-feature-flag.guard';
import type { TenantService } from '../../../shared/tenant/tenant.service';
import { APR_FEATURE_FLAG_KEY } from '../decorators/apr-feature-flag.decorator';

function makeContext(key?: string): ExecutionContext {
  const handler = key
    ? Object.assign(() => {}, { [APR_FEATURE_FLAG_KEY]: key })
    : () => {};
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('AprFeatureFlagGuard', () => {
  let repo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  let featureFlagService: AprFeatureFlagService;
  let tenantService: Pick<TenantService, 'getTenantId'>;
  let reflector: Reflector;
  let guard: AprFeatureFlagGuard;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(
        (input: Partial<AprFeatureFlag>) => input as AprFeatureFlag,
      ),
      update: jest.fn(),
    };
    featureFlagService = new AprFeatureFlagService(
      repo as unknown as Repository<AprFeatureFlag>,
    );
    tenantService = { getTenantId: jest.fn(() => 'company-1') };
    reflector = new Reflector();
    guard = new AprFeatureFlagGuard(
      reflector,
      featureFlagService,
      tenantService as TenantService,
    );
  });

  it('permite acesso quando nenhuma feature flag é requerida', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const result = await guard.canActivate(makeContext());
    expect(result).toBe(true);
  });

  it('permite acesso quando feature flag está habilitada para o tenant', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue('apr_rules_engine');
    repo.findOne.mockResolvedValue({ enabled: true });

    const result = await guard.canActivate(makeContext('apr_rules_engine'));
    expect(result).toBe(true);
  });

  it('lança ForbiddenException quando feature flag está desabilitada', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue('apr_rules_engine');
    repo.findOne.mockResolvedValue({ enabled: false });

    await expect(
      guard.canActivate(makeContext('apr_rules_engine')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('usa flag global quando não existe flag específica do tenant', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue('apr_rules_engine');
    repo.findOne
      .mockResolvedValueOnce(null) // no tenant-specific flag
      .mockResolvedValueOnce({ enabled: true }); // global flag enabled

    const result = await guard.canActivate(makeContext('apr_rules_engine'));
    expect(result).toBe(true);
  });

  it('nega acesso quando nenhuma flag global ou de tenant está configurada', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue('apr_rules_engine');
    repo.findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(makeContext('apr_rules_engine')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('bloqueia por fail-closed quando a consulta da flag falha', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue('apr_workflow_configuravel');
    repo.findOne.mockRejectedValue(new Error('database unavailable'));

    await expect(
      guard.canActivate(makeContext('apr_workflow_configuravel')),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('AprFeatureFlagService', () => {
  let repo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  let service: AprFeatureFlagService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn(() => Promise.resolve()),
      create: jest.fn(
        (input: Partial<AprFeatureFlag>) => input as AprFeatureFlag,
      ),
      update: jest.fn(() => Promise.resolve()),
    };
    service = new AprFeatureFlagService(
      repo as unknown as Repository<AprFeatureFlag>,
    );
  });

  it('isEnabled retorna true para flag habilitada do tenant', async () => {
    repo.findOne.mockResolvedValue({ enabled: true });
    expect(await service.isEnabled('my_flag', 'company-1')).toBe(true);
  });

  it('isEnabled usa flag global quando tenant não tem registro', async () => {
    repo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ enabled: true });
    expect(await service.isEnabled('my_flag', 'company-1')).toBe(true);
  });

  it('isEnabled retorna false quando sem nenhum registro', async () => {
    repo.findOne.mockResolvedValue(null);
    expect(await service.isEnabled('my_flag', 'company-1')).toBe(false);
  });

  it('enable atualiza registro existente', async () => {
    repo.findOne.mockResolvedValue({ id: 'flag-1', enabled: false });
    await service.enable('my_flag', 'company-1');
    expect(repo.update).toHaveBeenCalledWith('flag-1', { enabled: true });
  });

  it('enable cria novo registro quando não existe', async () => {
    repo.findOne.mockResolvedValue(null);
    await service.enable('my_flag', 'company-1');
    expect(repo.save).toHaveBeenCalled();
  });

  it('disable atualiza para disabled', async () => {
    repo.findOne.mockResolvedValue({ id: 'flag-2', enabled: true });
    await service.disable('my_flag', 'company-1');
    expect(repo.update).toHaveBeenCalledWith('flag-2', { enabled: false });
  });
});
