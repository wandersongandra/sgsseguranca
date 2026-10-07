import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(relativePath: string) {
  return readFileSync(join(__dirname, relativePath), 'utf8');
}

describe('mobile surgical responsive patterns', () => {
  it('mantém tabelas técnicas do visualizador de RDO empilháveis no mobile', () => {
    const source = read('../../src/components/rdos/RdoViewerModal.tsx');

    expect(source.match(/ds-mobile-stack-table/g)?.length).toBe(3);
    expect(source).toContain('data-label="Função"');
    expect(source).toContain('data-label="Equipamento"');
    expect(source).toContain('data-label="Descrição"');
    expect(source).toContain('data-label="Qtd"');
  });

  it('mantém os modais legados de RDO no contrato de sheet mobile', () => {
    const actionModals = read('../../src/components/rdos/RdoActionModals.tsx');
    const page = read('relatorios/rdos/RdoPage.tsx');

    expect(actionModals.match(/ds-legacy-modal-shell/g)?.length).toBe(2);
    expect(page.match(/ds-legacy-modal-shell/g)?.length).toBe(2);
    expect(page).not.toContain(
      'className="fixed inset-0 z-[60] flex items-center justify-center',
    );
  });

  it('mantém a NC compacta, com stepper touch e câmera sem largura concorrente', () => {
    const source = read('../../src/components/NonConformityForm.tsx');

    expect(source).toContain('ds-mobile-step-nav');
    expect(source).toContain('min-h-11 snap-start');
    expect(source).toContain('sst-card p-4 sm:p-6');
    expect(source).not.toContain('w-[calc(100vw-2rem)] max-w-lg');
  });

  it('mantém DDS sem decoração de dashboard e com densidade mobile reduzida', () => {
    const source = read('../../src/components/DdsForm.tsx');

    expect(source).toContain('dds-form-stack');
    expect(source.match(/dds-mobile-card/g)?.length).toBe(3);
    expect(source).toContain('Preparação do DDS');
    expect(source).not.toContain('Condução guiada');
    expect(source).not.toContain('linear-gradient');
  });

  it('mantém steppers de PT e APR compactáveis no mobile', () => {
    const pt = read('pts/components/PtForm.tsx');
    const apr = read('aprs/components/AprForm.tsx');

    expect(pt).toContain('pt-stepper-card');
    expect(pt).toContain('pt-stepper-list');
    expect(pt).not.toContain('navegação reduzida para celular');

    expect(apr).toContain('apr-mobile-step-list');
    expect(apr).toContain('apr-mobile-step-item');
    expect(apr).toContain('grid grid-cols-2 gap-2 sm:grid-cols-3');
    expect(apr).not.toContain('Obra / celular');
  });

  it('mantém menus e filtros avançados adaptados para telas estreitas', () => {
    const actionMenu = read('../../src/components/ActionMenu.tsx');
    const filters = read('aprs/components/AprAdvancedFiltersDrawer.tsx');
    const css = read('../globals.css');

    expect(actionMenu).toContain('ds-action-menu-panel');
    expect(filters).toContain('apr-advanced-filters-drawer');
    expect(filters).toContain('hidden space-y-2 md:block');
    expect(css).toContain('.ds-action-menu-panel');
    expect(css).toContain('.ds-mobile-stack-table td::before');
    expect(css).toContain('.pt-stepper-list');
    expect(css).toContain('.apr-mobile-step-list');
  });
});
