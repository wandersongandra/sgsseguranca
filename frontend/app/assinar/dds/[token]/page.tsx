"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Script from "next/script";
import {
  CheckCircle2,
  Eraser,
  FileText,
  PenLine,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import SignatureCanvas from "react-signature-canvas";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InlineLoadingState } from "@/components/ui/state";
import {
  PublicDdsSignatureContext,
  publicDdsSignatureService,
} from "@/services/publicDdsSignatureService";
import { logger } from "@/lib/logger";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: Record<string, unknown>,
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("pt-BR");
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("pt-BR");
}

const SESSION_KEY = 'dds_signature_token';

function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function setSessionToken(token: string) {
  try {
    sessionStorage.setItem(SESSION_KEY, token);
  } catch {
    // sessionStorage indisponível (ex: modo privado) — falha silenciosa
  }
}

function clearSessionToken() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // silent
  }
}

export default function PublicDdsSignaturePage() {
  const params = useParams<{ token: string }>();
  const urlToken = decodeURIComponent(params.token || "");
  const [resolvedToken, setResolvedToken] = useState<string | null>(null);
  const signatureRef = useRef<SignatureCanvas>(null);
  const [context, setContext] = useState<PublicDdsSignatureContext | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [signatureMode, setSignatureMode] = useState<"draw" | "type">("draw");
  const [typedName, setTypedName] = useState("");
  const [signatureStatus, setSignatureStatus] = useState("Nenhuma assinatura informada.");
  const [error, setError] = useState<string | null>(null);
  const [signedAt, setSignedAt] = useState<string | null>(null);

  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || '';
  const turnstileEnabled = turnstileSiteKey.length > 0;
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileScriptReady, setTurnstileScriptReady] = useState(false);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      !turnstileEnabled ||
      !turnstileScriptReady ||
      !turnstileContainerRef.current ||
      !window.turnstile ||
      turnstileWidgetIdRef.current
    ) {
      return;
    }

    turnstileWidgetIdRef.current = window.turnstile.render(
      turnstileContainerRef.current,
      {
        sitekey: turnstileSiteKey,
        action: 'dds-signing',
        callback: (token: string) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken(''),
      },
    );

    return () => {
      if (turnstileWidgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(turnstileWidgetIdRef.current);
      }
      turnstileWidgetIdRef.current = null;
      setTurnstileToken('');
    };
  }, [turnstileEnabled, turnstileScriptReady, turnstileSiteKey]);

  const resetTurnstile = () => {
    if (turnstileWidgetIdRef.current && window.turnstile?.reset) {
      window.turnstile.reset(turnstileWidgetIdRef.current);
    }
    setTurnstileToken('');
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const sessionToken = getSessionToken();
    const effectiveToken = sessionToken || urlToken;

    if (!effectiveToken) {
      setError("Link de assinatura inválido.");
      setLoading(false);
      return;
    }

    setResolvedToken(effectiveToken);

    if (!sessionToken && urlToken) {
      setSessionToken(urlToken);
    }

    publicDdsSignatureService
      .getContext(effectiveToken)
      .then((data) => {
        if (!active) return;
        setContext(data);
        setSignedAt(data.signedAt);
        if (urlToken && window.history.replaceState) {
          window.history.replaceState(null, "", "/assinar/dds");
        }
      })
      .catch((err) => {
        if (!active) return;
        clearSessionToken();
        setError(
          err instanceof Error
            ? err.message
            : "Link de assinatura inválido ou expirado.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [urlToken]);

  const resizeSignatureCanvas = useCallback(() => {
    const signature = signatureRef.current;
    if (!signature || signatureMode !== "draw") return;
    const canvas = signature.getCanvas();
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;

    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const nextWidth = Math.round(bounds.width * ratio);
    const nextHeight = Math.round(bounds.height * ratio);
    if (canvas.width === nextWidth && canvas.height === nextHeight) return;

    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext("2d")?.drawImage(canvas, 0, 0);
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    const context2d = canvas.getContext("2d");
    context2d?.scale(ratio, ratio);
    if (copy.width && copy.height) {
      context2d?.drawImage(
        copy,
        0,
        0,
        copy.width,
        copy.height,
        0,
        0,
        bounds.width,
        bounds.height,
      );
    }
  }, [signatureMode]);

  useEffect(() => {
    if (!context || signedAt || context.status === "signed" || signatureMode !== "draw") return;
    resizeSignatureCanvas();
    window.addEventListener("resize", resizeSignatureCanvas);
    window.addEventListener("orientationchange", resizeSignatureCanvas);
    return () => {
      window.removeEventListener("resize", resizeSignatureCanvas);
      window.removeEventListener("orientationchange", resizeSignatureCanvas);
    };
  }, [context, resizeSignatureCanvas, signatureMode, signedAt]);

  function clearSignature() {
    signatureRef.current?.clear();
    setSignatureStatus("Assinatura desenhada limpa.");
  }

  function getSignatureDataUrl() {
    if (signatureMode === "type") {
      const normalizedName = typedName.trim();
      if (!normalizedName) return "";
      const canvas = document.createElement("canvas");
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = Math.round(720 * ratio);
      canvas.height = Math.round(180 * ratio);
      const context2d = canvas.getContext("2d");
      if (!context2d) return "";
      context2d.scale(ratio, ratio);
      context2d.fillStyle = "#ffffff";
      context2d.fillRect(0, 0, 720, 180);
      context2d.fillStyle = "#172033";
      context2d.font = "italic 48px serif";
      context2d.textAlign = "center";
      context2d.textBaseline = "middle";
      context2d.fillText(normalizedName, 360, 82, 660);
      context2d.font = "16px sans-serif";
      context2d.fillText("Assinatura digitada com consentimento eletrônico", 360, 142);
      return canvas.toDataURL("image/png");
    }

    const signatureCanvas = signatureRef.current;
    if (!signatureCanvas) return "";

    try {
      if (typeof signatureCanvas.getTrimmedCanvas === "function") {
        const trimmedCanvas = signatureCanvas.getTrimmedCanvas();
        if (trimmedCanvas && typeof trimmedCanvas.toDataURL === "function") {
          return trimmedCanvas.toDataURL("image/png");
        }
      }
    } catch (error) {
      logger.warn("Falha ao recortar assinatura (getTrimmedCanvas), usando fallback:", error);
    }

    try {
      if (typeof signatureCanvas.toDataURL === "function") {
        return signatureCanvas.toDataURL("image/png");
      }
    } catch (error) {
      logger.error("Falha ao gerar assinatura via toDataURL:", error);
    }

    return "";
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acceptedTerms) {
      toast.error("Confirme a ciência antes de assinar.");
      return;
    }
    if (
      signatureMode === "draw" &&
      (!signatureRef.current || signatureRef.current.isEmpty())
    ) {
      toast.error("Faça sua assinatura no quadro indicado.");
      return;
    }
    if (signatureMode === "type" && !typedName.trim()) {
      toast.error("Informe seu nome completo para a assinatura digitada.");
      return;
    }

    if (turnstileEnabled && !turnstileToken) {
      toast.error("Conclua a verificação de segurança antes de assinar.");
      return;
    }

    const signatureData = getSignatureDataUrl();
    if (!signatureData) {
      toast.error("Não foi possível capturar a assinatura.");
      return;
    }

    const submitToken = resolvedToken || getSessionToken() || urlToken;
    if (!submitToken) {
      toast.error("Token de assinatura não encontrado. Recarregue a página.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await publicDdsSignatureService.submit(submitToken, {
        accepted_terms: acceptedTerms,
        signature_data: signatureData,
        turnstileToken: turnstileToken || undefined,
      });
      setSignedAt(result.signedAt || new Date().toISOString());
      clearSessionToken();
      toast.success("Assinatura registrada com segurança.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Não foi possível registrar a assinatura.",
      );
      resetTurnstile();
    } finally {
      setSubmitting(false);
    }
  }

  function getBodyNonce(): string | undefined {
    if (typeof document === 'undefined') return undefined;
    return document.body?.getAttribute('data-nonce') || undefined;
  }

  const nonce = getBodyNonce();

  return (
    <main className="min-h-screen bg-[var(--ds-color-bg-subtle)] px-4 py-8">
      {turnstileEnabled && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          nonce={nonce}
          strategy="afterInteractive"
          onLoad={() => setTurnstileScriptReady(true)}
        />
      )}
      <section className="mx-auto max-w-3xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              SGS Segurança
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-[var(--ds-color-text-primary)]">
              Assinatura de DDS
            </h1>
          </div>
          <div className="flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-secondary)]">
            <ShieldCheck className="h-4 w-4" />
            Link protegido
          </div>
        </div>

        {loading ? (
          <Card>
            <CardContent className="py-6">
              <InlineLoadingState label="Validando link de assinatura" />
            </CardContent>
          </Card>
        ) : error ? (
          <Card>
            <CardContent role="alert" className="flex items-start gap-3 py-6 text-sm text-[var(--ds-color-danger)]">
              <ShieldAlert className="mt-0.5 h-5 w-5" />
              <div>
                <p className="font-medium">{error}</p>
                <p className="mt-1 text-[var(--ds-color-text-secondary)]">
                  Solicite um novo link ao responsável pelo DDS.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : context ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4 text-[var(--ds-color-action-primary)]" />
                  {context.dds.tema}
                </CardTitle>
                <CardDescription>
                  Revise os dados mínimos antes de assinar.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm text-[var(--ds-color-text-secondary)] md:grid-cols-2">
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">
                    Empresa:
                  </strong>{" "}
                  {context.dds.companyName || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">
                    Obra:
                  </strong>{" "}
                  {context.dds.siteName || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">
                    Data:
                  </strong>{" "}
                  {formatDate(context.dds.data)}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">
                    Facilitador:
                  </strong>{" "}
                  {context.dds.facilitatorName || "-"}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">
                    Assinante:
                  </strong>{" "}
                  {context.signer.name}
                  {context.signer.role ? ` - ${context.signer.role}` : ""}
                </p>
                <p>
                  <strong className="text-[var(--ds-color-text-primary)]">
                    Expira em:
                  </strong>{" "}
                  {formatDateTime(context.expiresAt)}
                </p>
              </CardContent>
            </Card>

            {signedAt || context.status === "signed" ? (
              <Card>
                <CardContent className="flex items-start gap-3 py-6 text-sm text-[var(--ds-color-success)]">
                  <CheckCircle2 className="mt-0.5 h-5 w-5" />
                  <div>
                    <p className="font-medium">Assinatura registrada.</p>
                    <p className="mt-1 text-[var(--ds-color-text-secondary)]">
                      Data/hora: {formatDateTime(signedAt || context.signedAt)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <form onSubmit={onSubmit} className="space-y-5">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <PenLine className="h-4 w-4 text-[var(--ds-color-action-primary)]" />
                      Informe sua assinatura
                    </CardTitle>
                    <CardDescription>
                      Escolha desenhar com o dedo ou mouse, ou digitar seu nome
                      completo. As duas opções têm o mesmo valor neste registro.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <fieldset className="space-y-3">
                      <legend className="text-sm font-medium text-[var(--ds-color-text-primary)]">
                        Forma de assinatura
                      </legend>
                      <div className="flex flex-wrap gap-4">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="signature-mode"
                            value="draw"
                            checked={signatureMode === "draw"}
                            onChange={() => {
                              setSignatureMode("draw");
                              setSignatureStatus("Modo de assinatura desenhada selecionado.");
                            }}
                          />
                          Desenhar assinatura
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="signature-mode"
                            value="type"
                            checked={signatureMode === "type"}
                            onChange={() => {
                              setSignatureMode("type");
                              setSignatureStatus("Modo de assinatura digitada selecionado.");
                            }}
                          />
                          Digitar nome completo
                        </label>
                      </div>
                    </fieldset>

                    {signatureMode === "draw" ? (
                      <div>
                        <p id="signature-canvas-instructions" className="mb-2 text-sm text-[var(--ds-color-text-secondary)]">
                          Desenhe dentro do quadro. Se não puder usar um dispositivo
                          apontador, selecione “Digitar nome completo”.
                        </p>
                        <div className="h-56 overflow-hidden rounded-[var(--ds-radius-lg)] border-2 border-dashed border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)]">
                          <SignatureCanvas
                            ref={signatureRef}
                            clearOnResize={false}
                            onEnd={() => setSignatureStatus("Assinatura desenhada informada.")}
                            penColor="var(--ds-color-action-primary)"
                            canvasProps={{
                              className: "h-full w-full cursor-crosshair",
                              "aria-label": "Quadro para desenhar assinatura",
                              "aria-describedby": "signature-canvas-instructions",
                            }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <label htmlFor="typed-signature-name" className="block text-sm font-medium text-[var(--ds-color-text-primary)]">
                          Nome completo do assinante
                        </label>
                        <input
                          id="typed-signature-name"
                          type="text"
                          autoComplete="name"
                          value={typedName}
                          onChange={(event) => {
                            setTypedName(event.target.value);
                            setSignatureStatus(
                              event.target.value.trim()
                                ? "Nome para assinatura digitada informado."
                                : "Nenhuma assinatura informada.",
                            );
                          }}
                          aria-describedby="typed-signature-help"
                          className="w-full rounded-lg border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-[var(--ds-color-text-primary)]"
                        />
                        <p id="typed-signature-help" className="text-sm text-[var(--ds-color-text-secondary)]">
                          Digite seu nome completo. Ao confirmar a ciência abaixo,
                          uma imagem da assinatura será gerada para o registro do DDS.
                        </p>
                      </div>
                    )}
                    <p role="status" aria-live="polite" className="sr-only">
                      {signatureStatus}
                    </p>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <label className="flex max-w-xl items-start gap-3 text-sm text-[var(--ds-color-text-secondary)]">
                        <input
                          type="checkbox"
                          checked={acceptedTerms}
                          onChange={(event) =>
                            setAcceptedTerms(event.target.checked)
                          }
                          disabled={turnstileEnabled && !turnstileToken}
                          className="mt-1 h-4 w-4 accent-[var(--ds-color-action-primary)]"
                        />
                        <span>
                          Confirmo que participei do DDS informado, reconheço o
                          conteúdo apresentado e autorizo o registro desta
                          assinatura eletrônica no SGS.
                        </span>
                      </label>
                      {signatureMode === "draw" ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={clearSignature}
                          leftIcon={<Eraser className="h-4 w-4" />}
                        >
                          Limpar assinatura desenhada
                        </Button>
                      ) : null}
                    </div>

                    {turnstileEnabled ? (
                      <div className="flex justify-center pt-2">
                        <div ref={turnstileContainerRef} />
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={submitting || !acceptedTerms || (turnstileEnabled && !turnstileToken)}
                    leftIcon={<ShieldCheck className="h-4 w-4" />}
                  >
                    {submitting ? "Registrando..." : "Confirmar assinatura"}
                  </Button>
                </div>
              </form>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
