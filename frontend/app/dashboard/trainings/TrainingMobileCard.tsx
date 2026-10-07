import type { ComponentProps } from 'react';
import Link from 'next/link';
import { Download, Mail, Pencil, Printer, Trash2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { safeToLocaleDateString } from '@/lib/date/safeFormat';
import type { Training } from '@/services/trainingsService';

type Props = {
  training: Training;
  statusLabel: string;
  statusTone: ComponentProps<typeof StatusPill>['tone'];
  busy: boolean;
  onPrint: (training: Training) => void;
  onDownload: (training: Training) => void;
  onEmail: (training: Training) => void;
  onDelete: (training: Training) => void;
};

export function TrainingMobileCard({ training, statusLabel, statusTone, busy, onPrint, onDownload, onEmail, onDelete }: Props) {
  return <article className="ds-mobile-card">
    <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{training.nome}</h3><p className="text-sm text-[var(--ds-color-text-secondary)]">{training.user?.nome || 'Colaborador'}</p></div><StatusPill tone={statusTone}>{statusLabel}</StatusPill></div>
    <dl className="ds-mobile-detail-grid mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Conclusão</dt><dd>{safeToLocaleDateString(training.data_conclusao, 'pt-BR', undefined, '—')}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Vencimento</dt><dd>{safeToLocaleDateString(training.data_vencimento, 'pt-BR', undefined, '—')}</dd></div></dl>
    <div className="ds-mobile-card__actions mt-4 grid grid-cols-2 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3">
      <Button size="sm" variant="outline" onClick={() => onPrint(training)} disabled={busy} leftIcon={<Printer className="h-4 w-4" />}>Imprimir</Button>
      <Button size="sm" variant="outline" onClick={() => onDownload(training)} disabled={busy} leftIcon={<Download className="h-4 w-4" />}>PDF</Button>
      <Button size="sm" variant="outline" onClick={() => onEmail(training)} disabled={busy} leftIcon={<Mail className="h-4 w-4" />}>E-mail</Button>
      <Link href={`/dashboard/trainings/edit/${training.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'justify-center')}><Pencil className="mr-2 h-4 w-4" />Editar</Link>
      <Button size="sm" variant="danger" onClick={() => onDelete(training)} leftIcon={<Trash2 className="h-4 w-4" />}>Excluir</Button>
    </div>
  </article>;
}
