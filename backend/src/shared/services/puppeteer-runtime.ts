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
  return { launch: resolved.launch, executablePath: resolved.executablePath };
}

/** Puppeteer 25 is ESM-only; resolve it lazily so CJS Jest can mock the runtime. */
export function loadPuppeteer(): Promise<PuppeteerModule> {
  if (!modulePromise) {
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
