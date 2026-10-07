"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/PageHeader";
import { InlineLoadingState } from "@/components/ui/state";
import { cn } from "@/lib/utils";

const NonConformityForm = dynamic(
  () =>
    import("@/components/NonConformityForm").then(
      (module) => module.NonConformityForm,
    ),
  {
    ssr: false,
    loading: () => (
      <InlineLoadingState label="Carregando formulário de não conformidade" />
    ),
  },
);

export default function NewNonConformityPage() {
  return (
    <div className="ds-form-page space-y-5">
      <PageHeader
        eyebrow="Não conformidades"
        title="Nova não conformidade"
        description="Registre o desvio, classifique o risco e defina as ações de correção."
        icon={<AlertTriangle className="h-5 w-5" />}
        actions={
          <Link
            href="/dashboard/nonconformities"
            className={cn(
              buttonVariants({ variant: "secondary" }),
              "inline-flex items-center",
            )}
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Link>
        }
      />
      <NonConformityForm />
    </div>
  );
}
