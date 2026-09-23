"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CheckCircle2, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layout";
import { buildApiUrl } from "@/lib/api";

type VerifyMode = "evidence" | "signature" | "code";

function resolveCodeValidationEndpoint(code: string, token?: string) {
  const normalized = code.trim().toUpperCase();
  const params = new URLSearchParams({
    code: code.trim(),
  });
  if (token?.trim()) {
    params.set("token", token.trim());
  }

  if (normalized.startsWith("CHK-")) {
    return `/public/checklists/validate?${params.toString()}`;
  }

  if (normalized.startsWith("CAT-")) {
    return `/public/cats/validate?${params.toString()}`;
  }

  if (normalized.startsWith("DOS-")) {
    return `/public/dossiers/validate?${params.toString()}`;
  }

  if (normalized.startsWith("APR-")) {
    return `/public/aprs/verify?${params.toString()}`;
  }

  return `/public/documents/validate?${params.toString()}`;
}

function normalizeVerifyMode(value: string | null): VerifyMode | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "evidence" ||
    normalized === "signature" ||
    normalized === "code"
  ) {
    return normalized;
  }

  if (normalized === "assinatura") {
    return "signature";
  }

  if (normalized === "codigo" || normalized === "document-code") {
    return "code";
  }

  return null;
}

interface EvidenceVerifyResponse {
  verified: boolean;
  matchedIn?: "original" | "watermarked";
  message?: string;
  evidence?: {
    apr_numero?: string;
    apr_versao?: number;
    risk_item_ordem?: number;
    uploaded_at?: string;
    original_hash?: string;
    watermarked_hash?: string;
    integrity_flags?: Record<string, unknown>;
  };
}

const SIGNATURE_TYPE_LABEL: Record<string, string> = {
  digital: "Digital (Desenho)",
  upload: "Imagem Enviada",
  facial: "Facial",
  hmac: "PIN Seguro (HMAC-SHA256)",
};

const SIGNATURE_VERIFICATION_MODE_LABEL: Record<string, string> = {
  server_verifiable: "Verificável server-side",
  operational_ack: "Aceite operacional",
  legacy_client_hash: "Hash do cliente",
};

const SIGNATURE_PROOF_SCOPE_LABEL: Record<string, string> = {
  governed_final_document: "Documento final governado",
  document_revision: "Revisão do documento",
  document_identity: "Identidade do documento",
  operational_snapshot: "Snapshot operacional",
};

const SIGNATURE_LEGAL_ASSURANCE_LABEL: Record<string, string> = {
  not_legal_strong: "Não equivale a assinatura jurídica forte",
};

interface SignatureVerifyResponse {
  valid: boolean;
  message?: string;
  signature?: {
    hash: string;
    signed_at?: string;
    timestamp_authority?: string;
    document_id?: string;
    document_type?: string;
    type?: string;
    verification_mode?: string;
    legal_assurance?: string;
    proof_scope?: string | null;
    document_binding_hash?: string | null;
    signature_evidence_hash?: string | null;
  };
}

