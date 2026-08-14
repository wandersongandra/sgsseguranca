import { createRequire } from 'node:module';
import type { PuppeteerNode } from 'puppeteer';

type PuppeteerModule = Pick<PuppeteerNode, 'launch' | 'executablePath'>;
type PuppeteerImport = PuppeteerModule & { default?: PuppeteerModule };

const requireFromRuntime = createRequire(__filename);

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<PuppeteerImport>;

let modulePromise: Promise<PuppeteerModule> | undefined;

function normalizePuppeteerModule(module: PuppeteerImport): PuppeteerModule {
  const resolved = module.default ?? module;
  return {
    launch: resolved.launch,
    executablePath: resolved.executablePath,
  };
}

/**
 * Puppeteer 25 is ESM-only. Keeping the import lazy prevents the CJS Jest
 * worker from trying to require the ESM package while still loading it
 * normally in the production worker when PDF generation is requested.
 */
export function loadPuppeteer(): Promise<PuppeteerModule> {
  if (!modulePromise) {
    // Node 24 can synchronously require Puppeteer's ESM-compatible export.
    // Jest must use that path: a pending VM import can resolve after Jest has
    // started tearing down the environment (RC-05). Production Node 20 keeps
    // the native ESM path because require(ESM) is not available there.
    if (process.env.JEST_WORKER_ID) {
      modulePromise = Promise.resolve(
        normalizePuppeteerModule(
          requireFromRuntime('puppeteer') as PuppeteerImport,
        ),
      );
    } else {
      modulePromise = dynamicImport('puppeteer').then(normalizePuppeteerModule);
    }
  }
  return modulePromise;
}
