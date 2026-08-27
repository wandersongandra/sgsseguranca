/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { mkdtemp, rm } from 'fs/promises';
import * as puppeteer from 'puppeteer';
import { PuppeteerPoolService } from './puppeteer-pool.service';

jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn(),
  rm: jest.fn(),
}));

// O Puppeteer 25 é ESM puro — sem o transformIgnorePatterns em jest.config.js
// liberando esse pacote (e puppeteer-core/@puppeteer/browsers/chromium-bidi)
// para o ts-jest reescrever como CommonJS, este `jest.mock` nem chegaria a
// carregar o módulo real: a suíte inteira quebraria com
// "SyntaxError: Unexpected token 'export'" assim que qualquer arquivo
// alcançasse (mesmo transitivamente) o pool de browsers do PDF.
jest.mock('puppeteer', () => ({
  launch: jest.fn(),
  executablePath: jest.fn(),
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
    const launchSpy = jest
      .spyOn(puppeteer, 'launch')
      .mockResolvedValue(browser);

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
    jest
      .spyOn(puppeteer, 'launch')
      .mockRejectedValue(new Error('launch failed'));

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

    // `executablePath()` passou a devolver Promise<string> no Puppeteer 25.
    jest
      .spyOn(puppeteer, 'executablePath')
      .mockResolvedValue(
        '/workspace/backend/.cache/puppeteer/chrome/linux/chrome',
      );
    const launchSpy = jest
      .spyOn(puppeteer, 'launch')
      .mockResolvedValue(browser);

    await service['launchBrowser']();

    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath:
          '/workspace/backend/.cache/puppeteer/chrome/linux/chrome',
      }),
    );
  });

  it('serializa o bootstrap e não lança browsers além do pool em concorrência', async () => {
    process.env.PDF_BROWSER_POOL_SIZE = '2';
    let launchCount = 0;
    const browser = {
      connected: true,
      process: jest.fn(() => ({ pid: 9000 })),
      close: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockImplementation(() =>
        Promise.resolve({
          setDefaultTimeout: jest.fn(),
          setDefaultNavigationTimeout: jest.fn(),
          setJavaScriptEnabled: jest.fn().mockResolvedValue(undefined),
          on: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined),
          setContent: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    } as never;
    jest.spyOn(puppeteer, 'launch').mockImplementation(async () => {
      launchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return browser;
    });

    const service = new PuppeteerPoolService();
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const page = await service.getPage();
        await new Promise((resolve) => setTimeout(resolve, 2));
        await service.releasePage(page);
      }),
    );
    await service.onModuleDestroy();

    expect(launchCount).toBeLessThanOrEqual(2);
  });

  it('retorna estatísticas após liberar a página do probe', async () => {
    const page = {
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      setJavaScriptEnabled: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      setContent: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const browser = {
      connected: true,
      process: jest.fn(() => ({ pid: 9010 })),
      close: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockResolvedValue(page),
    } as never;
    jest.spyOn(puppeteer, 'launch').mockResolvedValue(browser);

    const service = new PuppeteerPoolService();
    await expect(service.probeRuntime()).resolves.toMatchObject({
      stats: { inUse: 0, available: 1 },
    });
    expect(page.close).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('fecha a página quando a configuração segura falha', async () => {
    process.env.PDF_BROWSER_POOL_SIZE = '1';
    const page = {
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      setJavaScriptEnabled: jest
        .fn()
        .mockRejectedValue(new Error('javascript setup failed')),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const browser = {
      connected: true,
      process: jest.fn(() => ({ pid: 9020 })),
      close: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockResolvedValue(page),
    } as never;
    jest.spyOn(puppeteer, 'launch').mockResolvedValue(browser);

    const service = new PuppeteerPoolService();

    await expect(service.getPage()).rejects.toThrow('javascript setup failed');

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(service.getPoolStats()).toMatchObject({
      total: 1,
      inUse: 0,
      available: 1,
    });
    await service.onModuleDestroy();
  });
});
