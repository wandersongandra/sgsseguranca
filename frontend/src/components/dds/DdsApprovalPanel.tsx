"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, RotateCcw, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  ddsService,
  type Dds,
  type DdsApprovalFlow,
  type DdsApprovalStep,
} from "@/services/ddsService";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusPill, type StatusTone } from "@/components/ui/status-pill";
import { useApprovalWorkflow } from "@/hooks/useApprovalWorkflow";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { logger } from "@/lib/logger";

type DdsApprovalPanelProps = {
  dds: Dds | null;
  canManage: boolean;
  onDdsChanged?: (dds: Dds) => void;
};

const FLOW_LABEL: Record<DdsApprovalFlow["status"], string> = {
  not_started: "Não iniciado",
  pending: "Pendente",
  approved: "Aprovado",
  rejected: "Reprovado",
  canceled: "Cancelado",
};

const FLOW_TONE: Record<DdsApprovalFlow["status"], StatusTone> = {
  not_started: "neutral",
  pending: "warning",
  approved: "success",
  rejected: "danger",
  canceled: "neutral",
};

const STEP_LABEL: Record<DdsApprovalStep["status"], string> = {
  pending: "Pendente",
  approved: "Aprovado",
  rejected: "Reprovado",
  canceled: "Cancelado",
  reopened: "Reaberto",
};

const STEP_TONE: Record<DdsApprovalStep["status"], StatusTone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  canceled: "neutral",
  reopened: "info",
};

