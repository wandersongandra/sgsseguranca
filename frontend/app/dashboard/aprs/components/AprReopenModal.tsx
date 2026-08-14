"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { handleApiError } from "@/lib/error-handler";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { X } from "lucide-react";

interface AprReopenModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

export function AprReopenModal({ open, onClose, onConfirm }: AprReopenModalProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open, onClose);

  const handleConfirm = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 20) {
      toast.error("A justificativa deve ter pelo menos 20 caracteres.");
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(trimmed);
      toast.success("APR reaberta com sucesso.");
      setReason("");
      onClose();
    } catch (error) {
      handleApiError(error, "Reabertura");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--component-overlay)] px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-[var(--ds-radius-xl)] border border-[var(--component-card-border)] bg-[color:var(--component-card-bg)] p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--ds-color-text-primary)]">
            Reabrir passo de aprovação
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]"
            aria-label="Fechar modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-sm text-[var(--ds-color-text-secondary)]">
          Informe a justificativa para reabrir o passo anterior de aprovação. Esta ação ficará registrada na trilha de auditoria.
        </p>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Descreva o motivo da reabertura (mín. 20 caracteres)..."
          rows={4}
          className="w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
          autoFocus
        />
        <p className="mt-1 text-xs text-[var(--ds-color-text-secondary)]">
          {reason.trim().length}/20 caracteres mínimos
        </p>

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)] disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || reason.trim().length < 20}
            className="inline-flex items-center gap-2 rounded-[var(--ds-radius-md)] bg-[var(--color-warning)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? "Reabrindo..." : "Confirmar reabertura"}
          </button>
        </div>
      </div>
    </div>
  );
}
