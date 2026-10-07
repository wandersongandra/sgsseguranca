'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ResponsiveDataListProps<T> {
  /** Items rendered in either responsive representation. */
  items: readonly T[];
  /** Stable key used for each item in the mobile list. */
  getKey: (item: T, index: number) => React.Key;
  /** Renders the complete desktop representation (for example, a table). */
  desktop: (items: readonly T[]) => React.ReactNode;
  /** Renders one mobile item (for example, a card). */
  mobile: (item: T, index: number) => React.ReactNode;
  /** Replaces both representations while data is loading. */
  loading?: React.ReactNode;
  /** Replaces both representations when items is empty. */
  empty?: React.ReactNode;
  /** Media query at which the desktop representation becomes active. */
  desktopMediaQuery?: string;
  /** Optional wrapper classes for the mobile item list. */
  mobileClassName?: string;
}

function useMediaQuery(query: string) {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      const mediaQuery = window.matchMedia(query);
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', onStoreChange);
        return () => mediaQuery.removeEventListener('change', onStoreChange);
      }

      // Safari < 14 and older embedded WebViews only expose the legacy API.
      mediaQuery.addListener(onStoreChange);
      return () => mediaQuery.removeListener(onStoreChange);
    },
    [query],
  );

  const getSnapshot = React.useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );

  // Mobile is the deterministic server snapshot. useSyncExternalStore updates it
  // immediately after hydration without mounting two interactive trees.
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Chooses one responsive representation for a data set. Unlike CSS-only
 * duplication, the inactive interactive tree is not mounted or exposed to
 * assistive technologies.
 */
export function ResponsiveDataList<T>({
  items,
  getKey,
  desktop,
  mobile,
  loading,
  empty,
  desktopMediaQuery = '(min-width: 768px)',
  mobileClassName,
}: ResponsiveDataListProps<T>) {
  const isDesktop = useMediaQuery(desktopMediaQuery);

  if (loading !== undefined && loading !== null) {
    return <>{loading}</>;
  }

  if (items.length === 0) {
    return empty === undefined || empty === null ? null : <>{empty}</>;
  }

  if (isDesktop) {
    return <>{desktop(items)}</>;
  }

  return (
    <div role="list" className={cn('ds-responsive-mobile-list', mobileClassName)}>
      {items.map((item, index) => (
        <div
          key={getKey(item, index)}
          role="listitem"
          className="ds-responsive-mobile-list__item min-w-0"
        >
          {mobile(item, index)}
        </div>
      ))}
    </div>
  );
}
