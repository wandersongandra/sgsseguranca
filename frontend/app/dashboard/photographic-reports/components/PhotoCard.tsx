'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { Trash2, BrainCircuit, Save, ChevronDown, ImageIcon } from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { safeExternalArtifactUrl } from '@/lib/security/safe-external-url';
import type { PhotographicReportDay, PhotographicReportImage } from '@/services/photographicReportsService';
import {
  PHOTO_CONDITIONS,
  CONDITION_CLASSIFICATION_OPTIONS,
  type ClassificationValue,
} from '../constants';

export interface PhotoCardSavePayload {
  manual_caption: string | null;
  ai_condition_classification: string | null;
  photo_conditions: string[] | null;
  report_day_id?: string | null;
  image_order?: number;
  ai_title?: string | null;
  ai_description?: string | null;
  ai_positive_points?: string[] | null;
  ai_technical_assessment?: string | null;
  ai_recommendations?: string[] | null;
  is_nonconformity?: boolean;
  recommended_action?: string | null;
  action_deadline?: string | null;
  action_responsible?: string | null;
}

interface PhotoCardProps {
  image: PhotographicReportImage;
  sortedDays: PhotographicReportDay[];
  canManage: boolean;
  canUseAi: boolean;
  savingImageId: string | null;
  onSave: (imageId: string, payload: PhotoCardSavePayload) => void;
  onAnalyze: (imageId: string) => void;
  onDelete: (imageId: string) => void;
}

/**
 * Cor do ponto de classificação, derivada do `tone` semântico declarado em
 * constants.ts.
 *
 * Antes havia um mapa local com classes literais (bg-green-500 etc.) — segunda
 * fonte de verdade para o mesmo significado, e ironicamente a única cor que
 * realmente renderizava no módulo, porque todo o resto usava classes que não
 * existem neste projeto.
 */
const TONE_DOT: Record<string, string> = {
  success: 'bg-[var(--ds-color-success)]',
  info: 'bg-[var(--ds-color-info)]',
  warning: 'bg-[var(--ds-color-warning)]',
  danger: 'bg-[var(--ds-color-danger)]',
};

const NEUTRAL_DOT = 'bg-[var(--ds-color-surface-muted)]';

function classificationDot(value: string | null | undefined): string {
  const option = CONDITION_CLASSIFICATION_OPTIONS.find(
    (item) => item.value === value,
  );
  if (!option) return NEUTRAL_DOT;
  return TONE_DOT[option.tone] ?? NEUTRAL_DOT;
}

