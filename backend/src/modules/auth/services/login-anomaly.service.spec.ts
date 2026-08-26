import type { Repository } from 'typeorm';
import type { MailService } from '../../../infra/mail/mail.service';
import type { UserSession } from '../entities/user-session.entity';
import { LoginAnomalyService } from './login-anomaly.service';

type LoggerTarget = {
  logger: {
    warn: (...args: unknown[]) => void;
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

describe('LoginAnomalyService', () => {
  const sessionRepository = { find: jest.fn() };
  const mailService = { sendMail: jest.fn() };
  let service: LoginAnomalyService;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionRepository.find.mockResolvedValue([
      { ip: '8.8.8.8', created_at: new Date('2026-08-25T10:00:00.000Z') },
      { ip: '1.1.1.1', created_at: new Date('2026-08-24T10:00:00.000Z') },
    ]);
    mailService.sendMail.mockResolvedValue(undefined);
    service = new LoginAnomalyService(
      sessionRepository as unknown as Repository<UserSession>,
      mailService as unknown as MailService,
    );
  });

  it('masks email and IP in the anomaly log after a successful alert', async () => {
    const logger = (service as unknown as LoggerTarget).logger;
    const warnSpy = jest.spyOn(logger, 'warn');
    const logSpy = jest.spyOn(logger, 'log');

    await service.checkAndAlert({
      userId: 'user-1',
      userName: 'Synthetic User',
      userEmail: 'alice@example.com',
      currentIp: '8.8.8.8',
      companyId: 'company-1',
    });

    expect(mailService.sendMail).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ currentIp: '8.8.8.0' }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'login_anomaly_alert_sent',
        email: 'a***@example.com',
        ip: '8.8.8.0',
      }),
    );
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(
      'alice@example.com',
    );
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('8.8.8.8');
  });

  it('masks email when the alert provider fails', async () => {
    mailService.sendMail.mockRejectedValue(
      new Error('synthetic provider failure'),
    );
    const logger = (service as unknown as LoggerTarget).logger;
    const errorSpy = jest.spyOn(logger, 'error');

    await expect(
      service.checkAndAlert({
        userId: 'user-1',
        userName: 'Synthetic User',
        userEmail: 'alice@example.com',
        currentIp: '8.8.8.8',
        companyId: 'company-1',
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'login_anomaly_alert_failed',
        email: 'a***@example.com',
      }),
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      'alice@example.com',
    );
  });
});
