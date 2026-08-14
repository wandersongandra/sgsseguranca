"use client";

import Image from "next/image";
import { useMemo, useRef } from "react";
import {
  AlertTriangle,
  Download,
  Mail,
  Pencil,
  PenLine,
  Printer,
  Sun,
  Thermometer,
  Users,
  Wrench,
  Package,
  CheckSquare,
  X,
} from "lucide-react";
import type { Rdo } from "@/services/rdosService";
import { maskCpf } from "@/lib/format/cpf";
import { RDO_STATUS_COLORS, RDO_STATUS_LABEL, CLIMA_LABEL, OCORRENCIA_TIPO_LABEL } from "@/services/rdosService";
import { safeToLocaleDateString } from "@/lib/date/safeFormat";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { DocumentVideoPanel } from "@/components/document-videos/DocumentVideoPanel";
import type { GovernedDocumentVideoAccessResponse, GovernedDocumentVideoAttachment } from "@/lib/videos/documentVideos";

type ViewerVideoState = {
  attachments: GovernedDocumentVideoAttachment[];
  loading: boolean;
  uploading: boolean;
  removingId: string | null;
  handleUpload: (file: File) => Promise<unknown>;
  handleRemove: (attachment: GovernedDocumentVideoAttachment) => Promise<unknown>;
  resolveAccess: (
    attachment: GovernedDocumentVideoAttachment,
  ) => Promise<GovernedDocumentVideoAccessResponse | null>;
};

interface RdoViewerModalProps {
  open: boolean;
  viewRdo: Rdo | null;
  canManageRdo: boolean;
  viewRdoLocked: boolean;
  viewRdoLockMessage: string | null;
  viewRdoVideos: ViewerVideoState;
  getAllowedStatusTransitions: (rdo: Rdo) => string[];
  resolveActivityPhotoSrc: (photo: string) => string;
  onClose: () => void;
  onEdit: (rdo: Rdo) => void;
  onPrint: (rdo: Rdo) => void;
  onOpenGovernedPdf: (rdo: Rdo) => void;
  onCancelRdo: (rdo: Rdo) => void;
  onOpenSign: (rdo: Rdo) => void;
  onOpenEmail: (rdo: Rdo) => void;
  onChangeStatus: (id: string, newStatus: string) => void;
}

type ParsedRdoSignature = {
  nome: string;
  cpf: string;
  signedAt: string | null;
  verificationMode: string | null;
};

function parseSignature(raw?: string | null): ParsedRdoSignature | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const nome =
      typeof parsed.nome === "string"
        ? parsed.nome
        : typeof parsed.aceite_por === "string"
          ? parsed.aceite_por
          : null;
    const cpf = typeof parsed.cpf === "string" ? parsed.cpf : null;

    if (!nome || !cpf) {
      return null;
    }

    return {
      nome,
      cpf,
      signedAt:
        typeof parsed.signed_at === "string"
          ? parsed.signed_at
          : typeof parsed.realizado_em === "string"
            ? parsed.realizado_em
            : null,
      verificationMode:
        typeof parsed.verification_mode === "string"
          ? parsed.verification_mode
          : null,
    };
  } catch {
    return null;
  }
}