interface CodeVerifyResponse {
  valid: boolean;
  code?: string;
  message?: string;
  document?: {
    id: string;
    module: string;
    document_type: string;
    title: string;
    document_date: string | null;
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
  checklist?: {
    id: string;
    titulo: string;
    status: string;
    data: string;
    is_modelo: boolean;
    site?: string;
    inspetor?: string;
    updated_at: string;
  };
}

const modeLabels: Record<VerifyMode, string> = {
  evidence: "Evidência APR",
  signature: "Assinatura PDF",
  code: "Código do documento",
};

export default function PublicHashVerifyPage() {
  const [mode, setMode] = useState<VerifyMode>("code");
  const [hash, setHash] = useState("");
  const [loading, setLoading] = useState(false);
  const [evidenceResult, setEvidenceResult] =
    useState<EvidenceVerifyResponse | null>(null);
  const [signatureResult, setSignatureResult] =
    useState<SignatureVerifyResponse | null>(null);
  const [codeResult, setCodeResult] = useState<CodeVerifyResponse | null>(null);
  const [validationToken, setValidationToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolvePublicUrl = useCallback((path: string) => {
    const url = buildApiUrl(path);
    if (!url) {
      throw new Error(
        "API pública não configurada para este ambiente. Defina NEXT_PUBLIC_API_URL no frontend.",
      );
    }
    return url;
  }, []);

  const resetResults = () => {
    setEvidenceResult(null);
    setSignatureResult(null);
    setCodeResult(null);
    setError(null);
  };

  const runVerify = useCallback(
    async (
      rawValue: string,
      targetMode: VerifyMode,
      tokenOverride?: string,
    ) => {
      resetResults();

      if (targetMode === "code") {
        const code = rawValue.trim();
        if (!code) {
          setError(
            "Informe o código do documento (ex.: PT-2026-11-ABCD1234 ou outro código válido).",
          );
          return;
        }
        try {
          setLoading(true);
          const effectiveToken = (tokenOverride ?? validationToken ?? "").trim();
          const endpoint = resolveCodeValidationEndpoint(
            code,
            effectiveToken || undefined,
          );
          const response = await fetch(resolvePublicUrl(endpoint), {
            method: "GET",
            cache: "no-store",
          });
          const data = (await response.json()) as CodeVerifyResponse;
          setCodeResult(data);
          if (!data.valid) {
            setError(data.message || "Documento não encontrado.");
          }
        } catch {
          setError("Falha ao consultar validação por código. Tente novamente.");
        } finally {
          setLoading(false);
        }
        return;
      }

      const normalizedHash = rawValue.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
        setError("Informe um hash SHA-256 válido com 64 caracteres.");
        return;
      }

      try {
        setLoading(true);
        if (targetMode === "evidence") {
          const response = await fetch(
            resolvePublicUrl(
              `/public/evidence/verify?hash=${encodeURIComponent(normalizedHash)}`,
            ),
            { method: "GET", cache: "no-store" },
          );
          const data = (await response.json()) as EvidenceVerifyResponse;
          setEvidenceResult(data);
        } else {
          const response = await fetch(
            resolvePublicUrl(
              `/public/signature/verify?hash=${encodeURIComponent(normalizedHash)}`,
            ),
            { method: "GET", cache: "no-store" },
          );
          const data = (await response.json()) as SignatureVerifyResponse;
          setSignatureResult(data);
        }
      } catch {
        setError("Falha ao consultar validação pública. Tente novamente.");
      } finally {
        setLoading(false);
      }
    },
    [resolvePublicUrl, validationToken],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runVerify(hash, mode);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParam = params.get("hash");
    const codeParam = params.get("code");
    const tokenParam = params.get("token");
    setValidationToken(tokenParam);
    const requestedMode =
      normalizeVerifyMode(params.get("type")) ??
      normalizeVerifyMode(params.get("mode"));
    if (codeParam) {
      setHash(codeParam);
      setMode("code");
      void runVerify(codeParam, "code", tokenParam || undefined);
      return;
    }
    if (hashParam) {
      const targetMode =
        requestedMode === "signature" || requestedMode === "evidence"
          ? requestedMode
          : "evidence";
      setHash(hashParam);
      setMode(targetMode);
      void runVerify(hashParam, targetMode);
    }
  }, [runVerify]);

  const isValid =
    mode === "evidence"
      ? Boolean(evidenceResult?.verified)
      : mode === "signature"
        ? Boolean(signatureResult?.valid)
        : Boolean(codeResult?.valid);

