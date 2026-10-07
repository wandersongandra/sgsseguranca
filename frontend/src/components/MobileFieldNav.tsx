'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { isAiEnabled } from '@/lib/featureFlags';
import { getActiveNavigationItem, getVisibleNavigationItems } from '@/lib/navigation-config';
import { cn } from '@/lib/utils';

export function MobileFieldNav() {
  const pathname = usePathname();
  const { hasPermission, isAdminGeral } = useAuth();
  const items = getVisibleNavigationItems('mobile', {
    hasPermission,
    isAdmin: isAdminGeral,
    featureFlags: { ai: isAiEnabled() },
  }).slice(0, 5);
  const activeItem = getActiveNavigationItem(pathname, items);

  return (
    <nav aria-label="Navegação principal mobile" className="ds-mobile-nav xl:hidden" data-sophie-reserved-zone="bottom">
      {items.map((entry) => {
        const Icon = entry.icon;
        const active = entry.id === activeItem?.id;
        return (
          <Link key={entry.id} href={entry.href} aria-label={entry.label} aria-current={active ? 'page' : undefined} className={cn('ds-mobile-nav__item touch-manipulation', active && 'ds-mobile-nav__item--active')}>
            <Icon aria-hidden="true" className="h-[18px] w-[18px]" />
            <span>{entry.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
