import { Test, type TestingModule } from '@nestjs/testing';
import type { Page } from 'puppeteer';
import { PuppeteerPoolService } from '../../src/shared/services/puppeteer-pool.service';

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;

describeE2E('E2E PDF runtime — Puppeteer/Jest lifecycle', () => {
  let moduleRef: TestingModule;
  let pool: PuppeteerPoolService;
  let page: Page | undefined;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [PuppeteerPoolService],
    }).compile();
    await moduleRef.init();
    pool = moduleRef.get(PuppeteerPoolService);
  }, 120_000);

  afterEach(async () => {
    if (page) {
      await pool.releasePage(page);
      page = undefined;
    }
  });

  afterAll(async () => {
    await moduleRef.close();
  }, 120_000);

  it('gera bytes PDF reais e fecha page/pool antes do teardown do Jest', async () => {
    page = await pool.getPage();
    await page.setContent(
      '<!doctype html><html><body><h1>APR PDF runtime smoke</h1></body></html>',
      { waitUntil: 'load' },
    );

    const pdf = await page.pdf({ format: 'A4', printBackground: false });
    const bytes = Buffer.from(pdf);

    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, 120_000);

  it('reutiliza o browser para aquisições concorrentes sem importar no destroy', async () => {
    const pages = await Promise.all(
      Array.from({ length: 2 }, () => pool.getPage()),
    );
    try {
      expect(pages).toHaveLength(2);
      expect(pool.getPoolStats().total).toBeLessThanOrEqual(
        pool.getPoolStats().poolSize,
      );
    } finally {
      await Promise.all(pages.map((candidate) => pool.releasePage(candidate)));
    }
  }, 120_000);
});
