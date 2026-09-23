import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const pages = [
  'cats/page.tsx',
  'corrective-actions/page.tsx',
  'trainings/page.tsx',
  'medical-exams/page.tsx',
  'epi-fichas/page.tsx',
];

const nativeConfirmConsumers = [
  'activities/page.tsx',
  'audits/page.tsx',
  'checklist-models/components/ChecklistModelsView.tsx',
  'checklists/hooks/useChecklists.tsx',
  'dids/hooks/useDids.ts',
  'epis/page.tsx',
  'expenses/[id]/page.tsx',
  'machines/page.tsx',
  'photographic-reports/components/PhotographicReportWorkspace.tsx',
  'risks/hooks/useRisks.ts',
  'service-orders/page.tsx',
  'sites/page.tsx',
  'tools/page.tsx',
];

// A marcação de mobile-card pode estar inline em page.tsx ou extraída para um
// componente irmão co-localizado (ex.: CatMobileCard.tsx, TrainingMobileCard.tsx).
function pageAndSiblingSources(relativePath: string): string {
  const absolutePath = join(__dirname, relativePath);
  const dir = dirname(absolutePath);
  const pageSource = readFileSync(absolutePath, 'utf8');
  const siblingSources = readdirSync(dir)
    .filter((name) => /MobileCard\.tsx$/.test(name))
    .map((name) => readFileSync(join(dir, name), 'utf8'));
  return [pageSource, ...siblingSources].join('\n');
}

describe('administrative wave B responsive and accessible pattern', () => {
  it.each(pages)('%s uses one responsive desktop-table/mobile-card list', (relativePath) => {
    const source = readFileSync(join(__dirname, relativePath), 'utf8');
    const combinedSource = pageAndSiblingSources(relativePath);

    expect(source).toContain('ResponsiveDataList');
    expect(source).toContain('mobileClassName="space-y-3 p-3"');
    expect(combinedSource).toContain('<article');
    expect(source).toContain('<Table>');
  });

  it.each(['cats/page.tsx', 'trainings/page.tsx', 'medical-exams/page.tsx', 'epi-fichas/page.tsx'])(
    '%s does not use blocking browser prompt/confirm dialogs',
    (relativePath) => {
      const source = readFileSync(join(__dirname, relativePath), 'utf8');
      expect(source).not.toContain('window.prompt(');
      expect(source).not.toContain('window.confirm(');
      expect(source).not.toContain('if (!confirm(');
      expect(source).toMatch(/ModalFrame|ConfirmModal/);
    },
  );

  it.each(nativeConfirmConsumers)('%s uses the shared accessible confirmation action', (relativePath) => {
    const source = readFileSync(join(__dirname, relativePath), 'utf8');

    expect(source).not.toMatch(/\bconfirm\(/);
    expect(source).not.toContain('window.confirm');
    expect(source).toContain('useConfirmAction');
  });
});
