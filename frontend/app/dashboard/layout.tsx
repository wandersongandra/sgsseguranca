'use client';

import dynamic from 'next/dynamic';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { ApiStatusBanner } from '@/components/ApiStatusBanner';
import { OfflineCapabilityBanner } from '@/components/OfflineCapabilityBanner';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { PwaBootstrap } from '@/components/PwaBootstrap';
import { SentryUserContext } from '@/components/SentryUserContext';
import { StaleCacheBanner } from '@/components/StaleCacheBanner';
import { ResponsiveToaster } from '@/components/ResponsiveToaster';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { useRouter, usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { siteStore } from '@/lib/siteStore';
import { Company } from '@/services/companiesService';
import { AlertTriangle, Building2, ChevronsUpDown, HardHat } from 'lucide-react';
import { MobileFieldNav } from '@/components/MobileFieldNav';
import {
  isAdminRoute,
  isHiddenRoute,
  getRoutePermissionException,
} from '@/lib/route-config';
import { cn } from '@/lib/utils';

const CompanySelectorModal = dynamic(
  () => import('@/components/CompanySelectorModal'),
  { ssr: false },
);
const SiteSelectorModal = dynamic(
  () => import('@/components/SiteSelectorModal'),
  { ssr: false },
);
const OnboardingModal = dynamic(
  () =>
    import('@/components/OnboardingModal').then(
      (module) => module.OnboardingModal,
    ),
  { ssr: false },
);
const CommandPalette = dynamic(
  () =>
    import('@/components/CommandPalette').then(
      (module) => module.CommandPalette,
    ),
  { ssr: false },
);
const AIButton = dynamic(
  () => import('@/components/AIButton').then((module) => module.AIButton),
  { ssr: false },
);

function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, hasPermission, logout, isAdminGeral } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const [selectorOpen, setSelectorOpen] = useState(false);
  const [siteSelectorOpen, setSiteSelectorOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(() =>
    selectedTenantStore.get(),
  );
  const [selectedSite, setSelectedSite] = useState(() => siteStore.get());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarModal, setSidebarModal] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!loading && user && isAdminGeral && !selectedTenant) {
      setSelectorOpen(true);
    }
  }, [loading, user, isAdminGeral, selectedTenant]);

  useEffect(() => {
    const unsub = selectedTenantStore.subscribe((tenant) =>
      setSelectedTenant(tenant),
    );
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    const unsub = siteStore.subscribe((site) => setSelectedSite(site));
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
      return;
    }

    if (!loading && user && isHiddenRoute(pathname)) {
      router.push('/dashboard');
      return;
    }

    const permissionException = getRoutePermissionException(pathname);
    const hasExceptionPermission = permissionException
      ? hasPermission(permissionException)
      : false;

    if (
      !loading &&
      user &&
      isAdminRoute(pathname) &&
      !isAdminGeral &&
      !hasExceptionPermission
    ) {
      router.push('/dashboard');
    }
  }, [user, loading, router, pathname, hasPermission, isAdminGeral]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const handleSiteSelect = (site: { id: string; nome: string; company_id: string }) => {
    // Ao selecionar uma obra, também atualiza a empresa se necessário
    if (selectedTenant?.companyId !== site.company_id) {
      const company = { id: site.company_id };
      handleCompanySelect(company as Company);
    }
    // O SiteSelectorModal já atualiza o siteStore internamente
  };

  const handleCompanySelect = async (company: Company) => {
    const nextTenant = {
      companyId: company.id,
      companyName: company.razao_social,
    };
    await selectedTenantStore.set(nextTenant);
    setSelectedTenant(nextTenant);
    setSelectorOpen(false);
  };

  const handleLoginRedirect = () => {
    router.push('/login?expired=1');
  };

  // Mesma checagem do useEffect acima (linhas 102-127), calculada de forma
  // síncrona durante o render. Sem isso, {children} monta no mesmo ciclo em
  // que o usuário ainda está numa rota que ele não deveria ver — a página
  // filha pode chegar a disparar suas próprias chamadas de API antes do
  // router.push (assíncrono, dentro do useEffect) redirecionar. O backend é
  // a defesa real (RBAC), mas isso evita o flash de conteúdo e a chamada
  // desnecessária no frontend.
  const isCurrentRouteAuthorized = (() => {
    if (isHiddenRoute(pathname)) return false;
    const permissionException = getRoutePermissionException(pathname);
    const hasExceptionPermission = permissionException
      ? hasPermission(permissionException)
      : false;
    if (isAdminRoute(pathname) && !isAdminGeral && !hasExceptionPermission) {
      return false;
    }
    return true;
  })();

  const tenantRequired = Boolean(
    user && isAdminGeral && !selectedTenant,
  );

  if (loading || !isMounted || (user && !isCurrentRouteAuthorized)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-12 w-12 motion-safe:animate-spin rounded-full border-4 border-[var(--ds-color-action-primary)] border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--ds-color-bg-canvas)] px-6 text-center text-[var(--ds-color-text-primary)]">
        <div className="max-w-md rounded-2xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-5 shadow-[var(--ds-shadow-sm)]">
          <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">
            Sessão não encontrada
          </h2>
          <p className="mt-2 text-sm text-[var(--ds-color-text-secondary)]">
            Sua sessão expirou ou o acesso não foi carregado corretamente. Volte
            para o login e tente novamente.
          </p>
          <button
            type="button"
            onClick={handleLoginRedirect}
            className="mt-4 w-full rounded-xl bg-[var(--ds-color-action-primary)] px-4 py-2 text-[13px] font-semibold text-white motion-safe:transition-colors hover:bg-[var(--ds-color-action-primary-hover)]"
          >
            Ir para login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-dashboard-shell ds-shell-backdrop ds-system-scope ds-density-compact flex xl:flex-row">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onModalChange={setSidebarModal}
      />
      <div
        className="flex flex-1 flex-col overflow-hidden"
        inert={sidebarModal ? true : undefined}
        aria-hidden={sidebarModal ? true : undefined}
      >
        <Header onOpenMobileNav={openSidebar} />
        {isAdminGeral && (
          <div className="sticky top-0 z-40 flex min-h-12 items-center justify-between border-b border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] px-5 py-3">
            <div className="flex min-w-0 items-center gap-2 text-sm text-[var(--ds-color-warning-fg)]">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-warning-subtle)] shadow-[var(--ds-shadow-xs)]">
                <Building2 className="h-4 w-4 text-[var(--ds-color-warning-fg)]" />
              </span>
              {selectedTenant ? (
                <span className="min-w-0 whitespace-nowrap">
                  Operando em:{' '}
                  <AlertTriangle
                    size={14}
                    className="mr-1.5 inline align-text-bottom text-[var(--ds-color-warning-fg)]"
                    aria-hidden="true"
                  />
                  <span className="inline-block max-w-[200px] truncate align-bottom font-semibold text-[var(--ds-color-warning-fg)]">
                    {selectedTenant.companyName}
                  </span>
                </span>
              ) : (
                <span className="min-w-0 truncate font-medium text-[var(--ds-color-warning-fg)]">
                  Nenhuma empresa selecionada
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectorOpen(true)}
              className="ml-3 flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--ds-color-warning-border)] bg-[var(--ds-color-surface-base)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ds-color-warning-fg)] shadow-[var(--ds-shadow-xs)] motion-safe:transition-all hover:brightness-95"
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
              Trocar empresa
            </button>
          </div>
        )}
        {/* Banner de obra selecionada - para todos os usuários */}
        {selectedTenant && !selectedSite && (
          <div className="sticky top-0 z-30 flex min-h-10 items-center justify-between border-b border-blue-200 bg-blue-50 px-5 py-2 dark:border-blue-800 dark:bg-blue-950/30">
            <div className="flex min-w-0 items-center gap-2 text-sm text-blue-700 dark:text-blue-300">
              <span className="min-w-0 truncate font-medium">
                Nenhuma obra selecionada
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSiteSelectorOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              Selecionar obra
            </button>
          </div>
        )}
        {/* Banner de obra ativa */}
        {selectedTenant && selectedSite && (
          <div className="sticky top-0 z-30 flex min-h-10 items-center justify-between border-b border-amber-200 bg-amber-50 px-5 py-2 dark:border-amber-800 dark:bg-amber-950/30">
            <div className="flex min-w-0 items-center gap-2 text-sm text-amber-800 dark:text-amber-200">
              <HardHat className="h-4 w-4 shrink-0" />
              <span className="min-w-0 whitespace-nowrap">
                Obra:{' '}
                <span className="font-semibold">{selectedSite.siteName}</span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSiteSelectorOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-700 shadow-sm transition-colors hover:bg-amber-50 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-900"
            >
              <ChevronsUpDown className="h-3 w-3" />
              Trocar obra
            </button>
          </div>
        )}
        <ApiStatusBanner />
        <OfflineCapabilityBanner />
        <main
          id="main-content"
          className={cn(
            'ds-dashboard-content flex-1 overflow-y-auto px-4 py-4 sm:px-5 md:px-6 md:py-5 xl:px-8',
            isAdminGeral && 'pt-12 md:pt-12',
            selectedSite && 'pt-10 md:pt-10',
          )}
        >
          {tenantRequired ? (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
              <Building2 className="h-8 w-8 text-[var(--ds-color-warning-fg)]" />
              <p className="text-sm font-medium text-[var(--ds-color-text-primary)]">
                Selecione uma empresa para operar como Administrador Geral.
              </p>
            </div>
          ) : (
            children
          )}
        </main>
        <AIButton />
        <CommandPalette />
        <MobileFieldNav />
      </div>

      <CompanySelectorModal
        open={selectorOpen}
        onSelect={handleCompanySelect}
        onLogout={logout}
        currentCompanyId={selectedTenant?.companyId}
        onClose={() => setSelectorOpen(false)}
      />
      <SiteSelectorModal
        open={siteSelectorOpen}
        onSelect={handleSiteSelect}
        currentCompanyId={selectedTenant?.companyId || ''}
        currentSiteId={selectedSite?.siteId}
        onClose={() => setSiteSelectorOpen(false)}
      />
      <OnboardingModal userId={user?.id} />
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <AppErrorBoundary resetKey={pathname}>
      <AuthProvider>
        <SentryUserContext />
        <StaleCacheBanner />
        <PwaBootstrap />
        <DashboardShell>{children}</DashboardShell>
        <ResponsiveToaster />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
