"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
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
      <InlineLoadingState label="Carregando não conformidade" />
    ),
  },
);

export default function EditNonConformityPage() {
  const params = useParams();
  const id = params?.id as string;

  return (
    <div className="ds-form-page space-y-5">
      <PageHeader
        eyebrow="Não conformidades"
        title="Editar não conformidade"
        description="Atualize a tratativa, o nível de risco e as evidências do registro."
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
      <NonConformityForm id={id} />
    </div>
  );
}
