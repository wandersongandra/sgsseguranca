"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import {
  EmptyState,
} from "@/components/ui/state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/context/AuthContext";
import { signaturesService } from "@/services/signaturesService";
import { toast } from "sonner";
import { AprListingRow } from "./AprListingRow";
import { AprListingDensity, AprListingRecord } from "./aprListingUtils";

const SignatureModal = dynamic(
  () => import("@/components/SignatureModal").then((module) => module.SignatureModal),
  { ssr: false },
);
const SignaturesPanel = dynamic(
  () => import("@/components/SignaturesPanel").then((module) => module.SignaturesPanel),
  { ssr: false },
);

interface AprListingTableProps {
  aprs: AprListingRecord[];
  density: AprListingDensity;
  isFiltered: boolean;
  onDelete: (id: string) => void;
  onPrint: (apr: AprListingRecord) => void;
  onSendEmail: (id: string) => void;
  onDownloadPdf: (id: string) => void;
  onApprove: (id: string) => void;
  onFinalize: (id: string) => void;
  onReject: (id: string) => void;
  onCreateNewVersion: (id: string) => void;
  pendingActionById: Record<string, boolean>;
  onClearFilters: () => void;
  refetching?: boolean;
}

export function AprListingTable({
  aprs,
  density,
  isFiltered,
  onDelete,
  onPrint,
  onSendEmail,
  onDownloadPdf,
  onApprove,
  onFinalize,
  onReject,
  onCreateNewVersion,
  pendingActionById,
  onClearFilters,
  refetching = false,
}: AprListingTableProps) {
  const { user } = useAuth();
  const [signatureTarget, setSignatureTarget] = useState<AprListingRecord | null>(null);
  const [signaturesTarget, setSignaturesTarget] = useState<AprListingRecord | null>(null);

  if (aprs.length === 0) {
    return (
      <div className="p-5">
        <EmptyState
          title="Nenhuma APR encontrada"
          description={
            isFiltered
              ? "Não há resultados para os filtros aplicados nesta fila operacional."
              : "Ainda não existem APRs registradas para este tenant."
          }
          action={
            isFiltered ? (
              <Button type="button" variant="outline" size="sm" onClick={onClearFilters}>
                Limpar filtros
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const handleSignSave = async (signatureData: string, type: string) => {
    if (!signatureTarget) return;

    try {
      await signaturesService.create({
        document_id: signatureTarget.id,
        document_type: "APR",
        signature_data: signatureData,
        type,
        user_id: user?.id,
      });
      toast.success("Assinatura registrada com sucesso.");
      setSignatureTarget(null);
    } catch {
      toast.error("Erro ao registrar assinatura.");
    }
  };

  return (
    <>
      <Table className="min-w-[1280px]" aria-label="APRs em tabela">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[280px]">APR</TableHead>
            <TableHead className="w-[150px]">Status</TableHead>
            <TableHead className="w-[210px]">Empresa</TableHead>
            <TableHead className="w-[210px]">Obra</TableHead>
            <TableHead className="w-[170px]">Data</TableHead>
            <TableHead className="w-[190px]">Responsável</TableHead>
            <TableHead className="w-[150px]">Assinaturas</TableHead>
            <TableHead className="w-[150px]">PDF</TableHead>
            <TableHead className="w-[120px] text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        {refetching ? (
          <TableBody aria-busy="true" aria-label="Atualizando lista de APRs">
            {Array.from({ length: Math.min(aprs.length, 6) }).map((_, i) => (
              <tr key={`skel-${i}`} className="animate-pulse border-b border-[var(--ds-color-border-subtle)]">
                {Array.from({ length: 9 }).map((__, j) => (
                  <td key={j} className="px-4 py-3">
                    <div className="h-4 rounded-[var(--ds-radius-sm)] bg-[color:var(--ds-color-surface-muted)]" />
                  </td>
                ))}
              </tr>
            ))}
          </TableBody>
        ) : (
          <TableBody>
            {aprs.map((apr) => (
              <AprListingRow
                key={apr.id}
                apr={apr}
                density={density}
                onDelete={onDelete}
                onPrint={onPrint}
                onSendEmail={onSendEmail}
                onDownloadPdf={onDownloadPdf}
                onApprove={onApprove}
                onFinalize={onFinalize}
                onReject={onReject}
                onCreateNewVersion={onCreateNewVersion}
                isPending={Boolean(pendingActionById[apr.id])}
                onOpenSignature={setSignatureTarget}
                onOpenSignatures={setSignaturesTarget}
              />
            ))}
          </TableBody>
        )}
      </Table>

      <SignatureModal
        isOpen={Boolean(signatureTarget)}
        onClose={() => setSignatureTarget(null)}
        onSave={handleSignSave}
        userName={user?.nome ?? "Usuário"}
      />

      <SignaturesPanel
        isOpen={Boolean(signaturesTarget)}
        onClose={() => setSignaturesTarget(null)}
        documentId={signaturesTarget?.id ?? ""}
        documentType="APR"
      />
    </>
  );
}

