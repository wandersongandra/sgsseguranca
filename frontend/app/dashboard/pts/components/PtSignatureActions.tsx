'use client';

import dynamic from 'next/dynamic';
import { useRef, useState } from 'react';
import { PenLine, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { Permission } from '@/lib/permissions';
import { ptsService } from '@/services/ptsService';
import { toast } from 'sonner';

const SignatureModal = dynamic(
  () => import('@/components/SignatureModal').then((module) => module.SignatureModal),
  { ssr: false },
);
const SignaturesPanel = dynamic(
  () => import('@/components/SignaturesPanel').then((module) => module.SignaturesPanel),
  { ssr: false },
);

type Props = {
  ptId: string;
  buttonClassName?: string;
  iconOnly?: boolean;
  onSignatureSaved: () => void;
};

export function PtSignatureActions({
  ptId,
  buttonClassName,
  iconOnly = false,
  onSignatureSaved,
}: Props) {
  const { user, hasPermission } = useAuth();
  const [showSignModal, setShowSignModal] = useState(false);
  const [showSignaturesPanel, setShowSignaturesPanel] = useState(false);
  const signatureSaveLockRef = useRef(false);
  const canSign = hasPermission(Permission.CAN_MANAGE_SIGNATURES);
  const canView = hasPermission(Permission.CAN_VIEW_SIGNATURES);

  const handleSave = async (signatureData: string, type: string) => {
    if (signatureSaveLockRef.current) return;
    signatureSaveLockRef.current = true;
    try {
      await ptsService.createSignature(ptId, {
        signature_data: signatureData,
        type,
      });
      setShowSignModal(false);
      onSignatureSaved();
      toast.success('Assinatura registrada com sucesso.');
    } catch {
      toast.error('Erro ao registrar assinatura.');
    } finally {
      signatureSaveLockRef.current = false;
    }
  };

  return (
    <>
      {canSign ? (
        <Button
          type="button"
          size={iconOnly ? 'icon' : undefined}
          variant={iconOnly ? 'ghost' : 'outline'}
          className={buttonClassName}
          onClick={() => setShowSignModal(true)}
          title="Assinar PT"
          aria-label={iconOnly ? 'Assinar PT' : undefined}
        >
          <PenLine className="h-4 w-4" />
          {iconOnly ? null : 'Assinar PT'}
        </Button>
      ) : null}
      {canView ? (
        <Button
          type="button"
          size={iconOnly ? 'icon' : undefined}
          variant={iconOnly ? 'ghost' : 'outline'}
          className={buttonClassName}
          onClick={() => setShowSignaturesPanel(true)}
          title="Ver assinaturas"
          aria-label={iconOnly ? 'Ver assinaturas' : undefined}
        >
          <Users className="h-4 w-4" />
          {iconOnly ? null : 'Ver assinaturas'}
        </Button>
      ) : null}
      <SignatureModal
        isOpen={showSignModal}
        onClose={() => setShowSignModal(false)}
        onSave={handleSave}
        userName={user?.nome ?? 'Usuário'}
      />
      <SignaturesPanel
        isOpen={showSignaturesPanel}
        onClose={() => setShowSignaturesPanel(false)}
        documentId={ptId}
        documentType="PT"
      />
    </>
  );
}
