import React, { useRef, useState } from 'react';
import { type Path, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { safeExternalArtifactUrl } from '@/lib/security/safe-external-url';
import type { PtFormData } from './pt-schema-and-data';
import { StatusPill } from '@/components/ui/status-pill';
import {
  ptsService,
  type PtChecklistAttachmentField,
} from '@/services/ptsService';

type ChecklistResponse = 'Sim' | 'Não' | 'Não aplicável' | 'Ciente';
type ChecklistFieldName =
  | 'recomendacoes_gerais_checklist'
  | 'trabalho_altura_checklist'
  | 'trabalho_eletrico_checklist'
  | 'trabalho_quente_checklist'
  | 'trabalho_espaco_confinado_checklist'
  | 'trabalho_escavacao_checklist';
type AttachableChecklistFieldName = Exclude<ChecklistFieldName, 'recomendacoes_gerais_checklist'>;

interface ChecklistItem {
  id: string;
  pergunta: string;
  resposta?: 'Sim' | 'Não' | 'Não aplicável' | 'Ciente';
  justificativa?: string;
  anexo_nome?: string;
  anexo_ref?: string;
  allowNA?: boolean;
  optional?: boolean;
  section?: string;
}

interface ChecklistSectionProps {
  name: ChecklistFieldName;
  title: string;
  description: string;
  questions: ChecklistItem[];
  baseResponses: ChecklistResponse[];
  showJustificationOn: ('Não' | 'Não aplicável')[];
  /** PT persistida — habilita o upload real de anexos governados. */
  ptId?: string;
}

const ChecklistSection: React.FC<ChecklistSectionProps> = ({
  name,
  title,
  description,
  questions,
  baseResponses,
  showJustificationOn,
  ptId,
}) => {
  const { control, formState: { errors }, setValue } = useFormContext<PtFormData>();
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const uploadLockRef = useRef(false);
  const { fields } = useFieldArray({ control, name });
  const watchedItems = useWatch({ control, name }) as Array<{ resposta?: string }> | undefined;
  const answeredCount = (watchedItems ?? []).filter((item) => item?.resposta).length;
  const totalCount = fields.length;

  type ChecklistItemError = {
    resposta?: { message?: unknown };
    justificativa?: { message?: unknown };
  };

  const getError = (index: number, fieldName: 'resposta' | 'justificativa') => {
    const sectionErrors = errors[name] as unknown;
    if (!Array.isArray(sectionErrors)) return null;
    const itemError = sectionErrors[index];
    if (!itemError || typeof itemError !== 'object') return null;
    const message = (itemError as ChecklistItemError)[fieldName]?.message;
    return typeof message === 'string' ? message : null;
  };

  const hasAttachmentField = (fieldName: ChecklistFieldName): fieldName is AttachableChecklistFieldName => (
    fieldName.startsWith('trabalho_')
  );

  const handleAttachmentUpload = async (index: number, file: File) => {
    if (!ptId || !hasAttachmentField(name)) return;
    if (uploadLockRef.current) return;
    const MAX_SIZE_MB = 10;
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      toast.error(`O arquivo deve ter no máximo ${MAX_SIZE_MB}MB.`);
      return;
    }
    uploadLockRef.current = true;
    setUploadingIndex(index);
    try {
      const result = await ptsService.attachChecklistItemFile(
        ptId,
        name as PtChecklistAttachmentField,
        index,
        file,
      );
      setValue(
        `${name}.${index}.anexo_nome` as Path<PtFormData>,
        result.anexoNome,
        { shouldValidate: true },
      );
      setValue(
        `${name}.${index}.anexo_ref` as Path<PtFormData>,
        result.anexoReference,
        { shouldValidate: true },
      );
      toast.success('Anexo enviado.');
    } catch (error) {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response
          ?.data?.message || 'Erro ao enviar o anexo.';
      toast.error(message);
    } finally {
      uploadLockRef.current = false;
      setUploadingIndex(null);
    }
  };

  const handleOpenAttachment = async (index: number) => {
    if (!ptId || !hasAttachmentField(name)) return;
    try {
      const access = await ptsService.getChecklistItemAttachmentAccess(
        ptId,
        name as PtChecklistAttachmentField,
        index,
      );
      if (access.url) {
        const safeUrl = safeExternalArtifactUrl(access.url);
        if (!safeUrl) {
          toast.error('Anexo bloqueado pela política de segurança.');
          return;
        }
        window.open(safeUrl, '_blank', 'noopener,noreferrer');
      } else {
        toast.error('Anexo registrado, mas indisponível no momento.');
      }
    } catch {
      toast.error('Não foi possível abrir o anexo.');
    }
  };

  const sectionOf = (index: number): string | undefined => {
    const item = fields[index] as unknown as ChecklistItem | undefined;
    if (!item) return undefined;
    const questionInfo = questions.find((q) => q.id === item.id);
    return questionInfo?.section ?? item.section;
  };

  const hasSections = fields.some((_, index) => Boolean(sectionOf(index)));
  const sectionOrder: string[] = [];
  const indicesBySection = new Map<string, number[]>();
  fields.forEach((_, index) => {
    const section = sectionOf(index) ?? '';
    if (!indicesBySection.has(section)) {
      indicesBySection.set(section, []);
      sectionOrder.push(section);
    }
    indicesBySection.get(section)!.push(index);
  });

  const renderItem = (index: number) => {
          const item = fields[index];
          if (!item) return null;
          const questionInfo = questions.find(q => q.id === item.id);
          const field = item as ChecklistItem;
          const responseError = getError(index, 'resposta');
          const justificationError = getError(index, 'justificativa');
          const prompt = questionInfo?.pergunta ?? field.pergunta;
          const allowsNA =
            questionInfo?.allowNA ??
            field.allowNA ??
            field.resposta === 'Não aplicável';
          const isOptional = questionInfo?.optional ?? field.optional ?? false;
          const responses = allowsNA
            ? baseResponses
            : baseResponses.filter(r => r !== 'Não aplicável');

          return (
            <div
              key={item.id}
              className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)]/14 p-4"
            >
              <fieldset
                className="min-w-0"
                aria-required={!isOptional}
                aria-describedby={responseError ? `pt-checklist-error-${index}` : undefined}
              >
              <legend className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                {prompt}
                {!isOptional && (
                  <span className="text-[var(--color-danger)]" aria-hidden="true">
                    {' '}
                    *
                  </span>
                )}
              </legend>

              {/* Respostas (Radio) */}
              <div className="mt-3 flex flex-wrap gap-4">
                {responses.map(responseValue => (
                  <label
                    key={responseValue}
                    className="flex items-center gap-2 text-sm text-[var(--ds-color-text-primary)]"
                  >
                    <input
                      type="radio"
                      name={`${name}-${index}`}
                      checked={field.resposta === responseValue}
                      required={!isOptional}
                      aria-describedby={responseError ? `pt-checklist-error-${index}` : undefined}
                      onChange={() => setValue(`${name}.${index}.resposta`, responseValue, { shouldValidate: true })}
                      className="h-4 w-4 text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                    />
                    <span>{responseValue}</span>
                  </label>
                ))}
              </div>
              {responseError && (
                <p id={`pt-checklist-error-${index}`} role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
                  {responseError}
                </p>
              )}

              {/* Justificativa */}
              {field.resposta && showJustificationOn.some((value) => value === field.resposta) && (
                <div className="mt-3">
                  <label htmlFor={`pt-checklist-just-${index}`} className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                    Justificativa <span className="text-[var(--color-danger)]">*</span>
                  </label>
                  <textarea
                    id={`pt-checklist-just-${index}`}
                    aria-required="true"
                    aria-invalid={Boolean(justificationError)}
                    aria-describedby={
                      justificationError ? `pt-checklist-just-error-${index}` : undefined
                    }
                    value={field.justificativa || ''}
                    onChange={(e) => setValue(`${name}.${index}.justificativa`, e.target.value, { shouldValidate: true })}
                    rows={3}
                    maxLength={2000}
                    className={cn(
                      'block w-full rounded-[var(--ds-radius-md)] border bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs text-[var(--ds-color-text-primary)] motion-safe:transition-all focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]',
                      justificationError
                        ? 'border-[color:var(--ds-color-danger-border)] bg-[color:var(--ds-color-danger-subtle)]/40'
                        : 'border-[var(--ds-color-border-default)]',
                    )}
                    placeholder="Explique o motivo da resposta."
                  />
                  {justificationError && (
                    <p
                      id={`pt-checklist-just-error-${index}`}
                      role="alert"
                      className="mt-2 text-xs text-[var(--color-danger)]"
                    >
                      {justificationError}
                    </p>
                  )}
                </div>
              )}

              {/* Anexo governado (se aplicável) */}
              {hasAttachmentField(name) && (
                 <div className="mt-3">
                    <label htmlFor={`pt-checklist-anexo-${index}`} className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                      Anexo (opcional)
                    </label>
                    <input
                      id={`pt-checklist-anexo-${index}`}
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,.webp"
                      disabled={!ptId || uploadingIndex !== null}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        void handleAttachmentUpload(index, file);
                      }}
                      className="block w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-xs text-[var(--ds-color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      {!ptId
                        ? 'Anexos disponíveis após salvar a PT.'
                        : uploadingIndex === index
                          ? 'Enviando anexo...'
                          : field.anexo_nome
                            ? `Arquivo: ${field.anexo_nome}`
                            : 'Nenhum arquivo — PDF, JPG, PNG ou WebP até 10 MB'}
                      {ptId && field.anexo_ref && uploadingIndex !== index && (
                        <>
                          {' '}
                          <button
                            type="button"
                            onClick={() => void handleOpenAttachment(index)}
                            className="font-semibold text-[var(--ds-color-info)] hover:underline"
                          >
                            Ver anexo
                          </button>
                        </>
                      )}
                    </p>
                  </div>
              )}
              </fieldset>
            </div>
          );
  };

  return (
    <div className="ds-form-section">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-[var(--ds-color-text-primary)]">{title}</h2>
        <StatusPill tone={answeredCount === totalCount ? 'success' : 'warning'}>
          {answeredCount}/{totalCount}
        </StatusPill>
      </div>
      <p className="mb-6 text-sm text-[var(--ds-color-text-primary)]">{description}</p>
      {hasSections ? (
        <div className="space-y-6">
          {sectionOrder.map((section) => (
            <div key={section || '__sem_secao__'} className="space-y-3">
              {section && (
                <h3 className="text-sm font-bold uppercase tracking-wide text-[var(--ds-color-text-primary)]">
                  {section}
                </h3>
              )}
              <div className="space-y-4">
                {indicesBySection.get(section)!.map((index) => renderItem(index))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map((_, index) => renderItem(index))}
        </div>
      )}
    </div>
  );
};

export default React.memo(ChecklistSection);