export function DdsApprovalPanel({
  dds,
  canManage,
  onDdsChanged,
}: DdsApprovalPanelProps) {
  const { acting, execute } = useApprovalWorkflow();
  const [flow, setFlow] = useState<DdsApprovalFlow | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [pendingAction, setPendingAction] = useState<"approve" | "reject" | "reopen" | null>(null);
  const confirmDialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(confirmDialogRef, pendingAction !== null, () =>
    setPendingAction(null),
  );

  const ddsId = dds?.id;
  const locked = Boolean(
    !ddsId ||
    dds?.is_modelo ||
    dds?.pdf_file_key ||
    dds?.status === "rascunho" ||
    dds?.status === "auditado" ||
    dds?.status === "arquivado",
  );

  const lockMessage = useMemo(() => {
    if (!ddsId) return "Salve o DDS antes de iniciar aprovações.";
    if (dds?.is_modelo) return "Modelos não possuem aprovação operacional.";
    if (dds?.pdf_file_key) return "PDF final emitido: fluxo travado.";
    if (dds?.status === "rascunho") return "Publique o DDS antes da aprovação.";
    if (dds?.status === "auditado") return "DDS auditado: aprovação concluída.";
    if (dds?.status === "arquivado") return "DDS arquivado: fluxo encerrado.";
    return null;
  }, [dds, ddsId]);

  const flowStats = useMemo(() => {
    const steps = flow?.steps ?? [];
    const approvedSteps = steps.filter((step) => step.status === "approved").length;
    const pendingSteps = steps.filter((step) => step.status === "pending").length;
    const rejectedSteps = steps.filter((step) => step.status === "rejected").length;

    return {
      totalSteps: steps.length,
      approvedSteps,
      pendingSteps,
      rejectedSteps,
      activeStepLabel: flow?.currentStep
        ? `Etapa ${flow.currentStep.level_order}`
        : "Sem etapa ativa",
      activeCycleLabel: flow ? `Ciclo ${flow.activeCycle}` : "Sem ciclo",
    };
  }, [flow]);

  const loadFlow = useCallback(async () => {
    if (!ddsId) return;
    try {
      setLoading(true);
      setFlow(await ddsService.getApprovalFlow(ddsId));
    } catch (error) {
      logger.error("Erro ao carregar aprovações DDS:", error);
      toast.error("Não foi possível carregar o fluxo de aprovação do DDS.");
    } finally {
      setLoading(false);
    }
  }, [ddsId]);

  useEffect(() => {
    void loadFlow();
  }, [loadFlow]);

  const refreshDds = useCallback(async () => {
    if (!ddsId || !onDdsChanged) return;
    try {
      onDdsChanged(await ddsService.findOne(ddsId));
    } catch {
      // O painel já foi atualizado; falha de refresh do cabeçalho não bloqueia.
    }
  }, [ddsId, onDdsChanged]);

  const initialize = async () => {
    if (!ddsId) return;
    await execute('approve', async () => {
      const next = await ddsService.initializeApprovalFlow(ddsId);
      setFlow(next);
      void refreshDds();
      toast.success("Fluxo de aprovação DDS iniciado.");
    }, 'Inicialização do fluxo');
  };

  const approve = async () => {
    if (!ddsId || !flow?.currentStep?.pending_record_id) return;
    if (!/^\d{4,6}$/.test(pin.trim())) {
      toast.error("Informe o PIN com 4 a 6 dígitos para assinar a decisão.");
      return;
    }
    // Solicitar confirmação antes de executar a aprovação
    setPendingAction("approve");
  };

  const reject = async () => {
    if (!ddsId || !flow?.currentStep?.pending_record_id) return;
    if (reason.trim().length < 10) {
      toast.error("Informe um motivo com pelo menos 10 caracteres.");
      return;
    }
    if (!/^\d{4,6}$/.test(pin.trim())) {
      toast.error("Informe o PIN com 4 a 6 dígitos para assinar a decisão.");
      return;
    }
    // Solicitar confirmação antes de reprovar
    setPendingAction("reject");
  };

  const reopen = async () => {
    if (!ddsId) return;
    if (reason.trim().length < 10) {
      toast.error(
        "Informe um motivo de reabertura com pelo menos 10 caracteres.",
      );
      return;
    }
    if (!/^\d{4,6}$/.test(pin.trim())) {
      toast.error("Informe o PIN com 4 a 6 dígitos para assinar a decisão.");
      return;
    }
    setPendingAction("reopen");
  };

  /** Executa a ação após confirmação do modal de segurança. */
  const confirmAction = async () => {
    if (!pendingAction || !ddsId) {
      setPendingAction(null);
      return;
    }
    const action = pendingAction;
    setPendingAction(null);

    if (action === "approve" && flow?.currentStep?.pending_record_id) {
      const pendingRecordId = flow.currentStep.pending_record_id;
      await execute("approve", async () => {
        const next = await ddsService.approveApprovalStep(
          ddsId,
          pendingRecordId,
          { reason: reason.trim() || undefined, pin: pin.trim() },
        );
        setFlow(next);
        setReason("");
        setPin("");
        void refreshDds();
        toast.success("Etapa aprovada com sucesso.");
      });
    } else if (action === "reject" && flow?.currentStep?.pending_record_id) {
      const pendingRecordId = flow.currentStep.pending_record_id;
      await execute("reject", async () => {
        const next = await ddsService.rejectApprovalStep(
          ddsId,
          pendingRecordId,
          { reason: reason.trim(), pin: pin.trim() },
        );
        setFlow(next);
        setReason("");
        setPin("");
        void refreshDds();
        toast.warning("DDS reprovado nesta etapa.");
      });
    } else if (action === "reopen") {
      await execute("reopen", async () => {
        const next = await ddsService.reopenApprovalFlow(ddsId, {
          reason: reason.trim(),
          pin: pin.trim(),
        });
        setFlow(next);
        setReason("");
        setPin("");
        void refreshDds();
        toast.success("Fluxo de aprovação reaberto em novo ciclo.");
      });
    }
  };

  return (
    <Card tone="default" padding="lg" className="space-y-5">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
              Aprovação
            </p>
            <h2 className="text-lg font-bold text-[var(--ds-color-text-primary)]">
              Aprovação e Governança
            </h2>
            <p className="max-w-2xl text-sm text-[var(--ds-color-text-secondary)]">
              Fluxo técnico, decisão operacional e trilha de auditoria em um
              painel com leitura rápida.
            </p>
          </div>
          <StatusPill tone={flow ? FLOW_TONE[flow.status] : "neutral"}>
            {loading
              ? "Carregando"
              : flow
                ? FLOW_LABEL[flow.status]
                : "Sem fluxo"}
          </StatusPill>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/35 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
              Ciclo atual
            </p>
            <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
              {flowStats.activeCycleLabel}
            </p>
          </div>
          <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/35 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
              Etapa ativa
            </p>
            <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
              {flowStats.activeStepLabel}
            </p>
          </div>
          <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/35 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ds-color-text-secondary)]">
              Progresso
            </p>
            <p className="mt-1 text-sm font-semibold text-[var(--ds-color-text-primary)]">
              {flowStats.approvedSteps}/{flowStats.totalSteps || 0} aprovadas
            </p>
            <p className="mt-0.5 text-xs text-[var(--ds-color-text-muted)]">
              {flowStats.pendingSteps} pendentes
              {flowStats.rejectedSteps
                ? `, ${flowStats.rejectedSteps} reprovadas`
                : ""}
            </p>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/24 px-3 py-3 text-xs text-[var(--ds-color-text-secondary)]">
            <p className="font-semibold text-[var(--ds-color-text-primary)]">
              PIN de assinatura
            </p>
            <p className="mt-1">Use 4 a 6 dígitos para validar a decisão.</p>
          </div>
          <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/24 px-3 py-3 text-xs text-[var(--ds-color-text-secondary)]">
            <p className="font-semibold text-[var(--ds-color-text-primary)]">
              Motivo obrigatório
            </p>
            <p className="mt-1">
              Reprovação e reabertura exigem justificativa explícita.
            </p>
          </div>
          <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/24 px-3 py-3 text-xs text-[var(--ds-color-text-secondary)]">
            <p className="font-semibold text-[var(--ds-color-text-primary)]">
              Trilha auditável
            </p>
            <p className="mt-1">Cada evento segue hash e histórico encadeado.</p>
          </div>
        </div>
      </div>

      {lockMessage ? (
        <div className="rounded-[var(--ds-radius-md)] border border-[color:var(--ds-color-warning)]/20 bg-[color:var(--ds-color-warning)]/8 px-4 py-3 text-sm text-[var(--ds-color-text-secondary)]">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-none text-[var(--ds-color-warning)]" />
            <p>{lockMessage}</p>
          </div>
        </div>
      ) : null}

      {!loading && flow?.steps.length ? (
        <div className="space-y-3">
          {flow.steps.map((step) => (
            <div
              key={`${flow.activeCycle}-${step.level_order}`}
              className={`rounded-[var(--ds-radius-md)] border bg-[var(--ds-color-surface-base)] px-4 py-4 shadow-[0_1px_0_rgba(0,0,0,0.02)] ${
                step.status === "approved"
                  ? "border-[color:var(--ds-color-success)]/25"
                  : step.status === "pending"
                    ? "border-[color:var(--ds-color-warning)]/25"
                    : step.status === "rejected"
                      ? "border-[color:var(--ds-color-danger)]/25"
                      : "border-[var(--ds-color-border-subtle)]"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div
                    className={`mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full border text-xs font-bold ${
                      step.status === "approved"
                        ? "border-[color:var(--ds-color-success)]/25 bg-[color:var(--ds-color-success)]/10 text-[var(--ds-color-success)]"
                        : step.status === "pending"
                          ? "border-[color:var(--ds-color-warning)]/25 bg-[color:var(--ds-color-warning)]/10 text-[var(--ds-color-warning)]"
                          : step.status === "rejected"
                            ? "border-[color:var(--ds-color-danger)]/25 bg-[color:var(--ds-color-danger)]/10 text-[var(--ds-color-danger)]"
                            : "border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)]"
                    }`}
                  >
                    {step.level_order}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                      {step.title}
                    </p>
                    <p className="mt-1 text-xs text-[var(--ds-color-text-secondary)]">
                      Papel esperado: {step.approver_role}
                    </p>
                  </div>
                </div>
                <StatusPill tone={STEP_TONE[step.status]}>
                  {STEP_LABEL[step.status]}
                </StatusPill>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-[var(--ds-color-text-muted)] md:grid-cols-2">
                {step.event_hash ? (
                  <p>
                    Hash do evento: {step.event_hash.slice(0, 16)}...
                  </p>
                ) : null}
                {step.actor_signature_hash ? (
                  <p>
                    Assinatura HMAC: {step.actor_signature_hash.slice(0, 16)}...
                  </p>
                ) : null}
                {step.actor_signature_signed_at ? (
                  <p>
                    Assinado em:{" "}
                    {new Date(step.actor_signature_signed_at).toLocaleString(
                      "pt-BR",
                    )}
                  </p>
                ) : null}
                {step.actor_signature_timestamp_authority ? (
                  <p>
                    Autoridade temporal: {step.actor_signature_timestamp_authority}
                  </p>
                ) : null}
              </div>
              {step.decision_reason ? (
                <div className="mt-3 rounded-[var(--ds-radius-md)] bg-[var(--ds-color-surface-muted)]/40 px-3 py-2 text-xs text-[var(--ds-color-text-secondary)]">
                  <span className="font-semibold text-[var(--ds-color-text-primary)]">
                    Motivo:
                  </span>{" "}
                  {step.decision_reason}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {!flow?.steps.length && !loading ? (
        <div className="rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/30 px-4 py-6 text-center text-sm text-[var(--ds-color-text-muted)]">
          Nenhum fluxo de aprovação iniciado para este DDS.
        </div>
      ) : null}

      {canManage ? (
        <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/20 p-4">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
              Ações de governança
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              Informe o motivo e o PIN antes de iniciar, aprovar, reprovar ou reabrir.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <label
                className="mb-1 block text-sm font-medium text-[var(--ds-color-text-secondary)]"
                htmlFor="dds-approval-reason"
              >
                Motivo da decisão
              </label>
              <textarea
                id="dds-approval-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                aria-label="Motivo da decisão do fluxo de aprovação do DDS"
                className="w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[color:var(--component-field-bg-subtle)] px-3 py-2.5 text-sm text-[var(--component-field-text)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]"
                placeholder="Motivo opcional para aprovação; obrigatório para reprovação ou reabertura."
                disabled={locked || acting !== null}
              />
            </div>
            <div>
              <label
                className="mb-1 block text-sm font-medium text-[var(--ds-color-text-secondary)]"
                htmlFor="dds-approval-pin"
              >
                PIN de assinatura
              </label>
              <input
                id="dds-approval-pin"
                type="password"
                value={pin}
                onChange={(event) =>
                  setPin(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                inputMode="numeric"
                maxLength={6}
                aria-label="PIN para assinatura da decisão DDS"
                className="w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[color:var(--component-field-bg-subtle)] px-3 py-2.5 text-sm text-[var(--component-field-text)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]"
                placeholder="4 a 6 dígitos"
                disabled={locked || acting !== null}
              />
            </div>
            <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-3 text-xs text-[var(--ds-color-text-muted)] md:col-span-1">
              <p className="font-semibold text-[var(--ds-color-text-secondary)]">
                Regra de leitura
              </p>
              <p className="mt-1">
                Aprovação é rápida; reprovação e reabertura exigem justificativa
                explícita para manter a trilha de auditoria clara.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Button
              type="button"
              variant="outline"
              loading={acting === 'approve' && flow?.status === "not_started"}
              disabled={locked || acting !== null || flow?.status !== "not_started"}
              onClick={initialize}
              leftIcon={<ShieldCheck className="h-4 w-4" />}
            >
              Iniciar aprovação
            </Button>
            <Button
              type="button"
              variant="success"
              loading={acting === 'approve' && flow?.status === "pending"}
              disabled={locked || acting !== null || !flow?.currentStep}
              onClick={approve}
              leftIcon={<CheckCircle2 className="h-4 w-4" />}
            >
              Aprovar etapa
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={acting === 'reject'}
              disabled={locked || acting !== null || !flow?.currentStep}
              onClick={reject}
              leftIcon={<XCircle className="h-4 w-4" />}
            >
              Reprovar
            </Button>
            <Button
              type="button"
              variant="warning"
              loading={acting === 'reopen'}
              disabled={locked || acting !== null || flow?.status !== "rejected"}
              onClick={reopen}
              leftIcon={<RotateCcw className="h-4 w-4" />}
              >
              Reabrir ciclo
            </Button>
          </div>
        </div>
      ) : null}
      {/* Modal de confirmação de segurança para ações irreversíveis */}
      {pendingAction ? (
        <div
          ref={confirmDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar ação de aprovação"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        >
          <div className="mx-4 w-full max-w-sm rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-6 shadow-2xl">
            <div className="mb-4">
              <h3 className="text-base font-bold text-[var(--ds-color-text-primary)]">
                {pendingAction === "approve"
                  ? "Confirmar aprovação"
                  : pendingAction === "reject"
                    ? "Confirmar reprovação"
                    : "Confirmar reabertura de ciclo"}
              </h3>
              <p className="mt-2 text-sm text-[var(--ds-color-text-secondary)]">
                {pendingAction === "approve"
                  ? "Você está prestes a aprovar esta etapa do fluxo DDS. Esta ação será registrada na trilha de auditoria com sua assinatura HMAC."
                  : pendingAction === "reject"
                    ? "Você está prestes a reprovar esta etapa. O fluxo será marcado como reprovado e deverá ser reaberto para nova tentativa."
                    : "Você está prestes a reabrir o ciclo de aprovação do DDS. Um novo ciclo será criado com os passos configurados."}
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPendingAction(null)}
                disabled={acting !== null}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                variant={
                  pendingAction === "approve"
                    ? "success"
                    : pendingAction === "reject"
                      ? "destructive"
                      : "warning"
                }
                loading={acting !== null}
                onClick={() => void confirmAction()}
              >
                {pendingAction === "approve"
                  ? "Confirmar aprovação"
                  : pendingAction === "reject"
                    ? "Confirmar reprovação"
                    : "Confirmar reabertura"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}



