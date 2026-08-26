import type { Job } from 'bullmq';
import { ExpiryNotificationsProcessor } from './expiry-notifications.processor';
import type { EpisService } from '../epis/epis.service';
import type { MedicalExamsService } from '../medical-exams/medical-exams.service';
import type { TrainingsService } from '../trainings/trainings.service';
import type { TenantService } from '../../shared/tenant/tenant.service';

type ExpiryJobData = {
  tenantId: string;
  type: 'training-check' | 'epi-check' | 'medical-exam-check';
};

describe('ExpiryNotificationsProcessor tenant context', () => {
  function makeJob(data: ExpiryJobData): Job<ExpiryJobData> {
    return {
      id: 'expiry-job-1',
      name: data.type,
      data,
    } as Job<ExpiryJobData>;
  }

  it('executa o serviço de EPI dentro do tenant do job', async () => {
    const dispatchExpiryNotifications = jest
      .fn()
      .mockResolvedValue({ dispatched: 0 });
    const episService = {
      dispatchExpiryNotifications,
    } as unknown as EpisService;
    const tenantRun = jest.fn((_context: unknown, callback: () => unknown) =>
      callback(),
    );
    const tenantService = { run: tenantRun } as unknown as TenantService;
    const processor = new ExpiryNotificationsProcessor(
      {} as TrainingsService,
      {} as MedicalExamsService,
      episService,
      tenantService,
    );

    await processor.process(
      makeJob({ tenantId: 'tenant-b', type: 'epi-check' }),
    );

    expect(tenantRun).toHaveBeenCalledWith(
      { companyId: 'tenant-b', isSuperAdmin: false, siteScope: 'all' },
      expect.any(Function),
    );
    expect(dispatchExpiryNotifications).toHaveBeenCalledWith(30);
  });

  it('rejeita job sem tenant antes de chamar qualquer serviço', async () => {
    const tenantRun = jest.fn();
    const tenantService = { run: tenantRun } as unknown as TenantService;
    const processor = new ExpiryNotificationsProcessor(
      {} as TrainingsService,
      {} as MedicalExamsService,
      {} as EpisService,
      tenantService,
    );

    await expect(
      processor.process(makeJob({ tenantId: '', type: 'epi-check' })),
    ).rejects.toThrow('Payload invalido');
    expect(tenantRun).not.toHaveBeenCalled();
  });
});
