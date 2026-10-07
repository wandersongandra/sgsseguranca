import { useRef } from 'react';
import { Eye, FileDown, Mail, ShieldCheck, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { safeToLocaleString } from '@/lib/date/safeFormat';
import type { CatRecord } from '@/services/catsService';

type Props = {
  cat: CatRecord;
  location: string;
  canManage: boolean;
  onOpenAttachment: (catId: string, attachmentId: string) => void;
  onUploadAttachment: (catId: string, file?: File) => void;
  onLocalPdf: (cat: CatRecord) => void;
  onGovernedPdf: (cat: CatRecord) => void;
  onEmail: (cat: CatRecord) => void;
  onEdit: (cat: CatRecord) => void;
  onInvestigate: (cat: CatRecord) => void;
  onClose: (cat: CatRecord) => void;
};

export function CatMobileCard({ cat, location, canManage, onOpenAttachment, onUploadAttachment, onLocalPdf, onGovernedPdf, onEmail, onEdit, onInvestigate, onClose }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editable = canManage && cat.status !== 'fechada';
  return <article className="ds-mobile-card">
    <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{cat.numero}</h3><p className="text-sm text-[var(--ds-color-text-secondary)]">{cat.worker?.nome || 'Sem colaborador'}</p></div><span className="rounded-full border px-2.5 py-1 text-xs font-semibold">{cat.status}</span></div>
    <dl className="ds-mobile-detail-grid mt-3 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Data</dt><dd>{safeToLocaleString(cat.data_ocorrencia, 'pt-BR', undefined, '—')}</dd></div><div><dt className="text-xs text-[var(--ds-color-text-muted)]">Local</dt><dd>{location}</dd></div></dl>
    {(cat.attachments || []).length > 0 ? <div className="mt-3"><p className="text-xs font-semibold text-[var(--ds-color-text-muted)]">Anexos</p><div className="mt-1 flex flex-wrap gap-1">{(cat.attachments || []).map((item) => <Button key={item.id} type="button" size="sm" variant="outline" onClick={() => onOpenAttachment(cat.id, item.id)} leftIcon={<Eye className="h-3.5 w-3.5" />}>{item.file_name}</Button>)}</div></div> : null}
    <div className="ds-mobile-card__actions mt-4 grid grid-cols-2 gap-2 border-t border-[var(--ds-color-border-subtle)] pt-3">
      {canManage ? <><input type="file" aria-label={`Selecionar anexo da CAT ${cat.numero}`} ref={fileInputRef} className="hidden" onChange={(event) => onUploadAttachment(cat.id, event.target.files?.[0])} /><Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} leftIcon={<Upload className="h-4 w-4" />}>Anexar</Button></> : null}
      <Button size="sm" variant="outline" onClick={() => onLocalPdf(cat)} leftIcon={<FileDown className="h-4 w-4" />}>PDF local</Button>
      <Button size="sm" variant="outline" onClick={() => onGovernedPdf(cat)} disabled={!cat.pdf_file_key && !canManage} title={cat.pdf_file_key ? 'Abrir PDF final governado' : canManage ? 'Emitir PDF final governado' : 'Sem permissão para emitir PDF final governado'} leftIcon={<ShieldCheck className="h-4 w-4" />}>{cat.pdf_file_key ? 'PDF final' : 'Emitir final'}</Button>
      <Button size="sm" variant="outline" onClick={() => onEmail(cat)} leftIcon={<Mail className="h-4 w-4" />}>E-mail</Button>
      {editable ? <Button size="sm" variant="outline" onClick={() => onEdit(cat)}>Editar</Button> : null}
      {editable ? <Button size="sm" variant="outline" onClick={() => onInvestigate(cat)}>Investigar</Button> : null}
      {editable ? <Button size="sm" variant="success" onClick={() => onClose(cat)}>Fechar</Button> : null}
    </div>
  </article>;
}
