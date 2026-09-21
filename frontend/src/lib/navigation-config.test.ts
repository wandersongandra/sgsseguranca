import { Permission } from '@/lib/permissions';
import {
  getActiveNavigationItem,
  getVisibleNavigationItems,
  navigationItems,
} from './navigation-config';

const allowAll = { hasPermission: () => true, isAdmin: true, featureFlags: { ai: true } } as const;

describe('navigation-config', () => {
  it('mantém ids únicos e metadados obrigatórios no catálogo único', () => {
    expect(new Set(navigationItems.map((item) => item.id)).size).toBe(navigationItems.length);
    for (const item of navigationItems) {
      expect(item.label).toBeTruthy();
      expect(item.href).toMatch(/^\/dashboard/);
      expect(item.matchPrefixes.length).toBeGreaterThan(0);
      expect(item.surfaces.length).toBeGreaterThan(0);
      expect(Number.isFinite(item.priority)).toBe(true);
    }
  });

  it('preserva paridade dos dados compartilhados por sidebar, mobile e comandos', () => {
    const surfaces = ['sidebar', 'mobile', 'command'] as const;
    for (const surface of surfaces) {
      for (const visible of getVisibleNavigationItems(surface, allowAll)) {
        expect(navigationItems.find((item) => item.id === visible.id)).toBe(visible);
      }
    }
    const common = getVisibleNavigationItems('sidebar', allowAll).filter((item) => item.surfaces.includes('command'));
    const commandIds = new Set(getVisibleNavigationItems('command', allowAll).map((item) => item.id));
    expect(common.every((item) => commandIds.has(item.id))).toBe(true);
  });

  it('aplica permissão, administração e feature flags sem alterar route guards', () => {
    const denied = getVisibleNavigationItems('sidebar', {
      hasPermission: () => false,
      isAdmin: false,
      featureFlags: { ai: false },
    });
    expect(denied.some((item) => item.permission)).toBe(false);
    expect(denied.some((item) => item.admin)).toBe(false);
    expect(denied.some((item) => item.featureFlag === 'ai')).toBe(false);

    const documents = getVisibleNavigationItems('mobile', {
      hasPermission: (permission) => permission === Permission.CAN_VIEW_DOCUMENTS_REGISTRY,
      isAdmin: false,
      featureFlags: { ai: false },
    });
    expect(documents.map((item) => item.id)).toContain('document-registry');
  });

  it('mantém /new, /edit/[id] e detalhes ativos e vence pelo maior prefixo', () => {
    expect(getActiveNavigationItem('/dashboard/aprs/new')?.id).toBe('aprs');
    expect(getActiveNavigationItem('/dashboard/aprs/edit/42')?.id).toBe('aprs');
    expect(getActiveNavigationItem('/dashboard/aprs/42/detalhes')?.id).toBe('aprs');
    // Sub-rotas de categorias de modelos foram removidas (#252): a rota
    // operacionais/* agora resolve para a Central de modelos.
    expect(getActiveNavigationItem('/dashboard/checklist-models/operacionais/edit/1')?.id).toBe('checklist-models');
    expect(getActiveNavigationItem('/dashboarding')).toBeUndefined();
  });

  it('mantém Auditorias e Inspeções em um único entry point canônico', () => {
    const audits = navigationItems.find((item) => item.id === 'audits');

    expect(audits?.label).toBe('Auditorias e Inspeções');
    expect(audits?.href).toBe('/dashboard/audits');
    expect(audits?.permission).toBe(Permission.CAN_VIEW_AUDITS);
    expect(getActiveNavigationItem('/dashboard/inspections')?.id).toBe('audits');
    expect(getActiveNavigationItem('/dashboard/inspections?site=site-a')?.id).toBe('audits');
  });

  it('não exibe a superfície para quem não tem a permissão de auditoria', () => {
    const visible = getVisibleNavigationItems('sidebar', {
      hasPermission: () => false,
      isAdmin: false,
    });

    expect(visible.some((item) => item.id === 'audits')).toBe(false);
  });
});