function formatSignatureDate(value?: string | null) {
  if (!value) {
    return "Data não disponível";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Data não disponível"
    : parsed.toLocaleString("pt-BR");
}

export function RdoViewerModal({
  open,
  viewRdo,
  canManageRdo,
  viewRdoLocked,
  viewRdoLockMessage,
  viewRdoVideos,
  getAllowedStatusTransitions,
  resolveActivityPhotoSrc,
  onClose,
  onEdit,
  onPrint,
  onOpenGovernedPdf,
  onCancelRdo,
  onOpenSign,
  onOpenEmail,
  onChangeStatus,
}: RdoViewerModalProps) {
  const totalTrabalhadores = useMemo(
    () =>
      (viewRdo?.mao_de_obra ?? []).reduce((total, item) => total + item.quantidade, 0),
    [viewRdo],
  );

  const viewerDialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(viewerDialogRef, open && viewRdo !== null, onClose);

  if (!open || !viewRdo) {
    return null;
  }

  return (
    <div
      ref={viewerDialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Visualizar RDO ${viewRdo.numero}`}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] shadow-[var(--ds-shadow-lg)]">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--ds-color-border-subtle)] px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm font-bold text-[var(--ds-color-action-primary)]">
              {viewRdo.numero}
            </span>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${RDO_STATUS_COLORS[viewRdo.status] ?? ""}`}
            >
              {RDO_STATUS_LABEL[viewRdo.status] ?? viewRdo.status}
            </span>
            {getAllowedStatusTransitions(viewRdo).length > 0 && (
              <select
                aria-label="Mover status do RDO"
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    onChangeStatus(viewRdo.id, e.target.value);
                  }
                }}
                className="rounded border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-1 py-0.5 text-xs text-[var(--ds-color-text-secondary)]"
              >
                <option value="">Mover para...</option>
                {getAllowedStatusTransitions(viewRdo).map((status) => (
                  <option key={status} value={status}>
                    {RDO_STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canManageRdo ? (
              <button
                type="button"
                onClick={() => onEdit(viewRdo)}
                className="flex items-center gap-1 rounded-lg border border-[var(--ds-color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] motion-safe:transition-colors"
              >
                <Pencil className="h-3.5 w-3.5" /> Editar
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Fechar visualização"
              onClick={onClose}
              className="rounded-lg p-1.5 text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto space-y-5 px-6 py-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
            {[
              {
                label: "Data",
                value: safeToLocaleDateString(
                  viewRdo.data,
                  "pt-BR",
                  undefined,
                  "—",
                ),
              },
              { label: "Obra/Setor", value: viewRdo.site?.nome ?? "—" },
              { label: "Responsável", value: viewRdo.responsavel?.nome ?? "—" },
              { label: "Trabalhadores", value: String(totalTrabalhadores) },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-xl border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/30 px-4 py-3"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                  {item.label}
                </p>
                <p className="mt-0.5 text-sm font-medium text-[var(--ds-color-text-primary)]">
                  {item.value}
                </p>
              </div>
            ))}
          </div>

          {(viewRdo.houve_acidente || viewRdo.houve_paralisacao) && (
            <div className="flex flex-wrap gap-3">
              {viewRdo.houve_acidente && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--ds-color-danger)]/10 px-3 py-1 text-xs font-medium text-[var(--ds-color-danger)]">
                  <AlertTriangle className="h-3.5 w-3.5" /> Houve acidente
                </span>
              )}
              {viewRdo.houve_paralisacao && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--ds-color-warning)]/10 px-3 py-1 text-xs font-medium text-[var(--ds-color-warning)]">
                  <AlertTriangle className="h-3.5 w-3.5" /> Houve paralisação
                  {viewRdo.motivo_paralisacao
                    ? `: ${viewRdo.motivo_paralisacao}`
                    : ""}
                </span>
              )}
            </div>
          )}

          {(viewRdo.clima_manha ||
            viewRdo.clima_tarde ||
            viewRdo.temperatura_min != null) && (
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                <Sun className="h-3.5 w-3.5" /> Condições Climáticas
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
                {viewRdo.clima_manha && (
                  <div className="rounded-lg border border-[var(--ds-color-border-subtle)] px-3 py-2">
                    <p className="text-xs text-[var(--ds-color-text-secondary)]">
                      Manhã
                    </p>
                    <p className="text-sm font-medium text-[var(--ds-color-text-primary)]">
                      {CLIMA_LABEL[viewRdo.clima_manha] ?? viewRdo.clima_manha}
                    </p>
                  </div>
                )}
                {viewRdo.clima_tarde && (
                  <div className="rounded-lg border border-[var(--ds-color-border-subtle)] px-3 py-2">
                    <p className="text-xs text-[var(--ds-color-text-secondary)]">
                      Tarde
                    </p>
                    <p className="text-sm font-medium text-[var(--ds-color-text-primary)]">
                      {CLIMA_LABEL[viewRdo.clima_tarde] ?? viewRdo.clima_tarde}
                    </p>
                  </div>
                )}
                {(viewRdo.temperatura_min != null ||
                  viewRdo.temperatura_max != null) && (
                  <div className="flex items-center gap-1 rounded-lg border border-[var(--ds-color-border-subtle)] px-3 py-2">
                    <Thermometer className="h-3.5 w-3.5 text-[var(--ds-color-text-secondary)]" />
                    <p className="text-sm font-medium text-[var(--ds-color-text-primary)]">
                      {viewRdo.temperatura_min ?? "?"}°C –{" "}
                      {viewRdo.temperatura_max ?? "?"}°C
                    </p>
                  </div>
                )}
                {viewRdo.condicao_terreno && (
                  <div className="rounded-lg border border-[var(--ds-color-border-subtle)] px-3 py-2">
                    <p className="text-xs text-[var(--ds-color-text-secondary)]">
                      Terreno
                    </p>
                    <p className="text-sm font-medium text-[var(--ds-color-text-primary)]">
                      {viewRdo.condicao_terreno}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {(viewRdo.mao_de_obra ?? []).length > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                <Users className="h-3.5 w-3.5" /> Mão de Obra ({totalTrabalhadores}{" "}
                trabalhadores)
              </p>
              <div className="overflow-x-auto rounded-xl border border-[var(--ds-color-border-subtle)]">
                <table className="min-w-[620px] w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/40">
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Função
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Qtd
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Turno
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Horas
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewRdo.mao_de_obra!.map((item, index) => (
                      <tr
                        key={index}
                        className="border-b border-[var(--ds-color-border-subtle)] last:border-0"
                      >
                        <td className="px-3 py-2 text-[var(--ds-color-text-primary)]">
                          {item.funcao}
                        </td>
                        <td className="px-3 py-2 text-center text-[var(--ds-color-text-secondary)]">
                          {item.quantidade}
                        </td>
                        <td className="px-3 py-2 text-center capitalize text-[var(--ds-color-text-secondary)]">
                          {item.turno}
                        </td>
                        <td className="px-3 py-2 text-center text-[var(--ds-color-text-secondary)]">
                          {item.horas}h
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(viewRdo.equipamentos ?? []).length > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                <Wrench className="h-3.5 w-3.5" /> Equipamentos
              </p>
              <div className="overflow-x-auto rounded-xl border border-[var(--ds-color-border-subtle)]">
                <table className="min-w-[760px] w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/40">
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Equipamento
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Qtd
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        H. trabalhadas
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        H. ociosas
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewRdo.equipamentos!.map((item, index) => (
                      <tr
                        key={index}
                        className="border-b border-[var(--ds-color-border-subtle)] last:border-0"
                      >
                        <td className="px-3 py-2 text-[var(--ds-color-text-primary)]">
                          {item.nome}
                        </td>
                        <td className="px-3 py-2 text-center text-[var(--ds-color-text-secondary)]">
                          {item.quantidade}
                        </td>
                        <td className="px-3 py-2 text-center text-[var(--ds-color-text-secondary)]">
                          {item.horas_trabalhadas}h
                        </td>
                        <td className="px-3 py-2 text-center text-[var(--ds-color-text-secondary)]">
                          {item.horas_ociosas}h
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(viewRdo.materiais_recebidos ?? []).length > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                <Package className="h-3.5 w-3.5" /> Materiais Recebidos
              </p>
              <div className="overflow-x-auto rounded-xl border border-[var(--ds-color-border-subtle)]">
                <table className="min-w-[520px] w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/40">
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Descrição
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Qtd
                      </th>
                      <th className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                        Unidade
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewRdo.materiais_recebidos!.map((item, index) => (
                      <tr
                        key={index}
                        className="border-b border-[var(--ds-color-border-subtle)] last:border-0"
                      >
                        <td className="px-3 py-2 text-[var(--ds-color-text-primary)]">
                          {item.descricao}
                        </td>
                        <td className="px-3 py-2 text-center text-[var(--ds-color-text-secondary)]">
                          {item.quantidade}
                        </td>
                        <td className="px-3 py-2 text-center text-[var(--ds-color-text-secondary)]">
                          {item.unidade}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(viewRdo.servicos_executados ?? []).length > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                <CheckSquare className="h-3.5 w-3.5" /> Serviços Executados
              </p>
              <div className="space-y-2">
                {viewRdo.servicos_executados!.map((service, index) => (
                  <div
                    key={index}
                    className="space-y-3 rounded-lg border border-[var(--ds-color-border-subtle)] px-3 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex-1 text-sm text-[var(--ds-color-text-primary)]">
                        {service.descricao}
                      </span>
                      <div className="flex items-center gap-2">
                        <div
                          className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--ds-color-border-subtle)]"
                          title={`${service.percentual_concluido}% concluído`}
                          aria-hidden="true"
                        >
                          <div
                            className="h-full rounded-full bg-[var(--ds-color-success)] motion-safe:transition-all"
                            style={{ width: `${service.percentual_concluido}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs font-medium text-[var(--ds-color-text-secondary)]">
                          {service.percentual_concluido}%
                        </span>
                      </div>
                    </div>

                    {service.observacao && (
                      <p className="text-sm text-[var(--ds-color-text-secondary)]">
                        {service.observacao}
                      </p>
                    )}

                    {(service.fotos?.length ?? 0) > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                          Evidências fotográficas ({service.fotos?.length ?? 0})
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {(service.fotos ?? []).map((photo, photoIndex) => (
                            <a
                              key={`${photo}-${photoIndex}`}
                              href={resolveActivityPhotoSrc(photo) || "#"}
                              target="_blank"
                              rel="noreferrer"
                              className="relative block h-20 w-20 overflow-hidden rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)]"
                            >
                              <Image
                                src={
                                  resolveActivityPhotoSrc(photo) ||
                                  "/placeholder-image.png"
                                }
                                alt={`Foto ${photoIndex + 1} da atividade ${index + 1}`}
                                fill
                                className="object-cover"
                                sizes="80px"
                                unoptimized
                              />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(viewRdo.ocorrencias ?? []).length > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                <AlertTriangle className="h-3.5 w-3.5" /> Ocorrências
              </p>
              <div className="space-y-2">
                {viewRdo.ocorrencias!.map((item, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-3 rounded-lg border border-[var(--ds-color-border-subtle)] px-3 py-2"
                  >
                    <span className="rounded-full bg-[color:var(--ds-color-warning)]/10 px-2 py-0.5 text-xs font-medium text-[var(--ds-color-warning)]">
                      {OCORRENCIA_TIPO_LABEL[item.tipo] ?? item.tipo}
                    </span>
                    <span className="flex-1 text-sm text-[var(--ds-color-text-primary)]">
                      {item.descricao}
                    </span>
                    {item.hora && (
                      <span className="text-xs text-[var(--ds-color-text-secondary)]">
                        {item.hora}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {viewRdo.observacoes && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                Observações gerais
              </p>
              <p className="whitespace-pre-wrap rounded-xl border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/30 px-4 py-3 text-sm text-[var(--ds-color-text-primary)]">
                {viewRdo.observacoes}
              </p>
            </div>
          )}

          {viewRdo.programa_servicos_amanha && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
                Programa para amanhã
              </p>
              <p className="whitespace-pre-wrap rounded-xl border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/30 px-4 py-3 text-sm text-[var(--ds-color-text-primary)]">
                {viewRdo.programa_servicos_amanha}
              </p>
            </div>
          )}

          <div>
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]">
              <PenLine className="h-3.5 w-3.5" /> Assinaturas
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {[
                { label: "Responsável pela Obra", raw: viewRdo.assinatura_responsavel },
                { label: "Engenheiro Responsável", raw: viewRdo.assinatura_engenheiro },
              ].map((item) => {
                const sig = parseSignature(item.raw);
                return (
                  <div
                    key={item.label}
                    className={`rounded-xl border px-4 py-3 ${sig ? "border-[color:var(--ds-color-success)]/30 bg-[color:var(--ds-color-success)]/8" : "border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/20"}`}
                  >
                    <p className="text-xs font-semibold text-[var(--ds-color-text-secondary)]">
                      {item.label}
                    </p>
                    {sig ? (
                      <>
                        <p className="mt-1 text-sm font-medium text-[var(--ds-color-success)]">
                          {sig.nome}
                        </p>
                        <p className="text-xs text-[color:var(--ds-color-success)]/80">
                          CPF: {maskCpf(sig.cpf)}
                        </p>
                        <p className="text-xs text-[color:var(--ds-color-success)]/80">
                          {formatSignatureDate(sig.signedAt)}
                        </p>
                        {sig.verificationMode ? (
                          <p className="text-xs text-[color:var(--ds-color-success)]/80">
                            {sig.verificationMode === "operational_ack"
                              ? "Aceite operacional verificável"
                              : sig.verificationMode}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="mt-1 text-xs italic text-[var(--ds-color-text-secondary)]">
                        Aguardando assinatura
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <DocumentVideoPanel
            title="Vídeos governados"
            description="Anexe vídeos oficiais ao RDO para complementar a evidência operacional com acesso seguro."
            documentId={viewRdo.id}
            canManage={canManageRdo}
            locked={viewRdoLocked}
            lockMessage={viewRdoLockMessage}
            attachments={viewRdoVideos.attachments}
            loading={viewRdoVideos.loading}
            uploading={viewRdoVideos.uploading}
            removingId={viewRdoVideos.removingId}
            onUpload={viewRdoVideos.handleUpload}
            onRemove={viewRdoVideos.handleRemove}
            resolveAccess={viewRdoVideos.resolveAccess}
          />
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--ds-color-border-subtle)] px-6 py-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPrint(viewRdo)}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--ds-color-border-subtle)] px-3 py-2 text-xs font-medium text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] motion-safe:transition-colors"
            >
              <Printer className="h-3.5 w-3.5" /> Imprimir
            </button>
            {canManageRdo || viewRdo.pdf_file_key ? (
              <button
                type="button"
                onClick={() => onOpenGovernedPdf(viewRdo)}
                className="flex items-center gap-1.5 rounded-xl border border-[var(--ds-color-border-subtle)] px-3 py-2 text-xs font-medium text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-action-primary)]/10 hover:text-[var(--ds-color-action-primary)] motion-safe:transition-colors"
              >
                <Download className="h-3.5 w-3.5" />{" "}
                {viewRdo.pdf_file_key ? "Abrir PDF final" : "Emitir PDF final"}
              </button>
            ) : null}
            {canManageRdo ? (
              <>
                {viewRdo.status !== "cancelado" && !viewRdo.pdf_file_key ? (
                  <button
                    type="button"
                    onClick={() => onCancelRdo(viewRdo)}
                    className="flex items-center gap-1.5 rounded-xl border border-[color:var(--ds-color-danger)]/30 px-3 py-2 text-xs font-medium text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10 motion-safe:transition-colors"
                  >
                    <X className="h-3.5 w-3.5" /> Cancelar RDO
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onOpenSign(viewRdo)}
                  className="flex items-center gap-1.5 rounded-xl border border-[var(--ds-color-border-subtle)] px-3 py-2 text-xs font-medium text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-action-primary)]/10 hover:text-[var(--ds-color-action-primary)] motion-safe:transition-colors"
                >
                  <PenLine className="h-3.5 w-3.5" /> Assinar
                </button>
                <button
                  type="button"
                  onClick={() => onOpenEmail(viewRdo)}
                  className="flex items-center gap-1.5 rounded-xl border border-[var(--ds-color-border-subtle)] px-3 py-2 text-xs font-medium text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-action-primary)]/10 hover:text-[var(--ds-color-action-primary)] motion-safe:transition-colors"
                >
                  <Mail className="h-3.5 w-3.5" /> Enviar e-mail
                </button>
              </>
            ) : null}
          </div>
          {canManageRdo ? (
            <button
              type="button"
              onClick={() => onEdit(viewRdo)}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--ds-color-border-subtle)] px-3 py-2 text-xs font-medium text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] motion-safe:transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" /> Editar
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
