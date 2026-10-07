import Link from 'next/link';
import { AlertTriangle, Bot, BrainCircuit, ClipboardList, Download, Mail, Pencil, Printer, Trash2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { safeFormatDate } from '@/lib/date/safeFormat';
import { isAiEnabled } from '@/lib/featureFlags';
import type { Checklist } from '@/services/checklistsService';
import { getChecklistManualNcHref, getChecklistSophieNcHref } from './checklistActions';

interface Props {
  checklist: Checklist;
  selected: boolean;
  canManage: boolean;
  canManageNc: boolean;
  analyzing: boolean;
  printing: boolean;
  onToggleSelect: (id: string) => void;
  onAiAnalysis: (id: string) => void;
  onPrint: (checklist: Checklist) => void;
  onDownloadPdf: (checklist: Checklist) => void;
  onSendEmail: (checklist: Checklist) => void;
  onDelete: (id: string) => void;
}

export function ChecklistMobileCard({ checklist, selected, canManage, canManageNc, analyzing, printing, onToggleSelect, onAiAnalysis, onPrint, onDownloadPdf, onSendEmail, onDelete }: Props) {
  return (
    <article className="ds-mobile-card">
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={() => onToggleSelect(checklist.id)} className="mt-1 h-5 w-5" aria-label={`Selecionar checklist ${checklist.titulo}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-[var(--ds-color-text-primary)]">{checklist.titulo}</h3>
            <span className="rounded-full bg-[var(--ds-color-surface-muted)] px-2.5 py-1 text-xs font-semibold">{checklist.status}</span>
          </div>
          <dl className="ds-mobile-detail-grid mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <div><dt className="text-xs text-[var(--ds-color-text-muted)]">Data</dt><dd>{safeFormatDate(checklist.data, 'dd/MM/yyyy')}</dd></div>
            <div><dt className="text-xs text-[var(--ds-color-text-muted)]">Inspetor</dt><dd>{checklist.inspetor?.nome || '-'}</dd></div>
            <div><dt className="text-xs text-[var(--ds-color-text-muted)]">Empresa</dt><dd>{checklist.company?.razao_social || '-'}</dd></div>
            <div><dt className="text-xs text-[var(--ds-color-text-muted)]">Equipamento</dt><dd>{checklist.equipamento || checklist.maquina || '-'}</dd></div>
          </dl>
        </div>
      </div>
      <div className="ds-mobile-card__actions mt-4 grid grid-cols-2 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3">
        {checklist.is_modelo ? <Link href={`/dashboard/checklists/new?source=model&templateId=${checklist.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'justify-center')} aria-label={`Preencher checklist ${checklist.titulo}`}><ClipboardList className="mr-2 h-4 w-4" />Preencher</Link> : null}
        {isAiEnabled() ? <Button type="button" size="sm" variant="outline" onClick={() => onAiAnalysis(checklist.id)} disabled={analyzing} leftIcon={<BrainCircuit className="h-4 w-4" />} aria-label={`Analisar checklist ${checklist.titulo} com SGS`}>Analisar SGS</Button> : null}
        <Button type="button" size="sm" variant="outline" onClick={() => onPrint(checklist)} disabled={printing} leftIcon={<Printer className="h-4 w-4" />}>Imprimir</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onDownloadPdf(checklist)} disabled={printing} leftIcon={<Download className="h-4 w-4" />}>Baixar</Button>
        {canManage ? <Button type="button" size="sm" variant="outline" onClick={() => onSendEmail(checklist)} disabled={printing} leftIcon={<Mail className="h-4 w-4" />}>Enviar</Button> : null}
        {canManage ? <Link href={`/dashboard/checklists/edit/${checklist.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'justify-center')}><Pencil className="mr-2 h-4 w-4" />Editar</Link> : null}
        {canManageNc ? <Link href={getChecklistSophieNcHref(checklist)} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'justify-center')} aria-label={`Abrir não conformidade com SOPHIE para checklist ${checklist.titulo}`}><Bot className="mr-2 h-4 w-4" />NC SOPHIE</Link> : null}
        {canManageNc ? <Link href={getChecklistManualNcHref(checklist)} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'justify-center')} aria-label={`Criar não conformidade manual para checklist ${checklist.titulo}`}><AlertTriangle className="mr-2 h-4 w-4" />NC manual</Link> : null}
        {canManage ? <Button type="button" size="sm" variant="destructive" className="min-[400px]:col-span-2" onClick={() => onDelete(checklist.id)} leftIcon={<Trash2 className="h-4 w-4" />} aria-label={`Excluir checklist ${checklist.titulo}`}>Excluir</Button> : null}
      </div>
    </article>
  );
}
