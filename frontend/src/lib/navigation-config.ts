import type { ComponentType } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  ClipboardX,
  Construction,
  FileLock2,
  FileText,
  GraduationCap,
  HardHat,
  LayoutDashboard,
  LineChart,
  Map,
  MapPin,
  MessageSquare,
  PlusCircle,
  Radio,
  Receipt,
  Settings,
  Shield,
  Sparkles,
  Stethoscope,
  Upload,
  UserRound,
  Users,
  Wrench,
} from 'lucide-react';
import { Permission, type AppPermission } from '@/lib/permissions';
import { isTemporarilyVisibleDashboardRoute } from '@/lib/temporarilyHiddenModules';

export type NavigationSurface = 'sidebar' | 'mobile' | 'command';
export type NavigationFeatureFlag = 'ai';
export type NavigationIcon = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

export type NavigationItem = {
  id: string;
  label: string;
  href: string;
  matchPrefixes: readonly string[];
  icon: NavigationIcon;
  section: string;
  permission?: AppPermission;
  admin?: 'admin' | 'super-admin';
  featureFlag?: NavigationFeatureFlag;
  surfaces: readonly NavigationSurface[];
  priority: number;
  description?: string;
  keywords?: readonly string[];
};

export const navigationSections = [
  { id: 'estrutura', label: 'Início', defaultOpen: true },
  { id: 'gestao-empresa', label: 'Empresa', defaultOpen: false },
  { id: 'operacao', label: 'Campo e Operação', defaultOpen: true },
  { id: 'relatorios', label: 'Relatórios', defaultOpen: false },
  { id: 'saude-ocupacional', label: 'Saúde ocupacional', defaultOpen: false },
  { id: 'cadastros-operacionais', label: 'Cadastros operacionais', defaultOpen: false },
  { id: 'checklists', label: 'Checklists', defaultOpen: false },
  { id: 'principal', label: 'Conformidade', defaultOpen: false },
  { id: 'sistema', label: 'Sistema', defaultOpen: false },
] as const;

const S: NavigationSurface[] = ['sidebar', 'command'];
const all: NavigationSurface[] = ['sidebar', 'mobile', 'command'];
const item = (
  value: Omit<NavigationItem, 'matchPrefixes'> & { matchPrefixes?: readonly string[] },
): NavigationItem => ({
  ...value,
  matchPrefixes: value.matchPrefixes ?? [value.href],
});