  return (
    <main className="min-h-screen bg-[var(--ds-color-bg-subtle)] px-4 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <PageHeader
          eyebrow="Validação pública"
          title="Autenticidade documental"
          description="Consulte autenticidade por código do documento ou por hash previamente registrado no backend real do sistema."
          icon={<ShieldCheck className="h-5 w-5" />}
        />

        <Card>
          <CardHeader className="space-y-3">
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Tipo de validação"
            >
              {(["evidence", "signature", "code"] as VerifyMode[]).map(
                (item) => (
                  <Button
                    key={item}
                    type="button"
                    variant={mode === item ? "default" : "secondary"}
                    size="sm"
                    aria-pressed={mode === item}
                    onClick={() => {
                      setMode(item);
                      resetResults();
                    }}
                  >
                    {modeLabels[item]}
                  </Button>
                ),
              )}
            </div>
            <CardDescription>
              {mode === "code"
                ? "Use o código público do documento para validar documentos emitidos e registros publicados."
                : "Use o hash SHA-256 do artefato registrado para consultar autenticidade."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  type="text"
                  value={hash}
                  onChange={(e) => setHash(e.target.value)}
                  placeholder={
                    mode === "code"
                      ? "Cole o código público do documento"
                      : "Cole o hash SHA-256"
                  }
                  aria-label={
                    mode === "code" ? "Código do documento" : "Hash SHA-256"
                  }
                  className="flex-1"
                />
                <Button
                  type="submit"
                  disabled={loading}
                  className="sm:min-w-[10rem]"
                >
                  <Search className="h-4 w-4" />
                  {loading ? "Consultando..." : "Validar"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {error || evidenceResult || signatureResult || codeResult ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Resultado da validação
              </CardTitle>
            </CardHeader>
            <CardContent>
              {error ? (
                <div className="flex items-start gap-2 text-[var(--ds-color-danger)]">
                  <ShieldAlert className="mt-0.5 h-5 w-5" />
                  <p className="text-[13px] font-medium">{error}</p>
                </div>
              ) : isValid ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 text-[var(--ds-color-success)]">
                    <ShieldCheck className="mt-0.5 h-5 w-5" />
                    <p className="text-[13px] font-semibold">
                      Registro validado com sucesso.
                    </p>
                  </div>

                  {mode === "code" && codeResult?.document ? (
                    <div className="rounded-lg border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-3 text-[13px] text-[var(--ds-color-text-secondary)]">
                      <p>Código: {codeResult.code}</p>
                      <p>Módulo: {codeResult.document.module.toUpperCase()}</p>
                      <p>Título: {codeResult.document.title}</p>
                      <p>Tipo: {codeResult.document.document_type}</p>
                      <p>
                        Data documental:{" "}
                        {codeResult.document.document_date || "-"}
                      </p>
                      <p>
                        Arquivo original:{" "}
                        {codeResult.document.original_name || "-"}
                      </p>
                      <p>
                        Hash do arquivo: {codeResult.document.file_hash || "-"}
                      </p>
                      <p>
                        Última atualização: {codeResult.document.updated_at}
                      </p>
                      {codeResult.final_document ? (
                        <>
                          <p>
                            PDF final governado:{" "}
                            {codeResult.final_document.has_final_pdf
                              ? "Sim"
                              : "Não"}
                          </p>
                          <p>
                            Código documental:{" "}
                            {codeResult.final_document.document_code || "-"}
                          </p>
                        </>
                      ) : null}
                      {codeResult.approval_summary ? (
                        <>
                          <p>
                            Aprovação DDS:{" "}
                            {codeResult.approval_summary.status === "approved"
                              ? "Aprovado"
                              : "-"}
                          </p>
                          <p>
                            Ciclo:{" "}
                            {codeResult.approval_summary.cycle != null
                              ? codeResult.approval_summary.cycle
                              : "-"}
                          </p>
                          <p>
                            Aprovado por:{" "}
                            {codeResult.approval_summary.approved_by || "-"}
                          </p>
                          <p>
                            Aprovado em:{" "}
                            {codeResult.approval_summary.approved_at || "-"}
                          </p>
                          <p>
                            Assinatura da aprovação:{" "}
                            {codeResult.approval_summary.signature_hash || "-"}
                          </p>
                          <p>
                            Assinada em:{" "}
                            {codeResult.approval_summary.signature_signed_at || "-"}
                          </p>
                          <p>
                            Autoridade temporal:{" "}
                            {codeResult.approval_summary.timestamp_authority || "-"}
                          </p>
                          <p>
                            Hash do evento:{" "}
                            {codeResult.approval_summary.event_hash || "-"}
                          </p>
                        </>
                      ) : null}
                    </div>
                  ) : mode === "code" && codeResult?.checklist ? (
                    <div className="rounded-lg border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-3 text-[13px] text-[var(--ds-color-text-secondary)]">
                      <p>Código: {codeResult.code}</p>
                      <p>Título: {codeResult.checklist.titulo}</p>
                      <p>Status: {codeResult.checklist.status}</p>
                      <p>Data: {codeResult.checklist.data}</p>
                      <p>Obra/Setor: {codeResult.checklist.site || "-"}</p>
                      <p>Responsável: {codeResult.checklist.inspetor || "-"}</p>
                      <p>
                        Tipo:{" "}
                        {codeResult.checklist.is_modelo
                          ? "Modelo"
                          : "Preenchimento"}
                      </p>
                      <p>
                        Última atualização: {codeResult.checklist.updated_at}
                      </p>
                    </div>
                  ) : mode === "code" && codeResult ? (
                    <div className="rounded-lg border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-3 text-[13px] text-[var(--ds-color-text-secondary)]">
                      <p>Código: {codeResult.code}</p>
                      <p>Documento: {codeResult.document?.id || "-"}</p>
                      <p>Módulo: {codeResult.document?.module || "-"}</p>
                      <p>Título: {codeResult.document?.title || "-"}</p>
                      <p>Data: {codeResult.document?.document_date || "-"}</p>
                    </div>
                  ) : null}

                  {mode === "evidence" && evidenceResult?.evidence ? (
                    <div className="rounded-lg border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-3 text-[13px] text-[var(--ds-color-text-secondary)]">
                      <p>APR: {evidenceResult.evidence.apr_numero || "-"}</p>
                      <p>Versão: {evidenceResult.evidence.apr_versao ?? "-"}</p>
                      <p>
                        Item de risco:{" "}
                        {typeof evidenceResult.evidence.risk_item_ordem ===
                        "number"
                          ? `#${evidenceResult.evidence.risk_item_ordem + 1}`
                          : "-"}
                      </p>
                      <p>
                        Upload: {evidenceResult.evidence.uploaded_at || "-"}
                      </p>
                      <p>Tipo de hash: {evidenceResult.matchedIn || "-"}</p>
                    </div>
                  ) : null}

                  {mode === "signature" && signatureResult?.signature ? (
                    <div className="rounded-lg border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] p-3 text-[13px] text-[var(--ds-color-text-secondary)]">
                      <p>
                        Documento:{" "}
                        {signatureResult.signature.document_type || "-"}
                      </p>
                      <p>
                        ID do documento:{" "}
                        {signatureResult.signature.document_id || "-"}
                      </p>
                      <p>
                        Tipo de assinatura:{" "}
                        {signatureResult.signature.type
                          ? (SIGNATURE_TYPE_LABEL[
                              signatureResult.signature.type
                            ] ?? signatureResult.signature.type)
                          : "-"}
                      </p>
                      <p>
                        Assinado em:{" "}
                        {signatureResult.signature.signed_at || "-"}
                      </p>
                      <p>
                        Autoridade:{" "}
                        {signatureResult.signature.timestamp_authority || "-"}
                      </p>
                      <p>
                        Modo de verificação:{" "}
                        {signatureResult.signature.verification_mode
                          ? (SIGNATURE_VERIFICATION_MODE_LABEL[
                              signatureResult.signature.verification_mode
                            ] ?? signatureResult.signature.verification_mode)
                          : "-"}
                      </p>
                      <p>
                        Escopo de prova:{" "}
                        {signatureResult.signature.proof_scope
                          ? (SIGNATURE_PROOF_SCOPE_LABEL[
                              signatureResult.signature.proof_scope
                            ] ?? signatureResult.signature.proof_scope)
                          : "-"}
                      </p>
                      <p>
                        Nível jurídico:{" "}
                        {signatureResult.signature.legal_assurance
                          ? (SIGNATURE_LEGAL_ASSURANCE_LABEL[
                              signatureResult.signature.legal_assurance
                            ] ?? signatureResult.signature.legal_assurance)
                          : "-"}
                      </p>
                      <p>Hash: {signatureResult.signature.hash}</p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex items-start gap-2 text-[var(--ds-color-warning)]">
                  <ShieldAlert className="mt-0.5 h-5 w-5" />
                  <p className="text-[13px] font-medium">
                    {mode === "evidence"
                      ? evidenceResult?.message || "Hash não localizado."
                      : mode === "signature"
                        ? signatureResult?.message ||
                          "Assinatura não localizada."
                        : codeResult?.message || "Documento não localizado."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        <p className="flex items-center gap-1 text-[11px] text-[var(--ds-color-text-muted)]">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Validação pública alinhada com os endpoints reais do backend.
        </p>
      </div>
    </main>
  );
}
