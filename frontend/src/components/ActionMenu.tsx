"use client";

import { useState, useRef, useEffect, type KeyboardEvent, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ActionItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger';
  disabled?: boolean;
  title?: string;
}

interface ActionMenuProps {
  items: ActionItem[];
  triggerAriaLabel?: string;
}

export function ActionMenu({ items, triggerAriaLabel = "Ações" }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-focus first item when menu opens; reset on close
  useEffect(() => {
    if (open) {
      setFocusedIndex(0);
    } else {
      setFocusedIndex(-1);
    }
  }, [open]);

  // Move DOM focus to the focused item
  useEffect(() => {
    if (open && focusedIndex >= 0 && focusedIndex < items.length) {
      itemRefs.current[focusedIndex]?.focus();
    }
  }, [focusedIndex, open, items.length]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const count = items.length;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case 'ArrowDown':
        event.preventDefault();
        setFocusedIndex((prev) => (prev + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setFocusedIndex((prev) => (prev - 1 + count) % count);
        break;
      case 'Home':
        event.preventDefault();
        setFocusedIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setFocusedIndex(count - 1);
        break;
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-2 text-[var(--ds-color-text-muted)] transition-colors hover:bg-[color:var(--ds-color-surface-muted)]/72 hover:text-[var(--ds-color-text-primary)]"
        title="Ações"
        aria-label={triggerAriaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 mt-1 max-h-[min(60dvh,20rem)] w-[min(13rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-elevated)] shadow-[var(--ds-shadow-md)]"
          role="menu"
          aria-label={triggerAriaLabel}
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item, i) => (
            <button
              key={i}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              disabled={item.disabled}
              title={item.title}
              role="menuitem"
              tabIndex={focusedIndex === i ? 0 : -1}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={cn(
                'flex w-full items-center gap-2 px-4 py-2.5 text-sm transition-colors',
                item.variant === 'danger'
                  ? 'text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 hover:text-[var(--ds-color-danger)]'
                  : 'text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)]/76 hover:text-[var(--ds-color-text-primary)]',
                item.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <span className="h-4 w-4 shrink-0" aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