export const navigationItems: readonly NavigationItem[] = [
  item({
    id: 'dashboard',
    label: 'Painel',
    href: '/dashboard',
    icon: LayoutDashboard,
    section: 'estrutura',
    surfaces: all,
    priority: 1,
    description: 'Cockpit executivo e visão geral',
    keywords: ['home', 'cockpit'],
  }),
  item({
    id: 'companies',
    label: 'Empresas',
    href: '/dashboard/companies',
    icon: Building2,
    section: 'gestao-empresa',
    admin: 'admin',
    surfaces: S,
    priority: 20,
  }),
  item({
    id: 'sites',
    label: 'Obras/Setores',
    href: '/dashboard/sites',
    icon: MapPin,
    section: 'gestao-empresa',
    permission: Permission.CAN_MANAGE_SITES,
    surfaces: S,
    priority: 21,
  }),
  item({
    id: 'employees',
    label: 'Funcionários',
    href: '/dashboard/employees',
    icon: Users,
    section: 'gestao-empresa',
    surfaces: S,
    priority: 22,
    keywords: ['colaborador', 'mobilização'],
  }),
  item({
    id: 'worker-timeline',
    label: 'Timeline do trabalhador',
    href: '/dashboard/workers/timeline',
    icon: UserRound,
    section: 'gestao-empresa',
    surfaces: ['command'],
    priority: 22.5,
    description: 'Consulta consolidada por CPF',
    keywords: ['trabalhador', 'cpf', 'mobilização'],
  }),
  item({
    id: 'users',
    label: 'Usuários e acesso',
    href: '/dashboard/users',
    icon: Shield,
    section: 'gestao-empresa',
    permission: Permission.CAN_MANAGE_USERS,
    surfaces: S,
    priority: 23,
  }),
  item({
    id: 'calendar',
    label: 'Calendário',
    href: '/dashboard/calendar',
    icon: CalendarDays,
    section: 'gestao-empresa',
    permission: Permission.CAN_VIEW_CALENDAR,
    surfaces: S,
    priority: 24,
  }),

  item({
    id: 'tst',
    label: 'Campo',
    href: '/dashboard/tst',
    icon: Radio,
    section: 'operacao',
    surfaces: ['mobile', 'command'],
    priority: 2,
    description: 'Pendências do dia e fila offline',
    keywords: ['tst', 'offline', 'cpf'],
  }),
  item({
    id: 'dds',
    label: 'DDS',
    href: '/dashboard/dds',
    icon: MessageSquare,
    section: 'operacao',
    permission: Permission.CAN_VIEW_DDS,
    surfaces: S,
    priority: 30,
  }),
  item({
    id: 'dids',
    label: 'Início do Dia',
    href: '/dashboard/dids',
    icon: CalendarDays,
    section: 'operacao',
    permission: Permission.CAN_VIEW_DIDS,
    surfaces: ['command'],
    priority: 31,
  }),
  item({
    id: 'arrs',
    label: 'ARR',
    href: '/dashboard/arrs',
    icon: AlertTriangle,
    section: 'operacao',
    permission: Permission.CAN_VIEW_ARRS,
    surfaces: ['command'],
    priority: 32,
  }),
  item({
    id: 'pts',
    label: 'PTs',
    href: '/dashboard/pts',
    icon: FileLock2,
    section: 'operacao',
    surfaces: all,
    priority: 4,
    description: 'Permissões de trabalho e bloqueios',
    keywords: ['pt', 'liberação'],
  }),
  item({
    id: 'aprs',
    label: 'APRs',
    href: '/dashboard/aprs',
    icon: FileText,
    section: 'operacao',
    surfaces: all,
    priority: 3,
    description: 'Análise preliminar de risco',
    keywords: ['apr', 'perigos'],
  }),
  item({
    id: 'document-registry',
    label: 'Docs',
    href: '/dashboard/document-registry',
    icon: Archive,
    section: 'operacao',
    permission: Permission.CAN_VIEW_DOCUMENTS_REGISTRY,
    surfaces: ['mobile', 'command'],
    priority: 5,
    description: 'Registry documental e rastreabilidade',
  }),
  item({
    id: 'expenses',
    label: 'Despesas',
    href: '/dashboard/expenses',
    icon: Receipt,
    section: 'operacao',
    permission: Permission.CAN_VIEW_EXPENSES,
    surfaces: S,
    priority: 33,
  }),
  item({
    id: 'nonconformities',
    label: 'Não conformidades',
    href: '/dashboard/nonconformities',
    icon: AlertTriangle,
    section: 'operacao',
    permission: Permission.CAN_VIEW_NC,
    surfaces: S,
    priority: 34,
  }),
  item({
    id: 'audits',
    label: 'Auditorias',
    href: '/dashboard/audits',
    icon: ClipboardX,
    section: 'operacao',
    surfaces: S,
    priority: 35,
  }),
  item({
    id: 'sophie',
    label: 'SOPHIE',
    href: '/dashboard/sst-agent',
    icon: Sparkles,
    section: 'operacao',
    featureFlag: 'ai',
    surfaces: S,
    priority: 36,
  }),

  item({
    id: 'reports',
    label: 'Central de relatórios',
    href: '/dashboard/relatorios',
    icon: BarChart3,
    section: 'relatorios',
    permission: Permission.CAN_VIEW_DASHBOARD,
    surfaces: S,
    priority: 40,
  }),
  item({
    id: 'photo-report',
    label: 'Relatório fotográfico',
    href: '/dashboard/relatorios/fotografico',
    icon: FileText,
    section: 'relatorios',
    permission: Permission.CAN_VIEW_DASHBOARD,
    surfaces: ['command'],
    priority: 41,
  }),
  item({
    id: 'rdo',
    label: 'RDO',
    href: '/dashboard/relatorios/rdos',
    icon: BookOpen,
    section: 'relatorios',
    permission: Permission.CAN_VIEW_DASHBOARD,
    surfaces: ['command'],
    priority: 42,
  }),

  item({
    id: 'trainings',
    label: 'Treinamentos',
    href: '/dashboard/trainings',
    icon: GraduationCap,
    section: 'saude-ocupacional',
    permission: Permission.CAN_VIEW_TRAININGS,
    surfaces: S,
    priority: 50,
  }),
  item({
    id: 'medical',
    label: 'Exames médicos',
    href: '/dashboard/medical-exams',
    icon: Stethoscope,
    section: 'saude-ocupacional',
    permission: Permission.CAN_VIEW_MEDICAL_EXAMS,
    surfaces: S,
    priority: 51,
  }),
  item({
    id: 'epi-fichas',
    label: 'Fichas de EPI',
    href: '/dashboard/epi-fichas',
    icon: FileText,
    section: 'saude-ocupacional',
    permission: Permission.CAN_VIEW_EPI_ASSIGNMENTS,
    surfaces: S,
    priority: 52,
  }),

  item({
    id: 'activities',
    label: 'Atividades',
    href: '/dashboard/activities',
    icon: HardHat,
    section: 'cadastros-operacionais',
    permission: Permission.CAN_VIEW_ACTIVITIES,
    surfaces: S,
    priority: 60,
  }),
  item({
    id: 'risks',
    label: 'Riscos',
    href: '/dashboard/risks',
    icon: AlertTriangle,
    section: 'cadastros-operacionais',
    permission: Permission.CAN_VIEW_RISKS,
    surfaces: S,
    priority: 61,
  }),
  item({
    id: 'epis',
    label: 'EPIs',
    href: '/dashboard/epis',
    icon: Shield,
    section: 'cadastros-operacionais',
    permission: Permission.CAN_MANAGE_CATALOGS,
    surfaces: S,
    priority: 62,
  }),
  item({
    id: 'tools',
    label: 'Ferramentas',
    href: '/dashboard/tools',
    icon: Wrench,
    section: 'cadastros-operacionais',
    permission: Permission.CAN_MANAGE_CATALOGS,
    surfaces: S,
    priority: 63,
  }),
  item({
    id: 'machines',
    label: 'Máquinas',
    href: '/dashboard/machines',
    icon: Construction,
    section: 'cadastros-operacionais',
    permission: Permission.CAN_MANAGE_CATALOGS,
    surfaces: S,
    priority: 64,
  }),

  item({
    id: 'checklist-models',
    label: 'Central de modelos',
    href: '/dashboard/checklist-models',
    icon: ClipboardList,
    section: 'checklists',
    permission: Permission.CAN_VIEW_CHECKLISTS,
    surfaces: S,
    priority: 70,
  }),
  item({
    id: 'checklists',
    label: 'Execuções',
    href: '/dashboard/checklists',
    icon: ClipboardCheck,
    section: 'checklists',
    permission: Permission.CAN_VIEW_CHECKLISTS,
    surfaces: S,
    priority: 76,
  }),
  item({
    id: 'checklists-new',
    label: 'Novo checklist',
    href: '/dashboard/checklists/new',
    icon: PlusCircle,
    section: 'checklists',
    permission: Permission.CAN_MANAGE_CHECKLISTS,
    surfaces: ['command'],
    priority: 77,
    description: 'Abrir formulário de criação',
  }),
  item({
    id: 'checklist-models-new',
    label: 'Novo modelo de checklist',
    href: '/dashboard/checklist-models/new',
    icon: PlusCircle,
    section: 'checklists',
    permission: Permission.CAN_MANAGE_CHECKLISTS,
    surfaces: ['command'],
    priority: 78,
    description: 'Criar template de checklist',
  }),
  item({
    id: 'checklist-model-operational-new',
    label: 'Novo modelo operacional',
    href: '/dashboard/checklist-models/new?categoria=Operacional',
    matchPrefixes: ['/dashboard/checklist-models/new'],
    icon: PlusCircle,
    section: 'checklists',
    permission: Permission.CAN_MANAGE_CHECKLISTS,
    surfaces: ['command'],
    priority: 79,
  }),
  item({
    id: 'checklist-model-equipment-new',
    label: 'Novo modelo de equipamentos',
    href: '/dashboard/checklist-models/new?categoria=Equipamento',
    matchPrefixes: ['/dashboard/checklist-models/new'],
    icon: PlusCircle,
    section: 'checklists',
    permission: Permission.CAN_MANAGE_CHECKLISTS,
    surfaces: ['command'],
    priority: 79.1,
  }),
  item({
    id: 'checklist-model-epi-new',
    label: 'Novo modelo de EPI',
    href: '/dashboard/checklist-models/new?categoria=EPI',
    matchPrefixes: ['/dashboard/checklist-models/new'],
    icon: PlusCircle,
    section: 'checklists',
    permission: Permission.CAN_MANAGE_CHECKLISTS,
    surfaces: ['command'],
    priority: 79.2,
  }),

  item({
    id: 'cats',
    label: 'CATs',
    href: '/dashboard/cats',
    icon: AlertCircle,
    section: 'principal',
    surfaces: S,
    priority: 80,
  }),
  item({
    id: 'document-pendencies',
    label: 'Pendências documentais',
    href: '/dashboard/document-pendencies',
    icon: Shield,
    section: 'principal',
    permission: Permission.CAN_VIEW_DASHBOARD,
    surfaces: S,
    priority: 81,
  }),
  item({
    id: 'risk-map',
    label: 'Mapa de risco',
    href: '/dashboard/risk-map',
    icon: Map,
    section: 'principal',
    surfaces: S,
    priority: 82,
  }),
  item({
    id: 'corrective-actions',
    label: 'Ações corretivas',
    href: '/dashboard/corrective-actions',
    icon: CheckSquare,
    section: 'principal',
    surfaces: S,
    priority: 83,
  }),
  item({
    id: 'kpis',
    label: 'Indicadores',
    href: '/dashboard/kpis',
    icon: BarChart3,
    section: 'principal',
    permission: Permission.CAN_VIEW_DASHBOARD,
    surfaces: ['command'],
    priority: 85,
  }),
  item({
    id: 'executive',
    label: 'Executivo',
    href: '/dashboard/executive',
    icon: LineChart,
    section: 'principal',
    permission: Permission.CAN_VIEW_DASHBOARD,
    surfaces: ['command'],
    priority: 86,
  }),
  item({
    id: 'document-import',
    label: 'Importar com IA',
    href: '/dashboard/documentos/importar',
    icon: Upload,
    section: 'sistema',
    featureFlag: 'ai',
    surfaces: S,
    priority: 89,
  }),
  item({
    id: 'settings',
    label: 'Configurações',
    href: '/dashboard/settings',
    icon: Settings,
    section: 'sistema',
    surfaces: S,
    priority: 90,
  }),
] as const;

