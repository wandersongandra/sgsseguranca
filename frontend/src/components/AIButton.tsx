'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AIChatPanel } from './AIChatPanel';
import { LifeBuoy, Sparkles, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { getAiRouteContext } from '@/lib/ai-context';
import { isAiEnabled } from '@/lib/featureFlags';

type FloatingPosition = {
  x: number;
  y: number;
};

const SOPHIE_BUTTON_POSITION_KEY = 'sgs.sophie.floating-button.position';
const EDGE_MARGIN = 16;
const DRAG_THRESHOLD_PX = 4;

type ClampBounds = {
  viewportWidth: number;
  viewportHeight: number;
  width: number;
  height: number;
  bottomBoundary?: number;
  topBoundary?: number;
  edgeMargin?: number;
};

export function clampSophiePosition(
  next: FloatingPosition,
  bounds: ClampBounds,
): FloatingPosition {
  const edge = bounds.edgeMargin ?? EDGE_MARGIN;
  const bottomBoundary = bounds.bottomBoundary ?? bounds.viewportHeight;
  const topBoundary = bounds.topBoundary ?? 0;
  return {
    x: Math.min(
      Math.max(next.x, edge),
      Math.max(edge, bounds.viewportWidth - bounds.width - edge),
    ),
    y: Math.min(
      Math.max(next.y, topBoundary + edge),
      Math.max(topBoundary + edge, bottomBoundary - bounds.height - edge),
    ),
  };
}

export function AIButton() {
  const aiEnabled = isAiEnabled();
  const chatPanelId = 'sophie-chat-panel';

  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const pathname = usePathname();
  const context = getAiRouteContext(pathname);
  const ContextIcon = context.icon;
  const buttonContainerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const getBottomBoundary = useCallback(() => {
    const reservedZones = document.querySelectorAll<HTMLElement>(
      '[data-sophie-reserved-zone="bottom"]',
    );
    return Array.from(reservedZones).reduce((boundary, zone) => {
      const rect = zone.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) return boundary;
      return Math.min(boundary, rect.top);
    }, window.innerHeight);
  }, []);

  const getTopBoundary = useCallback(() => {
    const reservedZones = document.querySelectorAll<HTMLElement>(
      '[data-sophie-reserved-zone="top"]',
    );
    return Array.from(reservedZones).reduce((boundary, zone) => {
      const rect = zone.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) return boundary;
      return Math.max(boundary, rect.bottom);
    }, 0);
  }, []);

  const clampPosition = useCallback(
    (
      next: FloatingPosition,
      width = buttonContainerRef.current?.getBoundingClientRect().width || 184,
      height = buttonContainerRef.current?.getBoundingClientRect().height || 56,
    ): FloatingPosition =>
      clampSophiePosition(next, {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        width,
        height,
        bottomBoundary: getBottomBoundary(),
        topBoundary: getTopBoundary(),
      }),
    [getBottomBoundary, getTopBoundary],
  );

  const persistPosition = useCallback((next: FloatingPosition) => {
    try {
      window.localStorage.setItem(
        SOPHIE_BUTTON_POSITION_KEY,
        JSON.stringify(next),
      );
    } catch {
      // Persistencia best-effort; o botão continua funcional sem storage.
    }
    return next;
  }, []);

  useEffect(() => {
    if (!aiEnabled) {
      return;
    }

    const handleOpen = () => setIsOpen(true);
    const handleToggle = () => setIsOpen((current) => !current);
    const handleClose = () => setIsOpen(false);

    window.addEventListener('app:sophie-open', handleOpen as EventListener);
    window.addEventListener('app:sophie-toggle', handleToggle as EventListener);
    window.addEventListener('app:sophie-close', handleClose as EventListener);

    return () => {
      window.removeEventListener('app:sophie-open', handleOpen as EventListener);
      window.removeEventListener('app:sophie-toggle', handleToggle as EventListener);
      window.removeEventListener('app:sophie-close', handleClose as EventListener);
    };
  }, [aiEnabled]);

  useEffect(() => {
    if (!aiEnabled) {
      return;
    }

    const resolveInitialPosition = () => {
      const rect = buttonContainerRef.current?.getBoundingClientRect();
      const width = rect?.width || 184;
      const height = rect?.height || 56;
      const bottomOffset = window.matchMedia('(min-width: 640px)').matches
        ? 24
        : 96;
      const fallback = {
        x: window.innerWidth - width - 24,
        y: window.innerHeight - height - bottomOffset,
      };

      try {
        const stored = window.localStorage.getItem(SOPHIE_BUTTON_POSITION_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as FloatingPosition;
          if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
            return clampPosition(parsed, width, height);
          }
        }
      } catch {
        window.localStorage.removeItem(SOPHIE_BUTTON_POSITION_KEY);
      }

      return clampPosition(fallback, width, height);
    };

    setPosition(resolveInitialPosition());
  }, [aiEnabled, clampPosition]);

  useEffect(() => {
    if (!aiEnabled) {
      return;
    }

    const handleLayoutChange = () => {
      const rect = buttonContainerRef.current?.getBoundingClientRect();
      const width = rect?.width || 184;
      const height = rect?.height || 56;
      setPosition((current) =>
        current ? persistPosition(clampPosition(current, width, height)) : null,
      );
    };

    window.addEventListener('resize', handleLayoutChange);
    window.addEventListener('scroll', handleLayoutChange, true);
    const observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver(handleLayoutChange)
        : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    const resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(handleLayoutChange)
        : null;
    document
      .querySelectorAll<HTMLElement>('[data-sophie-reserved-zone]')
      .forEach((zone) => resizeObserver?.observe(zone));
    if (buttonContainerRef.current) {
      resizeObserver?.observe(buttonContainerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleLayoutChange);
      window.removeEventListener('scroll', handleLayoutChange, true);
      observer?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [aiEnabled, clampPosition, persistPosition]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    const currentPosition =
      position ??
      clampPosition({
        x: event.currentTarget.getBoundingClientRect().left,
        y: event.currentTarget.getBoundingClientRect().top,
      });

    dragStateRef.current = {
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: currentPosition.x,
      startY: currentPosition.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.startPointerX;
    const deltaY = event.clientY - dragState.startPointerY;
    if (
      !dragState.moved &&
      Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX
    ) {
      return;
    }

    dragState.moved = true;
    event.preventDefault();
    setPosition(
      clampPosition({
        x: dragState.startX + deltaX,
        y: dragState.startY + deltaY,
      }),
    );
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (dragState.moved) {
      suppressClickRef.current = true;
      setPosition((current) =>
        current ? persistPosition(clampPosition(current)) : current,
      );
    }

    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setIsOpen((current) => !current);
  };

  if (!aiEnabled) return null;

  return (
    <>
      <div
        ref={buttonContainerRef}
        className="ds-sophie-launcher fixed z-50"
        style={
          position
            ? {
                left: position.x,
                top: position.y,
                right: 'auto',
                bottom: 'auto',
              }
            : undefined
        }
      >
        <button
          type="button"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={handleClick}
          aria-expanded={isOpen}
          aria-controls={chatPanelId}
          className="group relative flex h-14 touch-none cursor-grab select-none items-center justify-center gap-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-primary-border)] bg-[var(--component-fab-bg)] px-3.5 text-[var(--ds-color-action-primary-foreground)] shadow-[var(--ds-shadow-sm)] transition-none active:cursor-grabbing hover:border-[var(--ds-color-primary-border)] hover:bg-[var(--component-fab-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ds-color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-color-bg-canvas)]"
          title={
            isOpen
              ? 'Fechar chat da SOPHIE'
              : `Abrir ${context.title}. Arraste para reposicionar.`
          }
        >
          {isOpen ? (
            <X className="h-6 w-6" />
          ) : (
            <>
              <span className="flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-md)] bg-[color:var(--ds-color-surface-base)]/14">
                <ContextIcon className="h-4.5 w-4.5" />
              </span>
              <span className="hidden text-left sm:block">
                <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-[color:var(--ds-color-action-primary-foreground)]/88">
                  SOPHIE
                </span>
                <span className="block max-w-[11rem] truncate text-[13px] font-semibold leading-tight">
                  {context.title}
                </span>
              </span>
            </>
          )}

          {!isOpen && (
            <span className="absolute bottom-full right-0 mb-3 hidden w-[18rem] rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-overlay)] px-3.5 py-3 text-[11px] font-medium text-[var(--ds-color-text-primary)] shadow-[var(--ds-shadow-sm)] group-hover:block group-focus-within:block">
              <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ds-color-text-muted)]">
                <LifeBuoy className="h-3.5 w-3.5 text-[var(--ds-color-action-primary)]" />
                Chat da SOPHIE
              </span>
              <span className="flex items-start gap-1.5 leading-relaxed">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 text-[var(--ds-color-accent)]" />
                {context.subtitle}
              </span>
            </span>
          )}
        </button>
      </div>

      <AIChatPanel isOpen={isOpen} onClose={() => setIsOpen(false)} context={context} />
    </>
  );
}
