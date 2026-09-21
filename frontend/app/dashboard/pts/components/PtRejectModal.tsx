'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModalBody, ModalFooter, ModalFrame, ModalHeader } from '@/components/ui/modal-frame';

type Props = {
  isOpen: boolean;
  loading: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
};

export function PtRejectModal({ isOpen, loading, onClose, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const normalizedReason = reason.trim();
  const invalid = touched && !normalizedReason;

  useEffect(() => {
    if (!isOpen) {
      setReason('');
      setTouched(false);
    }
  }, [isOpen]);

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      initialFocusRef={inputRef}
      shellClassName="max-w-lg"
    >
      <ModalHeader
        title="Reprovar PT"
        description="Informe o motivo da reprovação. Ele ficará registrado no histórico da permissão."
        icon={<AlertTriangle className="h-5 w-5" />}
        onClose={onClose}
      />
      <ModalBody>
        <label
          htmlFor="pt-reject-reason"
          className="text-sm font-semibold text-[var(--ds-color-text-primary)]"
        >
          Motivo da reprovação
        </label>
        <textarea
          ref={inputRef}
          id="pt-reject-reason"
          rows={4}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-required="true"
          aria-invalid={invalid}
          aria-describedby={hintId}
          className="mt-2 w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
        />
        <p
          id={hintId}
          role={invalid ? 'alert' : undefined}
          className={
            invalid
              ? 'mt-1 text-sm text-[var(--ds-color-danger)]'
              : 'mt-1 text-xs text-[var(--ds-color-text-secondary)]'
          }
        >
          {invalid ? 'O motivo da reprovação é obrigatório.' : 'Campo obrigatório.'}
        </p>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="ghost" disabled={loading} onClick={onClose}>
          Cancelar
        </Button>
        <Button
          type="button"
          variant="danger"
          loading={loading}
          disabled={!normalizedReason}
          onClick={() => void onConfirm(normalizedReason)}
        >
          Confirmar reprovação
        </Button>
      </ModalFooter>
    </ModalFrame>
  );
}
