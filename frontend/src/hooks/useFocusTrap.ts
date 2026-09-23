'use client';

import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose?: () => void,
  restoreFocusRef?: RefObject<HTMLElement | null>,
) {
  const restoreFocusFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (active && restoreFocusFrameRef.current !== null) {
      cancelAnimationFrame(restoreFocusFrameRef.current);
      restoreFocusFrameRef.current = null;
    }

    if (!active || !ref.current) return;

    const container = ref.current;
    const previousFocus =
      restoreFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    const focusFrame = requestAnimationFrame(() => {
      const focusable = getFocusable(container);
      const first = focusable[0];
      if (first) {
        first.focus();
      } else {
        container.focus();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }

      if (e.key !== 'Tab') return;

      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;

      if (e.shiftKey) {
        if (!activeElement || activeElement === first || !container.contains(activeElement)) {
          e.preventDefault();
          last?.focus();
        }
        return;
      }

      if (!activeElement || activeElement === last || !container.contains(activeElement)) {
        e.preventDefault();
        first?.focus();
      }
    };

    container.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(focusFrame);
      container.removeEventListener('keydown', handleKeyDown);
      if (!previousFocus?.isConnected) return;

      // O elemento que abriu o modal pode estar sob inert até o próximo commit.
      restoreFocusFrameRef.current = requestAnimationFrame(() => {
        restoreFocusFrameRef.current = null;
        if (previousFocus.isConnected && !previousFocus.hasAttribute('disabled')) {
          previousFocus.focus();
        }
      });
    };
  }, [active, onClose, ref, restoreFocusRef]);
}