export type NavigationAccess = {
  hasPermission: (permission: AppPermission) => boolean;
  isAdmin: boolean;
  featureFlags?: Partial<Record<NavigationFeatureFlag, boolean>>;
};

export function getVisibleNavigationItems(
  surface: NavigationSurface,
  access: NavigationAccess,
): NavigationItem[] {
  return navigationItems
    .filter((entry) => entry.surfaces.includes(surface))
    .filter((entry) => isTemporarilyVisibleDashboardRoute(entry.href))
    .filter((entry) => !entry.admin || access.isAdmin)
    .filter((entry) => !entry.permission || access.hasPermission(entry.permission))
    .filter((entry) => !entry.featureFlag || access.featureFlags?.[entry.featureFlag] === true)
    .sort((a, b) => a.priority - b.priority);
}

function prefixMatches(pathname: string, prefix: string): boolean {
  const clean = pathname.split(/[?#]/)[0] || '/';
  if (prefix === '/dashboard') return clean === prefix;
  return clean === prefix || clean.startsWith(`${prefix}/`);
}

/** Resolve ambiguidades escolhendo o item cujo prefixo correspondente é o mais específico. */
export function getActiveNavigationItem(
  pathname: string,
  items: readonly NavigationItem[] = navigationItems,
): NavigationItem | undefined {
  return items
    .flatMap((entry) =>
      entry.matchPrefixes
        .filter((prefix) => prefixMatches(pathname, prefix))
        .map((prefix) => ({ entry, length: prefix.length })),
    )
    .sort((a, b) => b.length - a.length)[0]?.entry;
}