function joinLines(arr: string[] | null | undefined): string {
  return arr ? arr.join('\n') : '';
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function PhotoCard({
  image,
  sortedDays,
  canManage,
  canUseAi,
  savingImageId,
  onSave,
  onAnalyze,
  onDelete,
}: PhotoCardProps) {
  const isSaving = savingImageId === image.id;

  const [caption, setCaption] = useState(image.manual_caption ?? '');
  const [classification, setClassification] = useState<string>(
    image.ai_condition_classification ?? 'Satisfatória',
  );
  const [conditions, setConditions] = useState<string[]>(
    image.photo_conditions ?? [],
  );
  const [dayId, setDayId] = useState<string>(image.report_day_id ?? '');
  const [aiExpanded, setAiExpanded] = useState(false);

  const [isNonconformity, setIsNonconformity] = useState(
    image.is_nonconformity ?? false,
  );
  const [recommendedAction, setRecommendedAction] = useState(
    image.recommended_action ?? '',
  );
  const [actionDeadline, setActionDeadline] = useState(
    image.action_deadline ?? '',
  );
  const [actionResponsible, setActionResponsible] = useState(
    image.action_responsible ?? '',
  );

  /**
   * Marcar como NC sem informar a ação produz uma pendência sem dono — no
   * resumo do PDF vira uma linha vazia que não ajuda ninguém. O bloqueio é no
   * cliente; o backend aceita os campos de forma independente de propósito,
   * para que desmarcar não exija reenviar a ação.
   */
  const nonconformityIncomplete =
    isNonconformity && !recommendedAction.trim();

  // Uncontrolled refs for rarely-edited AI fields
  const aiTitleRef = useRef<HTMLInputElement>(null);
  const aiDescriptionRef = useRef<HTMLTextAreaElement>(null);
  const aiPositivePointsRef = useRef<HTMLTextAreaElement>(null);
  const aiAssessmentRef = useRef<HTMLTextAreaElement>(null);
  const aiRecommendationsRef = useRef<HTMLTextAreaElement>(null);

  function toggleCondition(cond: string) {
    setConditions((prev) =>
      prev.includes(cond) ? prev.filter((c) => c !== cond) : [...prev, cond],
    );
  }

  function handleSave() {
    onSave(image.id, {
      manual_caption: caption.trim() || null,
      ai_condition_classification: classification || null,
      photo_conditions: conditions.length > 0 ? conditions : null,
      report_day_id: dayId || null,
      ai_title: aiTitleRef.current?.value.trim() || null,
      ai_description: aiDescriptionRef.current?.value.trim() || null,
      ai_positive_points: aiPositivePointsRef.current?.value
        ? splitLines(aiPositivePointsRef.current.value)
        : null,
      ai_technical_assessment: aiAssessmentRef.current?.value.trim() || null,
      ai_recommendations: aiRecommendationsRef.current?.value
        ? splitLines(aiRecommendationsRef.current.value)
        : null,
      is_nonconformity: isNonconformity,
      recommended_action: recommendedAction.trim() || null,
      action_deadline: actionDeadline || null,
      action_responsible: actionResponsible.trim() || null,
    });
  }

  const imageSrc = safeExternalArtifactUrl(image.download_url || image.image_url);

  return (
    <div className="rounded-xl border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-elevated)] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
            Foto {String(image.image_order).padStart(2, '0')}
          </span>
          {image.ai_condition_classification && (
            <span
              className={`h-2 w-2 rounded-full ${classificationDot(image.ai_condition_classification)}`}
              title={image.ai_condition_classification}
            />
          )}
        </div>
        <button
          type="button"
          aria-label={`Excluir foto ${String(image.image_order).padStart(2, '0')}`}
          onClick={() => onDelete(image.id)}
          disabled={!canManage}
          className="text-[var(--ds-color-text-muted)] hover:text-[var(--ds-color-danger)] disabled:opacity-40 transition-colors"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Thumbnail */}
      <div className="overflow-hidden rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]">
        {imageSrc ? (
          <Image
            src={imageSrc}
            alt={image.ai_title || image.manual_caption || 'Foto do relatório'}
            width={800}
            height={192}
            className="h-48 w-full object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-48 items-center justify-center text-[var(--ds-color-text-muted)]">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
      </div>

      {/* Legenda */}
      <div>
        <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
          Legenda (opcional)
        </label>
        <input
          type="text"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          disabled={!canManage}
          placeholder="Descreva o que é mostrado nesta foto..."
          className="w-full rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm placeholder:text-[var(--ds-color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
        />
      </div>

      {/* Condições SST */}
      <div>
        <p className="text-xs font-medium text-[var(--ds-color-text-muted)] mb-2">
          Condições observadas
        </p>
        <div className="space-y-1.5">
          {PHOTO_CONDITIONS.map((cond) => (
            <label
              key={cond}
              className="flex items-center gap-2.5 cursor-pointer group"
            >
              <input
                type="checkbox"
                checked={conditions.includes(cond)}
                onChange={() => toggleCondition(cond)}
                disabled={!canManage}
                className="h-4 w-4 rounded border-[var(--ds-color-border-input)] text-[var(--ds-color-action-primary)] focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
              />
              <span className="text-sm text-[var(--ds-color-text-primary)] group-hover:text-[var(--ds-color-text-primary)]/80">
                {cond}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Classificação */}
      <div>
        <p className="text-xs font-medium text-[var(--ds-color-text-muted)] mb-2">
          Classificação da condição
        </p>
        <div className="grid grid-cols-2 gap-2">
          {CONDITION_CLASSIFICATION_OPTIONS.map((opt) => {
            const active = classification === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={!canManage}
                onClick={() => setClassification(opt.value as ClassificationValue)}
                className={[
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all',
                  active
                    ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-action-primary)]/10 text-[var(--ds-color-action-primary)] shadow-sm'
                    : 'border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-muted)] hover:border-[var(--ds-color-action-primary)]/40 hover:text-[var(--ds-color-text-primary)]',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                ].join(' ')}
              >
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${classificationDot(opt.value)}`}
                />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Não conformidade — transforma a evidência visual em pendência com
          dono e prazo, e alimenta o resumo de NC do PDF. */}
      <div>
        <label className="flex items-center gap-2.5 cursor-pointer group">
          <input
            type="checkbox"
            checked={isNonconformity}
            onChange={(e) => setIsNonconformity(e.target.checked)}
            disabled={!canManage}
            className="h-4 w-4 rounded border-[var(--ds-color-border-input)] text-[var(--ds-color-danger)] focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
          />
          <span className="text-sm font-medium text-[var(--ds-color-text-primary)]">
            Marcar como não conformidade
          </span>
        </label>

        {isNonconformity && (
          <div className="mt-3 space-y-3 rounded-lg border border-[var(--ds-color-danger)]/30 bg-[var(--ds-color-danger)]/5 p-3">
            <div>
              <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
                Ação recomendada <span className="text-[var(--ds-color-danger)]">*</span>
              </label>
              <textarea
                rows={3}
                value={recommendedAction}
                onChange={(e) => setRecommendedAction(e.target.value)}
                disabled={!canManage}
                placeholder="O que precisa ser feito para corrigir a condição observada..."
                className="w-full resize-none rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm placeholder:text-[var(--ds-color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
              />
              {nonconformityIncomplete && (
                <p className="mt-1 text-xs text-[var(--ds-color-danger)]">
                  Informe a ação — uma não conformidade sem ação vira uma linha
                  vazia no relatório.
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
                  Prazo
                </label>
                <input
                  type="date"
                  value={actionDeadline}
                  onChange={(e) => setActionDeadline(e.target.value)}
                  disabled={!canManage}
                  className="w-full rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
                  Responsável
                </label>
                <input
                  type="text"
                  value={actionResponsible}
                  onChange={(e) => setActionResponsible(e.target.value)}
                  disabled={!canManage}
                  placeholder="Quem executa a ação"
                  className="w-full rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm placeholder:text-[var(--ds-color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Seletor de data (só se houver múltiplos dias) */}
      {sortedDays.length > 1 && (
        <div>
          <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
            Data da atividade
          </label>
          <select
            value={dayId}
            onChange={(e) => setDayId(e.target.value)}
            disabled={!canManage}
            className="w-full rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
          >
            <option value="">Sem data</option>
            {sortedDays.map((day) => (
              <option key={day.id} value={day.id}>
                {format(new Date(day.activity_date), 'dd/MM/yyyy')}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Seção IA colapsável */}
      <div>
        <button
          type="button"
          onClick={() => setAiExpanded((v) => !v)}
          className="flex w-full items-center justify-between rounded-md border border-dashed border-[var(--ds-color-border-subtle)] px-3 py-2 text-xs font-medium text-[var(--ds-color-text-muted)] hover:text-[var(--ds-color-text-primary)] transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <BrainCircuit className="h-3.5 w-3.5" />
            {image.ai_title ? 'Ver / editar análise IA' : 'Análise IA (não gerada)'}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${aiExpanded ? 'rotate-180' : ''}`}
          />
        </button>
        {aiExpanded && (
          <div className="mt-3 space-y-3 rounded-md border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/30 p-3">
            <div>
              <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
                Título
              </label>
              <input
                ref={aiTitleRef}
                type="text"
                defaultValue={image.ai_title ?? ''}
                disabled={!canManage}
                className="w-full rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
                Descrição
              </label>
              <textarea
                ref={aiDescriptionRef}
                defaultValue={image.ai_description ?? ''}
                disabled={!canManage}
                rows={3}
                className="w-full resize-none rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
                Pontos positivos (um por linha)
              </label>
              <textarea
                ref={aiPositivePointsRef}
                defaultValue={joinLines(image.ai_positive_points)}
                disabled={!canManage}
                rows={3}
                className="w-full resize-none rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
                Avaliação técnica
              </label>
              <textarea
                ref={aiAssessmentRef}
                defaultValue={image.ai_technical_assessment ?? ''}
                disabled={!canManage}
                rows={3}
                className="w-full resize-none rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ds-color-text-muted)] mb-1">
                Recomendações (uma por linha)
              </label>
              <textarea
                ref={aiRecommendationsRef}
                defaultValue={joinLines(image.ai_recommendations)}
                disabled={!canManage}
                rows={3}
                className="w-full resize-none rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
              />
            </div>
          </div>
        )}
      </div>

      {/* Ações */}
      <div className="flex flex-wrap gap-2">
        {canUseAi && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onAnalyze(image.id)}
            loading={isSaving}
            leftIcon={<BrainCircuit className="h-3.5 w-3.5" />}
          >
            Analisar com IA
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          loading={isSaving}
          disabled={!canManage || nonconformityIncomplete}
          title={
            nonconformityIncomplete
              ? 'Informe a ação recomendada da não conformidade'
              : undefined
          }
          leftIcon={<Save className="h-3.5 w-3.5" />}
        >
          Salvar foto
        </Button>
      </div>
    </div>
  );
}
