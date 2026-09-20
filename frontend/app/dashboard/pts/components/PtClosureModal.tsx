import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PT_CONDICOES_AREA,
  type Pt,
  type PtCondicaoArea,
} from '@/services/ptsService';
import { Button } from '@/components/ui/button';
import { ModalBody, ModalFooter, ModalFrame, ModalHeader } from '@/components/ui/modal-frame';

type PtClosureModalProps = {
  pt: Pt | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: (payload: {
    condicao_area: PtCondicaoArea;
    data_hora_real_fim?: string;
    observacoes?: string;
  }) => void;
};

const toLocalDateTimeInputValue = (date: Date): string => {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
};

export function PtClosureModal({
  pt,
  loading,
  onClose,
  onConfirm,
}: PtClosureModalProps) {
  const [condicaoArea, setCondicaoArea] = useState<PtCondicaoArea | ''>('');
  const [dataHoraRealFim, setDataHoraRealFim] = useState('');
  const [observacoes, setObservacoes] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const conditionRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (pt) {
      setCondicaoArea('');
      setDataHoraRealFim(toLocalDateTimeInputValue(new Date()));
      setObservacoes('');
      setValidationError(null);
    }
  }, [pt]);

  const minDateTime = useMemo(
    () =>
      pt?.data_hora_inicio
        ? toLocalDateTimeInputValue(new Date(pt.data_hora_inicio))
        : undefined,
    [pt?.data_hora_inicio],
  );

  if (!pt) return null;

  const handleConfirm = () => {
    if (!condicaoArea) {
      setValidationError('Selecione a condição da área na devolução.');
      return;
    }
    if (
      dataHoraRealFim &&
      pt.data_hora_inicio &&
      new Date(dataHoraRealFim) < new Date(pt.data_hora_inicio)
    ) {
      setValidationError(
        'O término real não pode ser anterior ao início da PT.',
      );
      return;
    }
    setValidationError(null);
    onConfirm({
      condicao_area: condicaoArea,
      data_hora_real_fim: dataHoraRealFim
        ? new Date(dataHoraRealFim).toISOString()
        : undefined,
      observacoes: observacoes.trim() || undefined,
    });
  };

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      initialFocusRef={conditionRef}
      shellClassName="max-w-lg"
    >
      <ModalHeader
        title={`Encerrar PT ${pt.numero}`}
        description="Registre a devolução da área. Esses dados ficam gravados no documento e no PDF final."
        onClose={onClose}
      />
      <ModalBody>
        <div className="space-y-4">
          <div>
            <label
              htmlFor="pt-closure-condition"
              className="mb-1 block text-sm font-semibold text-[var(--ds-color-text-primary)]"
            >
              Condição da área <span className="text-[var(--ds-color-danger)]">*</span>
            </label>
            <select
              ref={conditionRef}
              id="pt-closure-condition"
              value={condicaoArea}
              required
              aria-required="true"
              aria-invalid={Boolean(validationError && !condicaoArea)}
              aria-describedby={validationError ? 'pt-closure-error' : undefined}
              onChange={(event) =>
                setCondicaoArea(event.target.value as PtCondicaoArea | '')
              }
              className="block w-full rounded-lg border border-[var(--ds-color-border-default)] px-3 py-2 text-sm focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
            >
              <option value="">Selecione...</option>
              {PT_CONDICOES_AREA.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="pt-closure-real-end"
              className="mb-1 block text-sm font-semibold text-[var(--ds-color-text-primary)]"
            >
              Data/hora real de término
            </label>
            <input
              id="pt-closure-real-end"
              type="datetime-local"
              value={dataHoraRealFim}
              min={minDateTime}
              onChange={(event) => setDataHoraRealFim(event.target.value)}
              className="block w-full rounded-lg border border-[var(--ds-color-border-default)] px-3 py-2 text-sm focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
            />
          </div>

          <div>
            <label
              htmlFor="pt-closure-notes"
              className="mb-1 block text-sm font-semibold text-[var(--ds-color-text-primary)]"
            >
              Observações de encerramento
            </label>
            <textarea
              id="pt-closure-notes"
              value={observacoes}
              onChange={(event) => setObservacoes(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Ex: Área limpa, bloqueios removidos e sistema reenergizado."
              className="block w-full rounded-lg border border-[var(--ds-color-border-default)] px-3 py-2 text-sm focus:border-[var(--ds-color-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
            />
          </div>

          {validationError && (
            <p id="pt-closure-error" role="alert" className="text-sm text-[var(--ds-color-danger)]">
              {validationError}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
          Cancelar
        </Button>
        <Button type="button" variant="primary" onClick={handleConfirm} loading={loading}>
          Encerrar PT
        </Button>
      </ModalFooter>
    </ModalFrame>
  );
}

export default PtClosureModal;
