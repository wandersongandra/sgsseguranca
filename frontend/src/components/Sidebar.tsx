'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, LogOut, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { isAiEnabled } from '@/lib/featureFlags';
import {
  getActiveNavigationItem,
  getVisibleNavigationItems,
  navigationSections,
} from '@/lib/navigation-config';
import { cn } from '@/lib/utils';

const DESKTOP_QUERY = '(min-width: 1280px)';

function useDesktopSidebar() {
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return isDesktop;
}

export function Sidebar({
  isOpen = false,
  onClose,
  onModalChange,
}: {
  isOpen?: boolean;
  onClose?: () => void;
  onModalChange?: (modal: boolean) => void;
}) {
  const pathname = usePathname();
  const { logout, user, hasPermission, isAdminGeral } = useAuth();
  const drawerRef = useRef<HTMLElement>(null);
  const isDesktop = useDesktopSidebar();
  const isModal = isOpen && !isDesktop;
  const isHiddenMobileDrawer = !isOpen && !isDesktop;
  useFocusTrap(drawerRef, isModal, onClose);

  useEffect(() => {
    onModalChange?.(isModal);
    return () => onModalChange?.(false);
  }, [isModal, onModalChange]);

  useEffect(() => {
    if (isDesktop && isOpen) onClose?.();
  }, [isDesktop, isOpen, onClose]);

  const visibleItems = useMemo(
    () => getVisibleNavigationItems('sidebar', {
      hasPermission,
      isAdmin: isAdminGeral,
      featureFlags: { ai: isAiEnabled() },
    }),
    [hasPermission, isAdminGeral],
  );
  const activeItem = getActiveNavigationItem(pathname, visibleItems);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navigationSections.map((section) => [section.id, section.defaultOpen])),
  );

  return (
    <>
      {isModal ? (
        <button
          type="button"
          aria-label="Fechar menu lateral"
          tabIndex={-1}
          onClick={onClose}
          className="fixed inset-0 z-40 bg-[color:var(--component-overlay)] xl:hidden"
        />
      ) : null}
      <aside
        ref={drawerRef}
        aria-label="Menu lateral"
        aria-hidden={isHiddenMobileDrawer ? true : undefined}
        aria-modal={isModal ? true : undefined}
        role={isModal ? 'dialog' : undefined}
        tabIndex={isModal ? -1 : undefined}
        inert={isHiddenMobileDrawer ? true : undefined}
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex h-full w-60 flex-col border-r border-[color:var(--chrome-sidebar-border)] bg-[var(--chrome-sidebar-bg-solid)] text-[var(--ds-color-sidebar-text)] shadow-[var(--chrome-sidebar-shadow)] transition-transform duration-300 ease-in-out xl:static xl:z-auto xl:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full xl:translate-x-0',
        )}
      >
        <div className="flex items-center gap-3 border-b border-[color:var(--chrome-sidebar-divider)] px-4 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--chrome-sidebar-logo-bg)] ring-1 ring-[var(--chrome-sidebar-logo-ring)]">
            <Image src="/logo-sgs-mark.svg?v=20260425" alt="SGS - Sistema de Gestão de Segurança" width={26} height={26} className="h-6.5 w-6.5 object-contain" priority />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-bold text-[var(--ds-color-sidebar-text)]">SGS</p>
            <p className="truncate text-[11px] text-[var(--ds-color-sidebar-muted)]">Sistema de Gestão de Segurança</p>
          </div>
          {isModal ? (
            <button type="button" onClick={onClose} aria-label="Fechar navegação" className="flex h-9 w-9 items-center justify-center rounded-lg xl:hidden">
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto scroll-smooth px-2 py-3">
          <nav aria-label="Módulos do sistema" className="py-1">
            {navigationSections.map((section) => {
              const items = visibleItems.filter((entry) => entry.section === section.id);
              if (!items.length) return null;
              const sectionActive = items.some((entry) => entry.id === activeItem?.id);
              const expanded = openSections[section.id] || sectionActive;
              return (
                <section key={section.id} className="pt-5 first:pt-2">
                  <button
                    type="button"
                    onClick={() => setOpenSections((current) => ({ ...current, [section.id]: !current[section.id] }))}
                    aria-expanded={expanded}
                    aria-controls={`sidebar-section-${section.id}`}
                    className="flex w-full items-center justify-between rounded-[var(--ds-radius-sm)] px-4 pb-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-focus)]"
                  >
                    <span className="text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-[var(--chrome-sidebar-section-text)]">{section.label}</span>
                    <ChevronDown aria-hidden="true" className={cn('h-3.5 w-3.5', expanded && 'rotate-180')} />
                  </button>
                  {expanded ? (
                    <div id={`sidebar-section-${section.id}`} className="space-y-1 pb-0.5">
                      {items.map((entry) => {
                        const Icon = entry.icon;
                        const active = entry.id === activeItem?.id;
                        return (
                          <Link
                            key={entry.id}
                            href={entry.href}
                            onClick={onClose}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                              'mx-2 flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-focus)]',
                              active ? 'border-[color:var(--chrome-sidebar-item-active-border)] bg-[var(--chrome-sidebar-item-active-bg)] text-[var(--ds-color-sidebar-text)]' : 'border-transparent text-[var(--ds-color-sidebar-muted)] hover:bg-[var(--chrome-sidebar-item-hover-bg)]',
                            )}
                          >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"><Icon aria-hidden="true" className="h-4 w-4" /></span>
                            <span className="flex-1 truncate">{entry.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </nav>
        </div>

        <div className="border-t border-[color:var(--chrome-sidebar-divider)] px-3.5 py-3.5">
          <div className="rounded-[1rem] border border-[var(--chrome-sidebar-user-card-border)] bg-[var(--chrome-sidebar-user-card-bg)] p-3">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--chrome-sidebar-item-active-bg)] text-xs font-bold">{user?.nome?.trim()?.slice(0, 2).toUpperCase() || 'SG'}</div>
              <div className="min-w-0"><p className="truncate text-[13px] font-semibold text-[var(--ds-color-sidebar-text)]">{user?.nome}</p><p className="truncate text-xs text-[var(--ds-color-sidebar-muted)]">{user?.profile?.nome}</p></div>
            </div>
            <button type="button" onClick={() => void logout()} className="flex w-full items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-[13px] font-medium text-[var(--ds-color-sidebar-muted)]"><LogOut aria-hidden="true" className="h-4 w-4" />Sair</button>
          </div>
        </div>
      </aside>
    </>
  );
}
