"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import {
  PublicOnboardingInvite,
  tenantLifecycleService,
} from "@/services/tenantLifecycleService";
import { Button } from "@/components/ui/button";
import { InlineLoadingState } from "@/components/ui/state";

type FormState = {
  razao_social: string;
  cnpj: string;
  endereco: string;
  responsavel: string;
  email_contato: string;
  admin_nome: string;
  admin_cpf: string;
  admin_email: string;
  admin_password: string;
  termsAccepted: boolean;
};

type ApiValidationError = {
  field?: string;
  errors?: string[];
};

type ApiErrorPayload = {
  message?: string | string[];
  error?: string;
  errors?: ApiValidationError[];
};

const initialState: FormState = {
  razao_social: "",
  cnpj: "",
  endereco: "",
  responsavel: "",
  email_contato: "",
  admin_nome: "",
  admin_cpf: "",
  admin_email: "",
  admin_password: "",
  termsAccepted: false,
};

const fieldClassName =
  "w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]";

function extractApiErrorMessage(err: unknown): string {
  if (!err || typeof err !== "object" || !("response" in err)) {
    return "";
  }

  const payload = (err as { response?: { data?: ApiErrorPayload } }).response
    ?.data;
  if (!payload) {
    return "";
  }

  const validationMessages = Array.isArray(payload.errors)
    ? payload.errors
      .flatMap((item) =>
        Array.isArray(item.errors)
          ? item.errors.map((message) =>
            item.field ? `${item.field}: ${message}` : message,
          )
          : [],
      )
      .filter(Boolean)
    : [];
  if (validationMessages.length > 0) {
    return validationMessages.join(" ");
  }

  if (Array.isArray(payload.message)) {
    return payload.message.join(" ");
  }

  return payload.message || payload.error || "";
}

export default function OnboardingPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;
  const [invite, setInvite] = useState<PublicOnboardingInvite | null>(null);
  const [form, setForm] = useState<FormState>(initialState);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedTrialEndsAt, setCompletedTrialEndsAt] = useState<
    string | null
  >(null);

  useEffect(() => {
    let mounted = true;
    tenantLifecycleService
      .getInvite(token)
      .then((data) => {
        if (!mounted) return;
        setInvite(data);
        setForm((current) => ({
          ...current,
          razao_social: data.intended_company_name || "",
          email_contato: data.email,
          admin_email: data.email,
        }));
      })
      .catch(() => {
        if (mounted) setError("Convite inválido ou expirado.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [token]);

  function updateField(name: keyof FormState, value: string | boolean) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await tenantLifecycleService.completeOnboarding(token, {
        ...form,
        termsAccepted: form.termsAccepted,
      });
      setCompletedTrialEndsAt(result.trial_ends_at);
    } catch (err) {
      const message = extractApiErrorMessage(err);
      setError(message || "Não foi possível concluir o cadastro.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[var(--ds-color-surface-muted)] px-4 py-10">
        <div className="mx-auto max-w-3xl rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6">
          <InlineLoadingState label="Validando convite" />
        </div>
      </main>
    );
  }

  if (completedTrialEndsAt) {
    return (
      <main className="min-h-screen bg-[var(--ds-color-surface-muted)] px-4 py-10">
        <section className="mx-auto max-w-2xl rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-8 shadow-[var(--ds-shadow-sm)]">
          <CheckCircle2 className="h-10 w-10 text-[var(--ds-color-success)]" />
          <h1 className="mt-5 text-2xl font-semibold text-[var(--ds-color-text-primary)]">
            Empresa cadastrada
          </h1>
          <p className="mt-3 text-sm text-[var(--ds-color-text-secondary)]">
            O teste de 30 dias foi ativado. Vencimento:{" "}
            {new Date(completedTrialEndsAt).toLocaleDateString("pt-BR")}.
          </p>
          <Button
            type="button"
            className="mt-6"
            onClick={() => router.push("/login")}
          >
            Ir para login
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--ds-color-surface-muted)] px-4 py-8">
      <section className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
              SGS Segurança
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-[var(--ds-color-text-primary)]">
              Cadastro da empresa
            </h1>
          </div>
          <div className="flex items-center gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm text-[var(--ds-color-text-secondary)]">
            <ShieldCheck className="h-4 w-4" />
            30 dias de teste
          </div>
        </div>

        {error ? (
          <div className="mb-5 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-danger-border)] bg-[var(--ds-color-danger-subtle)] px-4 py-3 text-sm text-[var(--ds-color-danger)]">
            {error}
          </div>
        ) : null}

        {invite ? (
          <form
            onSubmit={onSubmit}
            className="grid gap-5 rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)] md:grid-cols-2"
          >
            <Input
              label="Razão social"
              value={form.razao_social}
              onChange={(value) => updateField("razao_social", value)}
              required
            />
            <Input
              label="CNPJ"
              value={form.cnpj}
              onChange={(value) => updateField("cnpj", value)}
              required
            />
            <Input
              label="Endereço"
              value={form.endereco}
              onChange={(value) => updateField("endereco", value)}
              required
              wide
            />
            <Input
              label="Responsável"
              value={form.responsavel}
              onChange={(value) => updateField("responsavel", value)}
              required
            />
            <Input
              label="E-mail institucional"
              type="email"
              value={form.email_contato}
              onChange={(value) => updateField("email_contato", value)}
              required
            />
            <Input
              label="Nome do administrador"
              value={form.admin_nome}
              onChange={(value) => updateField("admin_nome", value)}
              required
            />
            <Input
              label="CPF do administrador"
              value={form.admin_cpf}
              onChange={(value) => updateField("admin_cpf", value)}
              required
            />
            <Input
              label="E-mail do administrador"
              type="email"
              value={form.admin_email}
              onChange={(value) => updateField("admin_email", value)}
              required
            />
            <Input
              label="Senha inicial"
              type="password"
              value={form.admin_password}
              onChange={(value) => updateField("admin_password", value)}
              required
            />
            <label className="flex items-start gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] p-3 text-sm text-[var(--ds-color-text-secondary)] md:col-span-2">
              <input
                type="checkbox"
                checked={form.termsAccepted}
                onChange={(event) =>
                  updateField("termsAccepted", event.target.checked)
                }
                className="mt-1 h-4 w-4 accent-[var(--ds-color-action-primary)]"
                required
              />
              <span>
                Confirmo que estou autorizado a cadastrar esta empresa e aceito
                iniciar o teste de 30 dias no SGS.
              </span>
            </label>
            <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-color-border-subtle)] pt-5 md:col-span-2">
              <Link
                href="/login"
                className="text-sm text-[var(--ds-color-text-secondary)]"
              >
                Já tenho acesso
              </Link>
              <Button
                type="submit"
                disabled={submitting || !form.termsAccepted}
              >
                {submitting ? "Cadastrando..." : "Ativar teste"}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </main>
  );
}

function Input(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  wide?: boolean;
}) {
  return (
    <label className={props.wide ? "space-y-2 md:col-span-2" : "space-y-2"}>
      <span className="text-sm font-medium text-[var(--ds-color-text-secondary)]">
        {props.label}
      </span>
      <input
        className={fieldClassName}
        type={props.type || "text"}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        required={props.required}
      />
    </label>
  );
}
