"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { use, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ClipboardCheck,
  FileCheck2,
  ShieldAlert,
  ShieldCheck,
  Signature,
} from "lucide-react";
import { PageHeader } from "@/components/layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buildApiUrl } from "@/lib/api";
import {
  buildDdsValidationApiPath,
  buildGenericVerifyRedirect,
  formatValidationSecurityReason,
  isDdsValidationCode,
} from "./validation-utils";

type ValidarPageProps = {
  params: Promise<{
    code?: string;
  }>;
};

type DdsValidationResponse = {
  valid: boolean;
  code: string;
  message?: string;
  document?: {
    title: string;
    document_type: string;
    original_name: string | null;
    file_hash: string | null;
    updated_at: string;
  };
  final_document?: {
    has_final_pdf: boolean;
    document_code: string | null;
    original_name: string | null;
    file_hash: string | null;
    emitted_at: string | null;
  };
  approval_summary?: {
    status: "approved";
    cycle: number | null;
    event_hash: string | null;
    approved_by: string | null;
    approved_at: string | null;
    signature_hash: string | null;
    signature_signed_at: string | null;
    timestamp_authority: string | null;
  } | null;
  dds?: {
    id: string;
    tema: string;
    status: string;
    data: string | null;
    company_name: string | null;
    site_name: string | null;
    facilitator_name: string | null;
    participant_count: number;
    audit_result: string | null;
    audited_at: string | null;
    audited_by: string | null;
    emitted_by: string | null;
    emitted_at: string | null;
    final_pdf_hash: string | null;
  } | null;
  approval_timeline?: Array<{
    cycle: number;
    level_order: number;
    title: string;
    approver_role: string;
    action: string;
    actor_name: string | null;
    event_at: string | null;
    event_hash: string | null;
    signature_hash: string | null;
    signature_signed_at: string | null;
    timestamp_authority: string | null;
  }> | null;
  validation_security?: {
    request_tracked: boolean;
    token_protected: boolean;
    suspicious_request: boolean;
    suspicious_reasons: string[];
    rate_limit: string;
    portal: string;
    blocked: boolean;
  } | null;
};

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("pt-BR");
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("pt-BR");
}

function actionLabel(action: string) {
  switch (action) {
    case "approved":
      return "Aprovado";
    case "rejected":
      return "Reprovado";
    case "reopened":
      return "Reaberto";
    case "canceled":
      return "Cancelado";
    default:
      return action;
  }
}

