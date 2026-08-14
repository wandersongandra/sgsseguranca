'use client';

import React, { useState } from 'react';
import { Mail, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  DocumentMailDispatchResponse,
  extractMailDispatchErrorMessage,
} from '@/services/mailService';
import { logger } from '@/lib/logger';
import {
  ModalBody,
  ModalFooter,
  ModalFrame,
  ModalHeader,
} from './ui/modal-frame';

interface DocumentEmailModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentName: string;
  onSend: (email: string) => Promise<DocumentMailDispatchResponse | void>;
}

export function DocumentEmailModal({
  isOpen,
  onClose,
  documentName,
  onSend,
}: DocumentEmailModalProps) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error('Por favor, insira um e-mail válido.');
      return;
    }

    try {
      setSending(true);
      const result = await onSend(email);
      const message =
        result?.message ||
        'Solicitação recebida. O documento será enviado por e-mail em instantes.';

      if (result?.deliveryMode === 'queued') {
        toast.info(message);
      } else {
        toast.success(message);
      }
      onClose();
      setEmail('');
    } catch (error) {
      logger.error('Erro ao enviar e-mail:', error);
      toast.error(await extractMailDispatchErrorMessage(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} shellClassName="max-w-md">
      <form onSubmit={handleSend}>
        <ModalHeader
          title="Enviar documento"
          description="O envio usará o PDF final governado emitido para este documento."
          icon={<Mail className="h-5 w-5" />}
          onClose={onClose}
        />
        <ModalBody className="space-y-5">
          <div>
            <p className="text-sm text-[var(--ds-color-text-secondary)]">
              O documento{' '}
              <span className="font-semibold text-[var(--ds-color-text-primary)]">
                {documentName}
              </span>{' '}
              será enviado para o e-mail abaixo com o PDF final governado anexado.
            </p>

            <label htmlFor="email" className="mb-2 mt-4 block">
              E-mail de Destino
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="exemplo@email.com"
              autoFocus
              required
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex w-full gap-3 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="flex-1 sm:flex-none"
              disabled={sending}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              className="flex-1 gap-2 sm:flex-none"
              loading={sending}
              disabled={sending}
            >
              <Send className="h-4 w-4" />
              Enviar
            </Button>
          </div>
        </ModalFooter>
      </form>
    </ModalFrame>
  );
}
