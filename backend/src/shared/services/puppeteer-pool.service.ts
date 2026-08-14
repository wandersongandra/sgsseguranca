import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Browser, LaunchOptions, Page } from 'puppeteer';
import {
  getPdfBrowserAcquireTimeoutMs,
  getPdfBrowserMaxUses,
  getPdfBrowserPoolSize,
  getPdfPageTimeoutMs,
} from './pdf-runtime-config';
import { loadPuppeteer } from './puppeteer-runtime';

interface PooledBrowser {
  id: number;
  browser: Browser;
  userDataDir: string;
  inUse: boolean;
  lastUsed: Date;
  useCount: number;
}

@Injectable()
export class PuppeteerPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerPoolService.name);
  private browserPool: PooledBrowser[] = [];
  private readonly poolSize = getPdfBrowserPoolSize();
  private readonly maxPageTimeout = getPdfPageTimeoutMs();
  private readonly acquireTimeoutMs = getPdfBrowserAcquireTimeoutMs();
  private readonly maxUsesPerBrowser = getPdfBrowserMaxUses();
  private cleanupInterval?: NodeJS.Timeout;
  private readonly startupPromises = new Map<number, Promise<void>>();
  private isClosing = false;

  onModuleInit() {
    this.isClosing = false;
    this.logger.log(
      `Inicializando pool de Puppeteer em modo lazy (poolSize=${this.poolSize}, pageTimeoutMs=${this.maxPageTimeout}, acquireTimeoutMs=${this.acquireTimeoutMs}, maxUsesPerBrowser=${this.maxUsesPerBrowser})`,
    );

    // Cleanup e manutenção a cada 1 minuto
    this.cleanupInterval = setInterval(() => {
      void this.maintenance();
    }, 60 * 1000);
    this.cleanupInterval.unref();
  }

  async onModuleDestroy() {
    this.logger.log('Fechando pool de Puppeteer');
    this.isClosing = true;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // A startup já iniciado pode ainda estar resolvendo o adapter ESM. Aguarde
    // esse trabalho antes de fechar o módulo; o destroy não cria recursos novos.
    await Promise.allSettled(this.startupPromises.values());
    await Promise.all(
      this.browserPool.map((b) => this.closeBrowserInstance(b)),
    );

    this.browserPool = [];
    this.startupPromises.clear();
  }

  async getPage(): Promise<Page> {
    if (this.isClosing) {
      throw new Error('Pool de Puppeteer está em encerramento.');
    }
    const requestStartedAt = Date.now();

    // Tentar obter um browser disponível
    let pooledBrowser = this.browserPool.find((b) => !b.inUse);

    if (!pooledBrowser) {
      if (this.browserPool.length < this.poolSize) {
        const nextId =
          this.browserPool.length === 0
            ? 0
            : Math.max(...this.browserPool.map((b) => b.id)) + 1;
        await this.addBrowserToPool(nextId);
        pooledBrowser = this.browserPool.find((b) => !b.inUse);
      }
      if (!pooledBrowser) {
        while (
          !pooledBrowser &&
          Date.now() - requestStartedAt < this.acquireTimeoutMs
        ) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          pooledBrowser = this.browserPool.find((b) => !b.inUse);
        }
      }
      if (!pooledBrowser) {
        const stats = this.getPoolStats();
        throw new Error(
          `Timeout aguardando browser disponível no pool (timeoutMs=${this.acquireTimeoutMs}, total=${stats.total}, inUse=${stats.inUse}, available=${stats.available})`,
        );
      }
    }

    // Verificar saúde do browser
    if (!pooledBrowser.browser.connected) {
      this.logger.warn(
        `Browser ${pooledBrowser.id} desconectado. Reiniciando...`,
      );
      await this.recycleBrowser(pooledBrowser);
    }

    // Verificar rotação por uso (evita memory leak do Chromium)
    if (pooledBrowser.useCount >= this.maxUsesPerBrowser) {
      this.logger.log(
        `Browser ${pooledBrowser.id} atingiu limite de uso (${pooledBrowser.useCount}). Reciclando...`,
      );
      await this.recycleBrowser(pooledBrowser);
    }

    pooledBrowser.inUse = true;
    pooledBrowser.lastUsed = new Date();
    pooledBrowser.useCount++;

    const waitMs = Date.now() - requestStartedAt;
    if (waitMs >= 2000) {
      this.logger.warn(
        `Browser ${pooledBrowser.id} liberado após espera de ${waitMs}ms (poolSize=${this.poolSize})`,
      );
    }

    try {
      const page = await pooledBrowser.browser.newPage();

      // Configurar timeout da página
      page.setDefaultTimeout(this.maxPageTimeout);
      page.setDefaultNavigationTimeout(this.maxPageTimeout);

      // Limpar listeners ao fechar página
      page.on('error', (error) => {
        this.logger.error('Erro na página:', error);
      });

      return page;
    } catch (error) {
      pooledBrowser.inUse = false;
      this.logger.error(
        `Erro ao criar página no browser ${pooledBrowser.id}:`,
        error,
      );
      if (!pooledBrowser.browser.connected) {
        await this.recycleBrowser(pooledBrowser);
      }
      throw error;
    }
  }

  async releasePage(page: Page): Promise<void> {
    try {
      await page.close();
    } catch (error) {
      this.logger.error('Erro ao fechar página:', error);
    }

    // Identificar corretamente o browser dono da página
    const browser = page.browser();
    const pooledBrowser = this.browserPool.find((b) => b.browser === browser);

    if (pooledBrowser) {
      pooledBrowser.inUse = false;
    } else {
      this.logger.warn(
        'Não foi possível identificar o browser pool para a página liberada.',
      );
    }
  }

  private async launchBrowser(): Promise<{
    browser: Browser;
    userDataDir: string;
  }> {
    const puppeteer = await loadPuppeteer();
    const resolvedBrowser = await this.resolveExecutablePath();
    const userDataDir = await mkdtemp(join(tmpdir(), 'sgs-pdf-chromium-'));
    const runtimeEnv = {
      ...process.env,
      HOME: process.env.HOME || userDataDir,
      XDG_CONFIG_HOME:
        process.env.XDG_CONFIG_HOME || join(userDataDir, '.config'),
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || join(userDataDir, '.cache'),
    };
    const launchOptions: LaunchOptions & { executablePath?: string } = {
      args: [
        // --no-sandbox é necessário em containers Docker sem user namespace isolation.
        // Mitigações compensatórias: (1) HTML gerado via setContent, nunca page.goto com URL externa;
        // (2) todos os dados interpolados no HTML são HTML-escaped; (3) request interception ativa
        // em pdf.service.ts bloqueando recursos de rede; (4) container executa como usuário não-root
        // (USER node no Dockerfile.worker); (5) PDF validado contra magic bytes + anti-JS patterns.
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--mute-audio',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--disable-crash-reporter',
        '--disable-features=Crashpad,TranslateUI,BlinkGenPropertyTrees',
        `--user-data-dir=${userDataDir}`,
        `--data-path=${userDataDir}`,
        `--disk-cache-dir=${userDataDir}`,
        `--crash-dumps-dir=${userDataDir}`,
      ],
      headless: true,
      env: runtimeEnv,
    };

    try {
      if (resolvedBrowser.executablePath) {
        launchOptions.executablePath = resolvedBrowser.executablePath;
      }
      if (resolvedBrowser.executablePath && !resolvedBrowser.exists) {
        this.logger.warn(
          `Chromium resolvido em caminho inexistente (${resolvedBrowser.source}): ${resolvedBrowser.executablePath}`,
        );
      }
      return {
        browser: await puppeteer.launch(launchOptions),
        userDataDir,
      };
    } catch (error) {
      await this.cleanupUserDataDir(userDataDir);
      const reason = error instanceof Error ? error.message : String(error);
      const resolution = resolvedBrowser.executablePath
        ? `${resolvedBrowser.source}:${resolvedBrowser.executablePath}`
        : `${resolvedBrowser.source}:auto`;
      throw new Error(
        `Falha ao iniciar Chromium (resolved=${resolution}, exists=${resolvedBrowser.exists}, cwd=${process.cwd()}, HOME=${runtimeEnv.HOME}, XDG_CONFIG_HOME=${runtimeEnv.XDG_CONFIG_HOME}, XDG_CACHE_HOME=${runtimeEnv.XDG_CACHE_HOME}): ${reason}`,
        { cause: error },
      );
    }
  }

  private async addBrowserToPool(id: number): Promise<void> {
    if (this.isClosing) {
      return;
    }

    const existingStartup = this.startupPromises.get(id);
    if (existingStartup) {
      await existingStartup;
      return;
    }

    const startup = (async () => {
      try {
        const { browser, userDataDir } = await this.launchBrowser();
        if (this.isClosing) {
          await this.closeBrowserInstance({
            id,
            browser,
            userDataDir,
            inUse: false,
            lastUsed: new Date(),
            useCount: 0,
          });
          return;
        }
        this.browserPool.push({
          id,
          browser,
          userDataDir,
          inUse: false,
          lastUsed: new Date(),
          useCount: 0,
        });
        this.logger.log(
          `Browser ${id} iniciado (PID: ${browser.process()?.pid})`,
        );
      } catch (error) {
        if (error instanceof Error) {
          this.logger.error(
            `Erro ao inicializar browser ${id}: ${error.message}`,
            error.stack,
          );
          return;
        }
        this.logger.error(
          `Erro ao inicializar browser ${id}: ${String(error)}`,
        );
      } finally {
        this.startupPromises.delete(id);
      }
    })();

    this.startupPromises.set(id, startup);
    try {
      await startup;
    } catch {
      // O startup já registra a causa técnica; callers continuam usando o
      // timeout seguro de aquisição sem expor detalhes do runtime.
    }
  }

  private async resolveExecutablePath(): Promise<{
    executablePath?: string;
    source: 'env' | 'puppeteer' | 'default';
    exists: boolean;
  }> {
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
    if (envPath) {
      return {
        executablePath: envPath,
        source: 'env',
        exists: existsSync(envPath),
      };
    }

    try {
      const puppeteer = await loadPuppeteer();
      const executablePath = await puppeteer.executablePath();
      return {
        executablePath,
        source: 'puppeteer',
        exists: existsSync(executablePath),
      };
    } catch {
      return {
        source: 'default',
        exists: false,
      };
    }
  }

  private async closeBrowserInstance(
    pooledBrowser: PooledBrowser,
  ): Promise<void> {
    try {
      const pid = pooledBrowser.browser.process()?.pid;
      await pooledBrowser.browser.close();
      this.logger.debug(`Browser ${pooledBrowser.id} (PID: ${pid}) fechado.`);
    } catch (error) {
      this.logger.warn(
        `Erro ao fechar browser ${pooledBrowser.id}, forçando kill...`,
        error,
      );
      try {
        pooledBrowser.browser.process()?.kill('SIGKILL');
      } catch (killError) {
        this.logger.error(
          `Falha fatal ao matar processo do browser ${pooledBrowser.id}`,
          killError,
        );
      }
    } finally {
      await this.cleanupUserDataDir(pooledBrowser.userDataDir);
    }
  }

  private async recycleBrowser(pooledBrowser: PooledBrowser): Promise<void> {
    await this.closeBrowserInstance(pooledBrowser);
    try {
      const { browser: newBrowser, userDataDir } = await this.launchBrowser();
      pooledBrowser.browser = newBrowser;
      pooledBrowser.userDataDir = userDataDir;
      pooledBrowser.inUse = false;
      pooledBrowser.lastUsed = new Date();
      pooledBrowser.useCount = 0;
      this.logger.log(
        `Browser ${pooledBrowser.id} reciclado (Novo PID: ${newBrowser.process()?.pid})`,
      );
    } catch (error) {
      this.logger.error(`Falha ao reciclar browser ${pooledBrowser.id}`, error);
      // Remove do pool se falhar na recriação para evitar uso de objeto morto
      this.browserPool = this.browserPool.filter(
        (b) => b.id !== pooledBrowser.id,
      );
    }
  }

  private async maintenance(): Promise<void> {
    const now = new Date();
    const maxInactiveTime = 5 * 60 * 1000; // 5 minutos

    for (const pooledBrowser of this.browserPool) {
      if (!pooledBrowser.browser.connected) {
        await this.recycleBrowser(pooledBrowser);
        continue;
      }

      if (
        !pooledBrowser.inUse &&
        now.getTime() - pooledBrowser.lastUsed.getTime() > maxInactiveTime
      ) {
        this.logger.log(`Limpando browser ${pooledBrowser.id} inativo`);
        await this.recycleBrowser(pooledBrowser);
      }
    }
  }

  getPoolStats() {
    const inUse = this.browserPool.filter((b) => b.inUse).length;
    const available = this.browserPool.filter((b) => !b.inUse).length;

    return {
      total: this.browserPool.length,
      inUse,
      available,
      poolSize: this.poolSize,
    };
  }

  private async cleanupUserDataDir(userDataDir?: string | null): Promise<void> {
    if (!userDataDir) {
      return;
    }

    try {
      await rm(userDataDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn(
        `Falha ao limpar diretório temporário do Chromium: ${userDataDir}`,
        error,
      );
    }
  }
}
