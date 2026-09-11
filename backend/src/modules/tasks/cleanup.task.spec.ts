import { CleanupTask } from './cleanup.task';
import * as uploadUtils from '../../shared/interceptors/file-upload.interceptor';

describe('CleanupTask', () => {
  const originalRedisDisabled = process.env.REDIS_DISABLED;
  const originalApiCronsDisabled = process.env.API_CRONS_DISABLED;

  afterEach(() => {
    process.env.REDIS_DISABLED = originalRedisDisabled;
    process.env.API_CRONS_DISABLED = originalApiCronsDisabled;
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('nao tenta enfileirar notificacoes quando REDIS_DISABLED=true', async () => {
    process.env.REDIS_DISABLED = 'true';
    const auditLogRepository = { delete: jest.fn() };
    const aprMetricRepository = { delete: jest.fn() };
    const slaQueue = { add: jest.fn() };
    const expiryQueue = { add: jest.fn() };
    const companiesService = { findAllActive: jest.fn() };

    const pdfDlq = { getWaitingCount: jest.fn().mockResolvedValue(0) };
    const task = new CleanupTask(
      auditLogRepository as never,
      aprMetricRepository as never,
      slaQueue as never,
      expiryQueue as never,
      pdfDlq as never,
      companiesService as never,
      { isEnabled: () => false } as never,
    );

    await task.runExpiryNotifications();
    await task.runCorrectiveActionsSlaEscalation();

    expect(companiesService.findAllActive).not.toHaveBeenCalled();
    expect(expiryQueue.add).not.toHaveBeenCalled();
    expect(slaQueue.add).not.toHaveBeenCalled();
  });

  it('executa cleanup agendado de uploads temporarios quando crons estao ativos', async () => {
    const cleanupSpy = jest
      .spyOn(uploadUtils, 'runTempUploadCleanupBestEffort')
      .mockResolvedValue(null);
    const auditLogRepository = { delete: jest.fn() };
    const aprMetricRepository = { delete: jest.fn() };
    const slaQueue = { add: jest.fn() };
    const expiryQueue = { add: jest.fn() };
    const companiesService = { findAllActive: jest.fn() };

    const pdfDlq = { getWaitingCount: jest.fn().mockResolvedValue(0) };
    const task = new CleanupTask(
      auditLogRepository as never,
      aprMetricRepository as never,
      slaQueue as never,
      expiryQueue as never,
      pdfDlq as never,
      companiesService as never,
      { isEnabled: () => false } as never,
    );

    await task.cleanupStaleTempUploads();

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('nao executa crons quando API_CRONS_DISABLED=true', async () => {
    process.env.API_CRONS_DISABLED = 'true';
    const cleanupSpy = jest.spyOn(
      uploadUtils,
      'runTempUploadCleanupBestEffort',
    );
    const auditLogRepository = { delete: jest.fn() };
    const aprMetricRepository = { delete: jest.fn() };
    const slaQueue = { add: jest.fn() };
    const expiryQueue = { add: jest.fn() };
    const companiesService = { findAllActive: jest.fn() };

    const pdfDlq = { getWaitingCount: jest.fn().mockResolvedValue(0) };
    const task = new CleanupTask(
      auditLogRepository as never,
      aprMetricRepository as never,
      slaQueue as never,
      expiryQueue as never,
      pdfDlq as never,
      companiesService as never,
      { isEnabled: () => false } as never,
    );

    await task.cleanupOldLogs();
    await task.cleanupOldAprMetrics();
    task.generateWeeklyReports();
    await task.cleanupStaleTempUploads();
    await task.runExpiryNotifications();
    await task.runCorrectiveActionsSlaEscalation();

    expect(auditLogRepository.delete).not.toHaveBeenCalled();
    expect(aprMetricRepository.delete).not.toHaveBeenCalled();
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(companiesService.findAllActive).not.toHaveBeenCalled();
    expect(expiryQueue.add).not.toHaveBeenCalled();
    expect(slaQueue.add).not.toHaveBeenCalled();
  });

  it('enfileira jobs por tenant com jobId determinístico para evitar duplicidade', async () => {
    process.env.REDIS_DISABLED = 'false';
    const auditLogRepository = { delete: jest.fn() };
    const aprMetricRepository = { delete: jest.fn() };
    const slaQueue = { add: jest.fn().mockResolvedValue({ id: 'sla' }) };
    const expiryQueue = { add: jest.fn().mockResolvedValue({ id: 'expiry' }) };
    const companiesService = {
      findAllActive: jest.fn().mockResolvedValue([{ id: 'company-1' }]),
    };
    const pdfDlq = { getWaitingCount: jest.fn().mockResolvedValue(0) };
    const task = new CleanupTask(
      auditLogRepository as never,
      aprMetricRepository as never,
      slaQueue as never,
      expiryQueue as never,
      pdfDlq as never,
      companiesService as never,
      { isEnabled: () => false } as never,
    );

    await task.runExpiryNotifications();
    await task.runCorrectiveActionsSlaEscalation();

    expect(expiryQueue.add).toHaveBeenCalledWith(
      'training-check',
      { tenantId: 'company-1', type: 'training-check' },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        jobId: expect.stringMatching(
          /^expiry-notifications-training-check-company-1-\d{4}-\d{2}-\d{2}$/,
        ),
        removeOnFail: 1000,
      }),
    );
    expect(slaQueue.add).toHaveBeenCalledWith(
      'run-sla-sweep',
      { tenantId: 'company-1' },
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        jobId: expect.stringMatching(
          /^sla-escalation-run-sla-sweep-company-1-\d{4}-\d{2}-\d{2}t\d{2}$/,
        ),
      }),
    );
  });
});
