"use client";

import { useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { PenLine, Send, X } from "lucide-react";
import type { Rdo } from "@/services/rdosService";
import { safeToLocaleDateString } from "@/lib/date/safeFormat";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { formatCpfInput } from "@/lib/format/cpf";
import type { RdoSignModalState } from "@/components/rdos/rdo-modal-types";


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
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Assinar RDO"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-lg)]">
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
            <div className="space-y-4 px-5 py-5">
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
            <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-color-border-subtle)] px-5 py-4">
              <button
                type="button"
                onClick={() => setSignModal(null)}
                className="rounded-xl border border-[var(--ds-color-border-subtle)] px-4 py-2 text-sm text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] motion-safe:transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={onSign}
                disabled={signing}
                className="flex items-center gap-1.5 rounded-xl bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50 motion-safe:transition-colors"
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
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Enviar RDO por e-mail"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-lg)]">
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
            <div className="px-5 py-5">
              <p className="mb-3 text-xs text-[var(--ds-color-text-secondary)]">
                Enviar <strong>{emailModal.numero}</strong> —{" "}
                {safeToLocaleDateString(
                  emailModal.data,
                  "pt-BR",
                  undefined,
                  "—",
                )}
              </p>
              <div className="mb-4 rounded-xl border border-[color:var(--ds-color-success)]/30 bg-[color:var(--ds-color-success)]/10 px-3 py-2 text-xs text-[var(--ds-color-success)]">
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
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                className={formInputClassName}
                placeholder="email@exemplo.com, outro@exemplo.com"
              />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-color-border-subtle)] px-5 py-4">
              <button
                type="button"
                onClick={() => setEmailModal(null)}
                className="rounded-xl border border-[var(--ds-color-border-subtle)] px-4 py-2 text-sm text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] motion-safe:transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={onSendEmail}
                disabled={sendingEmail}
                className="flex items-center gap-1.5 rounded-xl bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50 motion-safe:transition-colors"
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
