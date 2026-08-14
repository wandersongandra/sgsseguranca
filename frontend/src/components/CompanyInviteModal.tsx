'use client';

import { useState } from 'react';
import { Mail, Send, Loader2, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ModalBody, ModalFooter, ModalFrame, ModalHeader } from './ui/modal-frame';
import { tenantLifecycleService } from '@/services/tenantLifecycleService';
import { extractApiErrorMessage } from '@/lib/error-handler';
import { logger } from '@/lib/logger';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function CompanyInviteModal({ isOpen, onClose }: Props) {
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error('Informe o e-mail do destinatário.');
      return;
    }

    try {
      setLoading(true);
      const result = await tenantLifecycleService.createInvite({
        email: email.trim().toLowerCase(),
        intended_company_name: companyName.trim() || undefined,
      });

      toast.success(`Convite enviado com sucesso para ${email}!`);
      
      // Opcional: Copiar link para o clipboard também para facilitar
      if (result.onboarding_url) {
        try {
          await navigator.clipboard.writeText(result.onboarding_url);
          toast.info('Link de cadastro também copiado para sua área de transferência.');
        } catch {
          // Fallback silencioso se clipboard falhar
        }
      }

      setEmail('');
      setCompanyName('');
      onClose();
    } catch (error) {
      logger.error('Erro ao enviar convite:', error);
      const message = await extractApiErrorMessage(error, 'Falha ao gerar convite de cadastro.');
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} shellClassName="w-full max-w-md">
      <ModalHeader
        title="Convidar nova empresa"
        description="Envie um link de cadastro para que o cliente configure sua própria empresa e conta de administrador."
        icon={<Mail className="h-5 w-5 text-[var(--ds-color-action-primary)]" />}
        onClose={onClose}
      />

      <form onSubmit={handleSend}>
        <ModalBody className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="invite-email" className="text-[13px] font-semibold text-[var(--ds-color-text-secondary)]">
              E-mail do administrador
            </label>
            <Input
              id="invite-email"
              type="email"
              placeholder="exemplo@cliente.com.br"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
            <p className="text-[11px] text-[var(--ds-color-text-muted)]">
              Um e-mail será enviado com as instruções de acesso.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="invite-company" className="text-[13px] font-semibold text-[var(--ds-color-text-secondary)]">
              Nome da empresa (opcional)
            </label>
            <div className="relative">
              <Building2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
              <Input
                id="invite-company"
                placeholder="Razão Social ou Nome Fantasia"
                className="pl-9"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>

          <div className="rounded-lg border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/12 p-3 text-[12px] leading-relaxed text-[var(--ds-color-text-secondary)]">
            <p className="font-semibold text-[var(--ds-color-text-primary)] mb-1">O que acontece agora?</p>
            O destinatário receberá um link válido por 7 dias. Ao clicar, ele iniciará o fluxo de cadastro (CNPJ, endereço e senha) e terá 30 dias de teste grátis.
          </div>
        </ModalBody>

        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button type="submit" disabled={loading || !email} leftIcon={loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}>
            {loading ? 'Enviando...' : 'Enviar convite'}
          </Button>
        </ModalFooter>
      </form>
    </ModalFrame>
  );
}
