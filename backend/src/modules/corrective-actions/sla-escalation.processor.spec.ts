import type { Job } from 'bullmq';
import { SlaEscalationProcessor } from './sla-escalation.processor';
import type { CorrectiveActionsService } from './corrective-actions.service';
import type { TenantService } from '../../shared/tenant/tenant.service';

type SlaJobData = { tenantId: string };

describe('SlaEscalationProcessor tenant context', () => {
  function makeJob(data: SlaJobData): Job<SlaJobData> {
    return {
      id: 'sla-job-1',
      name: 'run-sla-sweep',
      data,
    } as Job<SlaJobData>;
  }

  it('executa a varredura dentro do tenant do job', async () => {
    const runSlaEscalationSweep = jest.fn().mockResolvedValue({
      overdueActions: 0,
      notificationsCreated: 0,
    });
    const correctiveActionsService = {
      runSlaEscalationSweep,
    } as unknown as CorrectiveActionsService;
    const tenantRun = jest.fn((_context: unknown, callback: () => unknown) =>
      callback(),
    );
    const tenantService = { run: tenantRun } as unknown as TenantService;
    const processor = new SlaEscalationProcessor(
      correctiveActionsService,
      tenantService,
    );

    await processor.process(makeJob({ tenantId: 'tenant-a' }));

    expect(tenantRun).toHaveBeenCalledWith(
      { companyId: 'tenant-a', isSuperAdmin: false, siteScope: 'all' },
      expect.any(Function),
    );
    expect(runSlaEscalationSweep).toHaveBeenCalledTimes(1);
  });

  it('rejeita job sem tenant antes de chamar o service', async () => {
    const runSlaEscalationSweep = jest.fn();
    const correctiveActionsService = {
      runSlaEscalationSweep,
    } as unknown as CorrectiveActionsService;
    const tenantRun = jest.fn();
    const tenantService = { run: tenantRun } as unknown as TenantService;
    const processor = new SlaEscalationProcessor(
      correctiveActionsService,
      tenantService,
    );

    await expect(processor.process(makeJob({ tenantId: '' }))).rejects.toThrow(
      'Payload invalido',
    );
    expect(tenantRun).not.toHaveBeenCalled();
    expect(runSlaEscalationSweep).not.toHaveBeenCalled();
  });
});
