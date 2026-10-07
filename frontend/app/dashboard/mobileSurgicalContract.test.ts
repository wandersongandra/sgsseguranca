import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('contrato mobile cirúrgico do SGS', () => {
  it('habilita safe area real do iOS e viewport dinâmica', () => {
    const layout = readFileSync(join(__dirname, '../layout.tsx'), 'utf8');
    const globals = readFileSync(join(__dirname, '../globals.css'), 'utf8');

    expect(layout).toContain('viewportFit: "cover"');
    expect(globals).toContain('100dvh');
    expect(globals).toContain('--ds-safe-area-bottom');
    expect(globals).toContain('.ds-mobile-nav');
  });

  it('mantém modais e barras de ação dentro da viewport mobile', () => {
    const globals = readFileSync(join(__dirname, '../globals.css'), 'utf8');

    expect(globals).toContain('.ds-modal-shell');
    expect(globals).toContain('max-height: calc(100dvh');
    expect(globals).toContain('.ds-mobile-action-bar');
    expect(globals).toContain('var(--ds-mobile-nav-total-height)');
  });

  it('usa uma única árvore interativa nas listas responsivas', () => {
    const responsiveList = readFileSync(
      join(__dirname, '../../src/components/ui/responsive-data-list.tsx'),
      'utf8',
    );

    expect(responsiveList).toContain('role="list"');
    expect(responsiveList).toContain('role="listitem"');
    expect(responsiveList).toContain('useSyncExternalStore');
  });

  it.each([
    'dds/page.tsx',
    'dids/page.tsx',
    'arrs/page.tsx',
    'medical-exams/page.tsx',
    'nonconformities/page.tsx',
    'service-orders/page.tsx',
    'corrective-actions/page.tsx',
    'document-pendencies/page.tsx',
    'relatorios/rdos/RdoPage.tsx',
  ])('%s usa o contrato compartilhado de card mobile', (relativePath) => {
    const source = readFileSync(join(__dirname, relativePath), 'utf8');

    expect(source).toContain('ds-mobile-card');
  });

  it('mantém SOPHIE dentro da viewport dinâmica e acima da navegação inferior', () => {
    const source = readFileSync(
      join(__dirname, '../../src/components/AIChatPanel.tsx'),
      'utf8',
    );

    expect(source).toContain('100dvh');
    expect(source).toContain('var(--ds-mobile-nav-total-height)');
  });
});
