/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { mkdtemp, rm } from 'fs/promises';
import { PuppeteerPoolService } from './puppeteer-pool.service';
import { loadPuppeteer } from './puppeteer-runtime';

jest.mock('./puppeteer-runtime', () => ({
  loadPuppeteer: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn(),
  rm: jest.fn(),
}));

describe('PuppeteerPoolService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
    };
    (mkdtemp as jest.MockedFunction<typeof mkdtemp>).mockResolvedValue(
      '/tmp/sgs-pdf-chromium-test',
    );
    (rm as jest.MockedFunction<typeof rm>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('lança o Chromium com diretório temporário e variáveis seguras de runtime', async () => {
    const service = new PuppeteerPoolService();
    const browser = {
      process: jest.fn(() => ({ pid: 1234 })),
    } as never;
    const launchSpy = jest.fn().mockResolvedValue(browser);
    (loadPuppeteer as jest.Mock).mockResolvedValue({
      launch: launchSpy,
      executablePath: jest.fn(),
    });

    const result = await service['launchBrowser']();

    expect(result).toEqual({
      browser,
      userDataDir: '/tmp/sgs-pdf-chromium-test',
    });
    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: expect.arrayContaining([
          '--no-sandbox',
          '--disable-crash-reporter',
          '--disable-features=Crashpad,TranslateUI,BlinkGenPropertyTrees',
          '--user-data-dir=/tmp/sgs-pdf-chromium-test',
          '--data-path=/tmp/sgs-pdf-chromium-test',
          '--disk-cache-dir=/tmp/sgs-pdf-chromium-test',
          '--crash-dumps-dir=/tmp/sgs-pdf-chromium-test',
        ]),
        env: expect.objectContaining({
          HOME: expect.any(String),
          XDG_CONFIG_HOME: expect.any(String),
          XDG_CACHE_HOME: expect.any(String),
        }),
      }),
    );
  });

  it('limpa o diretório temporário quando o launch falha', async () => {
    const service = new PuppeteerPoolService();
    (loadPuppeteer as jest.Mock).mockResolvedValue({
      launch: jest.fn().mockRejectedValue(new Error('launch failed')),
      executablePath: jest.fn(),
    });

    await expect(service['launchBrowser']()).rejects.toThrow('launch failed');

    expect(rm).toHaveBeenCalledWith('/tmp/sgs-pdf-chromium-test', {
      recursive: true,
      force: true,
    });
  });

  it('usa o executablePath resolvido pelo Puppeteer quando a env não está definida', async () => {
    delete process.env.PUPPETEER_EXECUTABLE_PATH;

    const service = new PuppeteerPoolService();
    const browser = {
      process: jest.fn(() => ({ pid: 5678 })),
    } as never;

    const launchSpy = jest.fn().mockResolvedValue(browser);
    (loadPuppeteer as jest.Mock).mockResolvedValue({
      executablePath: jest
        .fn()
        .mockResolvedValue(
          '/workspace/backend/.cache/puppeteer/chrome/linux/chrome',
        ),
      launch: launchSpy,
    });

    await service['launchBrowser']();

    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath:
          '/workspace/backend/.cache/puppeteer/chrome/linux/chrome',
      }),
    );
  });
});