export default function ValidarPage({ params }: ValidarPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { code: routeCode } = use(params);
  const code = decodeURIComponent(routeCode || "").trim();
  const token = searchParams.get("token")?.trim() || null;
  const moduleParam = searchParams.get("module");
  const shouldRenderDds = useMemo(
    () => isDdsValidationCode(code, moduleParam),
    [code, moduleParam],
  );

  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<DdsValidationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      router.replace("/verify");
      return;
    }

    if (!shouldRenderDds) {
      router.replace(buildGenericVerifyRedirect(code, token));
      return;
    }

    const url = buildApiUrl(buildDdsValidationApiPath(code, token));
    if (!url) {
      setLoading(false);
      setError(
        "API pública não configurada para este ambiente. Defina NEXT_PUBLIC_API_URL.",
      );
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    fetch(url, { method: "GET", cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as DdsValidationResponse;
        if (!active) return;
        setResult(data);
        if (!data.valid) {
          setError(data.message || "DDS não localizado.");
        }
      })
      .catch(() => {
        if (!active) return;
        setError("Falha ao consultar a validação pública do DDS.");
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [code, router, shouldRenderDds, token]);

  if (!shouldRenderDds) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-[var(--ds-color-bg-subtle)] px-4">
        <div className="rounded-2xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <p className="text-sm text-[var(--ds-color-text-secondary)]">
            Redirecionando para validação do documento...
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-[var(--ds-color-bg-subtle)] px-4 py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          eyebrow="Validação pública DDS"
          title="Autenticidade e governança do DDS"
          description="Consulte a integridade do documento, a aprovação rastreável e a assinatura vinculada ao fluxo."
          icon={<ShieldCheck className="h-5 w-5" />}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Código consultado</CardTitle>
            <CardDescription>
              Código público do DDS validado pelo QR Code ou link institucional.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-[var(--ds-color-text-secondary)]">
            <p className="font-semibold text-[var(--ds-color-text-primary)]">
              {code || "-"}
            </p>
          </CardContent>
        </Card>

        {loading ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-6 text-sm text-[var(--ds-color-text-secondary)]">
              <ClipboardCheck className="h-4 w-4 animate-pulse" />
              Validando DDS governado...
            </CardContent>
          </Card>
        ) : error ? (
          <Card>
            <CardContent className="flex items-start gap-3 py-6 text-sm text-[var(--ds-color-danger)]">
              <ShieldAlert className="mt-0.5 h-5 w-5" />
              <div className="space-y-2">
                <p className="font-medium">{error}</p>
                <Link
                  href={buildGenericVerifyRedirect(code || "", token)}
                  className="text-[var(--ds-color-action-primary)] underline"
                >
                  Abrir validação genérica
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : result?.valid ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileCheck2 className="h-4 w-4 text-[var(--ds-color-success)]" />
                  Documento autenticado
                </CardTitle>
                <CardDescription>
                  O DDS foi localizado no registry documental governado.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm text-[var(--ds-color-text-secondary)] md:grid-cols-2">
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Tema:</strong>{" "}
                  {result.dds?.tema || result.document?.title || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Status:</strong>{" "}
                  {result.dds?.status || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Empresa:</strong>{" "}
                  {result.dds?.company_name || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Site:</strong>{" "}
                  {result.dds?.site_name || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Facilitador:</strong>{" "}
                  {result.dds?.facilitator_name || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Participantes:</strong>{" "}
                  {result.dds?.participant_count ?? "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Data do DDS:</strong>{" "}
                  {formatDate(result.dds?.data)}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Última atualização:</strong>{" "}
                  {formatDateTime(result.document?.updated_at)}
                </p>
              </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck className="h-4 w-4 text-[var(--ds-color-success)]" />
                    PDF final e emissão
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-[var(--ds-color-text-secondary)]">
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">PDF final governado:</strong>{" "}
                    {result.final_document?.has_final_pdf ? "Sim" : "Não"}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Código documental:</strong>{" "}
                    {result.final_document?.document_code || "-"}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Emitido em:</strong>{" "}
                    {formatDateTime(result.dds?.emitted_at || result.final_document?.emitted_at)}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Emitido por:</strong>{" "}
                    {result.dds?.emitted_by || "-"}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Hash final do PDF:</strong>{" "}
                    {result.dds?.final_pdf_hash || result.final_document?.file_hash || "-"}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Signature className="h-4 w-4 text-[var(--ds-color-action-primary)]" />
                    Aprovação e assinatura
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-[var(--ds-color-text-secondary)]">
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Resultado da auditoria:</strong>{" "}
                    {result.dds?.audit_result || "-"}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Auditado em:</strong>{" "}
                    {formatDateTime(result.dds?.audited_at)}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Auditado por:</strong>{" "}
                    {result.dds?.audited_by || "-"}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Ciclo aprovado:</strong>{" "}
                    {result.approval_summary?.cycle ?? "-"}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Aprovado por:</strong>{" "}
                    {result.approval_summary?.approved_by || "-"}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Hash da assinatura:</strong>{" "}
                    {result.approval_summary?.signature_hash || "-"}
                  </p>
                  <p>
                    <strong className="text-[var(--ds-color-text-primary)]">Autoridade temporal:</strong>{" "}
                    {result.approval_summary?.timestamp_authority || "-"}
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert
                    className={`h-4 w-4 ${
                      result.validation_security?.suspicious_request
                        ? "text-[var(--ds-color-warning)]"
                        : "text-[var(--ds-color-success)]"
                    }`}
                  />
                  Proteção do portal
                </CardTitle>
                <CardDescription>
                  Telemetria antifraude aplicada à consulta pública do DDS.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm text-[var(--ds-color-text-secondary)] md:grid-cols-2">
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Token obrigatório:</strong>{" "}
                  {result.validation_security?.token_protected ? "Sim" : "Não"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Telemetria de requisição:</strong>{" "}
                  {result.validation_security?.request_tracked ? "Ativa" : "Inativa"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Rate limit:</strong>{" "}
                  {result.validation_security?.rate_limit || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">Portal:</strong>{" "}
                  {result.validation_security?.portal || "-"}
                </p>
                <p className="md:col-span-2">
                  <strong className="text-[var(--ds-color-text-primary)]">Sinalização de risco:</strong>{" "}
                  {result.validation_security?.suspicious_request
                    ? "Consulta marcada como sensível para auditoria"
                    : "Nenhum sinal anômalo identificado"}
                </p>
                {result.validation_security?.suspicious_reasons?.length ? (
                  <p className="md:col-span-2">
                    <strong className="text-[var(--ds-color-text-primary)]">Motivos:</strong>{" "}
                    {result.validation_security.suspicious_reasons
                      .map((reason) => formatValidationSecurityReason(reason))
                      .join(" • ")}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CheckCircle2 className="h-4 w-4 text-[var(--ds-color-success)]" />
                  Trilha técnica de aprovação
                </CardTitle>
                <CardDescription>
                  Eventos do ciclo mais recente de aprovação do DDS.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {result.approval_timeline?.length ? (
                  result.approval_timeline.map((event) => (
                    <div
                      key={`${event.cycle}-${event.level_order}-${event.event_hash}`}
                      className="rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 text-sm text-[var(--ds-color-text-secondary)]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold text-[var(--ds-color-text-primary)]">
                          {event.level_order > 0
                            ? `${event.level_order}. ${event.title}`
                            : event.title}
                        </p>
                        <span className="rounded-full bg-[color:var(--ds-color-success)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--ds-color-success)]">
                          {actionLabel(event.action)}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1 md:grid-cols-2">
                        <p>Perfil: {event.approver_role}</p>
                        <p>Ator: {event.actor_name || "-"}</p>
                        <p>Data/hora: {formatDateTime(event.event_at)}</p>
                        <p>Ciclo: {event.cycle}</p>
                        <p>Hash do evento: {event.event_hash || "-"}</p>
                        <p>Hash da assinatura: {event.signature_hash || "-"}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-[var(--ds-color-text-secondary)]">
                    Nenhum evento público de aprovação disponível para este DDS.
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}

        <p className="flex items-center gap-1 text-[11px] text-[var(--ds-color-text-muted)]">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Validação premium do DDS com trilha de aprovação e assinatura rastreável.
        </p>
      </div>
    </main>
  );
}
