"use client";

import { useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { PenLine, Send, X } from "lucide-react";
import type { Rdo } from "@/services/rdosService";
import { safeToLocaleDateString } from "@/lib/date/safeFormat";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { formatCpfInput } from "@/lib/format/cpf";
import { cn } from "@/lib/utils";
import type { RdoSignModalState } from "@/components/rdos/rdo-modal-types";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


type RdoActionModalsProps = {
  signModal: RdoSignModalState;
  setSignModal: Dispatch<SetStateAction<RdoSignModalState>>;
  signForm: {
    nome: string;
    cpf: string;
    tipo: "responsavel" | "engenheiro";
  };
  setSignForm: Dispatch<
    SetStateAction<{
      nome: string;
      cpf: string;
      tipo: "responsavel" | "engenheiro";
    }>
  >;
  signing: boolean;
  onSign: () => void;
  emailModal: Rdo | null;
  setEmailModal: Dispatch<SetStateAction<Rdo | null>>;
  emailTo: string;
  setEmailTo: Dispatch<SetStateAction<string>>;
  sendingEmail: boolean;
  onSendEmail: () => void;
  formInputClassName: string;
};

export function RdoActionModals({
  signModal,
  setSignModal,
  signForm,
  setSignForm,
  signing,
  onSign,
  emailModal,
  setEmailModal,
  emailTo,
  setEmailTo,
  sendingEmail,
  onSendEmail,
  formInputClassName,
}: RdoActionModalsProps) {
  const signDialogRef = useRef<HTMLDivElement>(null);
  const emailDialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(signDialogRef, signModal !== null, () => setSignModal(null));
  useFocusTrap(emailDialogRef, emailModal !== null, () => setEmailModal(null));

  return (
    <>
      {signModal && (
        <div
          ref={signDialogRef}
          className="ds-legacy-modal-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Assinar RDO"
        >
          <div className="ds-legacy-modal-shell w-full max-w-sm rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-sm)]">
            <div className="flex items-center justify-between border-b border-[var(--ds-color-border-subtle)] px-5 py-4">
              <h2 className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                Assinar RDO
              </h2>
              <button
                type="button"
                aria-label="Fechar"
                onClick={() => setSignModal(null)}
                className="rounded-lg p-1.5 text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="ds-legacy-modal-body space-y-4 px-5 py-5">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                  Tipo de assinatura
                </label>
                <select
                  aria-label="Tipo de assinatura"
                  value={signModal.tipo}
                  onChange={(e) =>
                    setSignModal((prev) =>
                      prev
                        ? {
                            ...prev,
                            tipo: e.target.value as
                              | "responsavel"
                              | "engenheiro",
                          }
                        : prev,
                    )
                  }
                  className={formInputClassName}
                >
                  <option value="responsavel">Responsável pela Obra</option>
                  <option value="engenheiro">Engenheiro Responsável</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="sign-nome"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                >
                  Nome completo
                </label>
                <input
                  id="sign-nome"
                  type="text"
                  value={signForm.nome}
                  onChange={(e) =>
                    setSignForm((f) => ({ ...f, nome: e.target.value }))
                  }
                  className={formInputClassName}
                  placeholder="Nome de quem assina"
                />
              </div>
              <div>
                <label
                  htmlFor="sign-cpf"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                >
                  CPF
                </label>
                <input
                  id="sign-cpf"
                  type="text"
                  value={signForm.cpf}
                  onChange={(e) =>
                    setSignForm((f) => ({
                      ...f,
                      cpf: formatCpfInput(e.target.value),
                    }))
                  }
                  className={formInputClassName}
                  placeholder="000.000.000-00"
                  maxLength={14}
                />
              </div>
            </div>
            <div className="ds-legacy-modal-footer flex items-center justify-end gap-2 border-t border-[var(--ds-color-border-subtle)] px-5 py-4">
              <button
                type="button"
                onClick={() => setSignModal(null)}
                className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] px-4 py-2 text-sm text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] motion-safe:transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={onSign}
                disabled={signing}
                className="flex items-center gap-1.5 rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50 motion-safe:transition-colors"
              >
                <PenLine className="h-4 w-4" />{" "}
                {signing ? "Assinando..." : "Confirmar assinatura"}
              </button>
            </div>
          </div>
        </div>
      )}

      {emailModal && (
        <div
          ref={emailDialogRef}
          className="ds-legacy-modal-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Enviar RDO por e-mail"
        >
          <div className="ds-legacy-modal-shell w-full max-w-sm rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-sm)]">
            <div className="flex items-center justify-between border-b border-[var(--ds-color-border-subtle)] px-5 py-4">
              <h2 className="text-base font-semibold text-[var(--ds-color-text-primary)]">
                Enviar RDO por E-mail
              </h2>
              <button
                type="button"
                aria-label="Fechar"
                onClick={() => setEmailModal(null)}
                className="rounded-lg p-1.5 text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="ds-legacy-modal-body px-5 py-5">
              <p className="mb-3 text-xs text-[var(--ds-color-text-secondary)]">
                Enviar <strong>{emailModal.numero}</strong> —{" "}
                {safeToLocaleDateString(
                  emailModal.data,
                  "pt-BR",
                  undefined,
                  "—",
                )}
              </p>
              <div className="mb-4 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] px-3 py-2 text-xs text-[var(--ds-color-success-fg)]">
                Envio oficial: o backend anexará o PDF final governado do RDO.
                Se o documento ainda não tiver sido emitido, o envio será
                bloqueado.
              </div>
              <label
                htmlFor="email-to"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
              >
                Destinatários (separados por vírgula)
              </label>
              <input
                id="email-to"
                type="text"
                inputMode="email"
                autoComplete="email"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                className={formInputClassName}
                placeholder="email@exemplo.com, outro@exemplo.com"
                aria-describedby={emailTo.trim() ? "email-parsed-list" : undefined}
              />
              {(() => {
                const parsed = emailTo.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
                if (parsed.length === 0) return null;
                const invalid = parsed.filter((e) => !isValidEmail(e));
                return (
                  <div id="email-parsed-list" className="mt-2 space-y-1.5">
                    <div className="flex flex-wrap gap-1.5">
                      {parsed.map((email, idx) => (
                        <span
                          key={idx}
                          className={cn(
                            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                            isValidEmail(email)
                              ? "bg-[color:var(--ds-color-success)]/10 text-[var(--ds-color-success)]"
                              : "bg-[color:var(--ds-color-danger)]/10 text-[var(--ds-color-danger)]",
                          )}
                        >
                          {email}
                        </span>
                      ))}
                    </div>
                    {invalid.length > 0 && (
                      <p className="text-xs text-[var(--ds-color-danger)]" role="alert">
                        {invalid.length === 1
                          ? "E-mail inválido — verifique o formato antes de enviar."
                          : `${invalid.length} e-mails inválidos — verifique os formatos antes de enviar.`}
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
            <div className="ds-legacy-modal-footer flex items-center justify-end gap-2 border-t border-[var(--ds-color-border-subtle)] px-5 py-4">
              <button
                type="button"
                onClick={() => setEmailModal(null)}
                className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] px-4 py-2 text-sm text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] motion-safe:transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={onSendEmail}
                disabled={
                  sendingEmail ||
                  emailTo.trim() === "" ||
                  emailTo.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean).some((e) => !isValidEmail(e))
                }
                className="flex items-center gap-1.5 rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50 motion-safe:transition-colors"
              >
                <Send className="h-4 w-4" />{" "}
                {sendingEmail ? "Enviando..." : "Enviar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
