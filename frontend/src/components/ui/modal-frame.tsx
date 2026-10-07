'use client';

import {
  createContext,
  useEffect,
  type ReactNode,
  type RefObject,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModalFrameProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  shellClassName?: string;
  overlayClassName?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

interface ModalHeaderProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  onClose?: () => void;
  className?: string;
}

interface ModalSectionProps {
  children: ReactNode;
  className?: string;
}

interface ModalFrameContextValue {
  titleId: string;
  descriptionId: string;
  hasDescription: boolean;
  setHasDescription: (value: boolean) => void;
}

const ModalFrameContext = createContext<ModalFrameContextValue | null>(null);

function useModalFrameContext() {
  const context = useContext(ModalFrameContext);

  if (!context) {
    throw new Error('Modal components must be used within ModalFrame.');
  }

  return context;
}

export function ModalFrame({
  isOpen,
  onClose,
  children,
  shellClassName,
  overlayClassName,
  initialFocusRef,
}: ModalFrameProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [hasDescription, setHasDescription] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const contextValue = useMemo<ModalFrameContextValue>(
    () => ({
      titleId,
      descriptionId,
      hasDescription,
      setHasDescription,
    }),
    [descriptionId, hasDescription, titleId],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [isOpen]);

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn('ds-modal-overlay z-[100]', overlayClassName)}
        />
        <ModalFrameContext.Provider value={contextValue}>
          <Dialog.Content
            aria-modal="true"
            aria-describedby={hasDescription ? descriptionId : undefined}
            aria-labelledby={titleId}
            className={cn('ds-modal-shell max-h-[calc(100dvh-2rem)] overscroll-contain', shellClassName)}
            onCloseAutoFocus={(event) => {
              const restoreTarget = restoreFocusRef.current;

              if (!restoreTarget || !document.contains(restoreTarget)) {
                return;
              }

              event.preventDefault();
              restoreTarget.focus();
            }}
            onOpenAutoFocus={(event) => {
              if (!initialFocusRef?.current) {
                return;
              }

              event.preventDefault();
              initialFocusRef.current.focus();
            }}
          >
            {children}
          </Dialog.Content>
        </ModalFrameContext.Provider>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ModalHeader({
  title,
  description,
  icon,
  onClose,
  className,
}: ModalHeaderProps) {
  const { titleId, descriptionId, setHasDescription } = useModalFrameContext();

  useEffect(() => {
    setHasDescription(Boolean(description));

    return () => {
      setHasDescription(false);
    };
  }, [description, setHasDescription]);

  return (
    <div className={cn('ds-modal-header', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon ? <div className="ds-modal-header__icon">{icon}</div> : null}
        <div className="min-w-0">
          <Dialog.Title className="sr-only">
            {title}
          </Dialog.Title>
          <h2
            id={titleId}
            className="text-lg font-semibold text-[var(--ds-color-text-primary)]"
          >
            {title}
          </h2>
          {description ? (
            <>
              <Dialog.Description className="sr-only">
                {description}
              </Dialog.Description>
              <p
                id={descriptionId}
                className="mt-1 text-sm text-[var(--ds-color-text-secondary)]"
              >
                {description}
              </p>
            </>
          ) : null}
        </div>
      </div>
      {onClose ? (
        <Dialog.Close asChild>
          <button
            type="button"
            className="ds-modal-close"
            aria-label="Fechar modal"
          >
            <X className="h-5 w-5" />
          </button>
        </Dialog.Close>
      ) : null}
    </div>
  );
}

export function ModalBody({ children, className }: ModalSectionProps) {
  return <div className={cn('ds-modal-body', className)}>{children}</div>;
}

export function ModalFooter({ children, className }: ModalSectionProps) {
  return <div className={cn('ds-modal-footer', className)}>{children}</div>;
}
