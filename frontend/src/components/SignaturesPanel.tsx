'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { Loader2, ShieldCheck, PenTool, Upload, Camera } from 'lucide-react';
import { signaturesService, Signature } from '@/services/signaturesService';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { StatusPill } from './ui/status-pill';
import { safeToLocaleString } from '@/lib/date/safeFormat';
import {
  ModalBody,
  ModalFooter,
  ModalFrame,
  ModalHeader,
} from './ui/modal-frame';

const TYPE_LABEL: Record<string, string> = {
  digital: 'Digital (Desenho)',
  upload: 'Imagem Enviada',
  facial: 'Facial',
  hmac: 'PIN Seguro (HMAC-SHA256)',
};

const VERIFICATION_MODE_LABEL: Record<string, string> = {
  server_verifiable: 'Verificável server-side',
  operational_ack: 'Aceite operacional',
  legacy_client_hash: 'Legado',
};

const PROOF_SCOPE_LABEL: Record<string, string> = {
  governed_final_document: 'Vinculada ao documento final governado',
  document_revision: 'Vinculada à revisão do documento',
  document_identity: 'Vinculada à identidade do documento',
  operational_snapshot: 'Vinculada a snapshot operacional',
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  digital: <PenTool className="h-3.5 w-3.5" />,
  upload: <Upload className="h-3.5 w-3.5" />,
  facial: <Camera className="h-3.5 w-3.5" />,
  hmac: <ShieldCheck className="h-3.5 w-3.5" />,
};

interface SignaturesPanelProps {
  isOpen: boolean;
  onClose: () => void;
  documentId: string;
  documentType: string;
}

export function SignaturesPanel({ isOpen, onClose, documentId, documentType }: SignaturesPanelProps) {
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    signaturesService
      .findByDocument(documentId, documentType)
      .then(setSignatures)
      .catch(() => toast.error('Erro ao carregar assinaturas'))
      .finally(() => setLoading(false));
  }, [isOpen, documentId, documentType]);

  if (!isOpen) return null;

  // Tipos canônicos (drawn/upload) + legados que também guardam imagem.
  const isImageType = (type: string) =>
    ['drawn', 'upload', 'digital', 'facial'].includes(type);

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} shellClassName="max-w-lg" overlayClassName="z-[60]">
      <ModalHeader
        title="Assinaturas do documento"
        description={`${documentType} — ${signatures.length} assinatura(s)`}
        icon={<PenTool className="h-5 w-5" />}
        onClose={onClose}
      />

      <ModalBody className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10 text-[var(--ds-color-text-muted)]">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : signatures.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center text-[var(--ds-color-text-muted)]">
              <PenTool className="mb-3 h-12 w-12 opacity-30" />
              <p className="text-sm font-medium">Nenhuma assinatura registrada.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {signatures.map((sig) => {
                const verificationMode =
                  sig.integrity_payload?.verification_mode ||
                  (sig.signature_hash ? 'legacy_client_hash' : null);
                const proofScope = sig.integrity_payload?.proof_scope || null;

                return (
                <div key={sig.id} className="flex items-start gap-4 rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-elevated)] p-4">
                  {/* Miniature for image-based signatures */}
                  {isImageType(sig.type) && sig.signature_data && (
                    <div className="relative h-16 w-24 flex-shrink-0 overflow-hidden rounded-lg border border-[var(--ds-color-border-subtle)] bg-white">
                      <Image
                        src={sig.signature_data}
                        alt="Assinatura"
                        fill
                        sizes="96px"
                        className="object-contain p-1"
                      />
                    </div>
                  )}
                  {sig.type === 'hmac' && (
                    <div className="flex h-16 w-24 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-primary-subtle)]">
                      <ShieldCheck className="h-8 w-8 text-[var(--ds-color-action-primary)]" />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusPill tone="primary">
                        {TYPE_ICON[sig.type] ?? <PenTool className="h-3.5 w-3.5" />}
                        {TYPE_LABEL[sig.type] ?? sig.type}
                      </StatusPill>
                      {sig.signature_hash && verificationMode && (
                        <StatusPill tone="success">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {VERIFICATION_MODE_LABEL[verificationMode] ?? verificationMode}
                        </StatusPill>
                      )}
                    </div>

                    <p className="mt-1 text-xs text-[var(--ds-color-text-muted)]">
                      {sig.signed_at
                        ? safeToLocaleString(sig.signed_at, 'pt-BR', undefined, 'Data não disponível')
                        : sig.created_at
                          ? safeToLocaleString(sig.created_at, 'pt-BR', undefined, 'Data não disponível')
                          : 'Data não disponível'}
                    </p>
                    {proofScope ? (
                      <p className="mt-1 text-[11px] text-[var(--ds-color-text-muted)]">
                        {PROOF_SCOPE_LABEL[proofScope] ?? proofScope}
                      </p>
                    ) : null}
                  </div>
                </div>
                );
              })}
            </div>
          )}
      </ModalBody>

      <ModalFooter>
        <Button
          type="button"
          onClick={onClose}
          variant="outline"
        >
          Fechar
        </Button>
      </ModalFooter>
    </ModalFrame>
  );
}
