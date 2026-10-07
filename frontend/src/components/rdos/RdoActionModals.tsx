"use client";

import type { Dispatch, SetStateAction } from "react";
import { PenLine, Send } from "lucide-react";
import type { Rdo } from "@/services/rdosService";
import { safeToLocaleDateString } from "@/lib/date/safeFormat";
import { formatCpfInput } from "@/lib/format/cpf";
import { cn } from "@/lib/utils";
import type { RdoSignModalState } from "@/components/rdos/rdo-modal-types";
import {
  ModalBody,
  ModalFooter,
  ModalFrame,
  ModalHeader,
} from "@/components/ui/modal-frame";
import { Button } from "@/components/ui/button";

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
  const parsedEmails = emailTo
    .split(/[,;\s]+/)
    .map((email) => email.trim())
    .filter(Boolean);
  const invalidEmails = parsedEmails.filter((email) => !isValidEmail(email));
  const emailDisabled =
    sendingEmail ||
    parsedEmails.length === 0 ||
    invalidEmails.length > 0;

  return (
    <>
      <ModalFrame
        isOpen={signModal !== null}
        onClose={() => setSignModal(null)}
        shellClassName="max-w-sm"
      >
        <ModalHeader
          title="Assinar RDO"
          description="Confirme a identificação de quem assina o relatório."
          icon={<PenLine className="h-5 w-5" />}
          onClose={() => setSignModal(null)}
        />
        <ModalBody className="space-y-4">
          <div>
            <label
              htmlFor="rdo-sign-type"
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
            >
              Tipo de assinatura
            </label>
            <select
              id="rdo-sign-type"
              value={signModal?.tipo ?? signForm.tipo}
              onChange={(event) => {
                const tipo = event.target.value as
                  | "responsavel"
                  | "engenheiro";
                setSignModal((previous) =>
                  previous ? { ...previous, tipo } : previous,
                );
                setSignForm((previous) => ({ ...previous, tipo }));
              }}
              className={formInputClassName}
            >
              <option value="responsavel">Responsável pela obra</option>
              <option value="engenheiro">Engenheiro responsável</option>
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
              autoComplete="name"
              value={signForm.nome}
              onChange={(event) =>
                setSignForm((previous) => ({
                  ...previous,
                  nome: event.target.value,
                }))
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
              inputMode="numeric"
              autoComplete="off"
              value={signForm.cpf}
              onChange={(event) =>
                setSignForm((previous) => ({
                  ...previous,
                  cpf: formatCpfInput(event.target.value),
                }))
              }
              className={formInputClassName}
              placeholder="000.000.000-00"
              maxLength={14}
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setSignModal(null)}
            disabled={signing}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={onSign}
            loading={signing}
            leftIcon={<PenLine className="h-4 w-4" />}
          >
            Confirmar assinatura
          </Button>
        </ModalFooter>
      </ModalFrame>

      <ModalFrame
        isOpen={emailModal !== null}
        onClose={() => setEmailModal(null)}
        shellClassName="max-w-sm"
      >
        <ModalHeader
          title="Enviar RDO por e-mail"
          description={
            emailModal
              ? `${emailModal.numero} · ${safeToLocaleDateString(
                  emailModal.data,
                  "pt-BR",
                  undefined,
                  "—",
                )}`
              : undefined
          }
          icon={<Send className="h-5 w-5" />}
          onClose={() => setEmailModal(null)}
        />
        <ModalBody className="space-y-4">
          <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] px-3 py-2.5 text-xs leading-5 text-[var(--ds-color-success-fg)]">
            O envio usa o PDF final do RDO. Se o documento ainda não tiver sido
            emitido, o envio será bloqueado.
          </div>

          <div>
            <label
              htmlFor="email-to"
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
            >
              Destinatários
            </label>
            <input
              id="email-to"
              type="text"
              inputMode="email"
              autoComplete="email"
              value={emailTo}
              onChange={(event) => setEmailTo(event.target.value)}
              className={formInputClassName}
              placeholder="email@empresa.com, outro@empresa.com"
              aria-describedby={
                parsedEmails.length ? "rdo-email-parsed-list" : undefined
              }
            />
            <p className="mt-1.5 text-xs text-[var(--ds-color-text-muted)]">
              Separe vários endereços por vírgula, ponto e vírgula ou espaço.
            </p>
          </div>

          {parsedEmails.length ? (
            <div
              id="rdo-email-parsed-list"
              className="space-y-2"
              aria-live="polite"
            >
              <div className="flex flex-wrap gap-1.5">
                {parsedEmails.map((email) => (
                  <span
                    key={email}
                    className={cn(
                      "inline-flex max-w-full break-all rounded-[var(--ds-radius-sm)] px-2.5 py-1 text-xs font-medium",
                      isValidEmail(email)
                        ? "bg-[color:var(--ds-color-success)]/10 text-[var(--ds-color-success)]"
                        : "bg-[color:var(--ds-color-danger)]/10 text-[var(--ds-color-danger)]",
                    )}
                  >
                    {email}
                  </span>
                ))}
              </div>
              {invalidEmails.length ? (
                <p className="text-xs text-[var(--ds-color-danger)]" role="alert">
                  {invalidEmails.length === 1
                    ? "Há um e-mail inválido."
                    : `Há ${invalidEmails.length} e-mails inválidos.`}
                </p>
              ) : null}
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setEmailModal(null)}
            disabled={sendingEmail}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={onSendEmail}
            disabled={emailDisabled}
            loading={sendingEmail}
            leftIcon={<Send className="h-4 w-4" />}
          >
            Enviar
          </Button>
        </ModalFooter>
      </ModalFrame>
    </>
  );
}
