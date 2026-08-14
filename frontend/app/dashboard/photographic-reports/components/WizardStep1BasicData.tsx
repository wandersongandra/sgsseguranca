'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { ChipSelector, MultiChipSelector } from './ChipSelector';
import {
  SHIFT_OPTIONS,
  TONE_OPTIONS,
  AREA_STATUS_OPTIONS,
  APPLICABLE_NR_OPTIONS,
  NR_LABELS,
  REGISTRATION_TYPE_OPTIONS,
} from '../constants';
import type {
  PhotographicReportShift,
  PhotographicReportTone,
  PhotographicReportAreaStatus,
} from '@/services/photographicReportsService';
import type { ReportFormState } from '../types';

interface WizardStep1Props {
  form: ReportFormState;
  onFormChange: <K extends keyof ReportFormState>(key: K, value: ReportFormState[K]) => void;
  canManage: boolean;
  mode: 'create' | 'edit';
  onNext: () => void;
  saving: boolean;
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'date' | 'time';
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--ds-color-text-primary)] mb-1">
        {label}
        {required && <span className="ml-0.5 text-[var(--ds-color-danger)]">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm placeholder:text-[var(--ds-color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
      />
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
  disabled,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  rows?: number;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--ds-color-text-primary)] mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        className="w-full resize-none rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm placeholder:text-[var(--ds-color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
      />
    </div>
  );
}

export function WizardStep1BasicData({
  form,
  onFormChange,
  canManage,
  mode,
  onNext,
  saving,
}: WizardStep1Props) {
  const { user } = useAuth();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Auto-fill in create mode only — on first mount
  useEffect(() => {
    if (mode !== 'create') return;
    if (!form.responsible_name && user?.nome) {
      onFormChange('responsible_name', user.nome);
    }
    if (!form.contractor_company && user?.company?.razao_social) {
      onFormChange('contractor_company', user.company.razao_social);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canProceed =
    form.client_name.trim() &&
    form.project_name.trim() &&
    form.activity_type.trim() &&
    form.start_date.trim() &&
    form.responsible_name.trim() &&
    form.contractor_company.trim();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--ds-color-text-primary)]">Dados do relatório</h2>
        <p className="text-sm text-[var(--ds-color-text-muted)] mt-0.5">
          Informações básicas sobre a inspeção ou atividade realizada.
        </p>
      </div>

      {/* Essential fields grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Cliente"
          value={form.client_name}
          onChange={(v) => onFormChange('client_name', v)}
          required
          disabled={!canManage}
          placeholder="Nome do cliente"
        />
        <Field
          label="Obra / projeto"
          value={form.project_name}
          onChange={(v) => onFormChange('project_name', v)}
          required
          disabled={!canManage}
          placeholder="Nome da obra ou projeto"
        />
        <Field
          label="Tipo de atividade"
          value={form.activity_type}
          onChange={(v) => onFormChange('activity_type', v)}
          required
          disabled={!canManage}
          placeholder="Ex: Inspeção de segurança"
        />
        <Field
          label="Data da inspeção"
          value={form.start_date}
          onChange={(v) => onFormChange('start_date', v)}
          type="date"
          required
          disabled={!canManage}
        />
        <Field
          label="Responsável pelo relatório"
          value={form.responsible_name}
          onChange={(v) => onFormChange('responsible_name', v)}
          required
          disabled={!canManage}
          placeholder="Nome do responsável"
        />
        <Field
          label="Empresa executora"
          value={form.contractor_company}
          onChange={(v) => onFormChange('contractor_company', v)}
          required
          disabled={!canManage}
          placeholder="Razão social da empresa"
        />
      </div>

      {/* Chip selectors */}
      <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-3">
        <ChipSelector
          label="Turno"
          options={SHIFT_OPTIONS}
          value={form.shift}
          onChange={(v) => onFormChange('shift', v as PhotographicReportShift)}
          disabled={!canManage}
        />
        <ChipSelector
          label="Tom do relatório"
          options={TONE_OPTIONS}
          value={form.report_tone}
          onChange={(v) => onFormChange('report_tone', v as PhotographicReportTone)}
          disabled={!canManage}
        />
        <ChipSelector
          label="Condição da área"
          options={AREA_STATUS_OPTIONS}
          value={form.area_status}
          onChange={(v) => onFormChange('area_status', v as PhotographicReportAreaStatus)}
          disabled={!canManage}
        />
      </div>

      {/* Credencial técnica — é por este bloco que um relatório de SST é
          julgado. Opcional no formulário, mas destacado para que a ausência
          seja uma escolha e não um esquecimento. */}
      <div className="rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/40 p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
            Credencial do responsável técnico
          </h3>
          <p className="mt-0.5 text-xs text-[var(--ds-color-text-muted)]">
            Preenchido, aparece no PDF junto do nome do responsável. Sem
            registro profissional, o documento vale como registro fotográfico,
            não como parecer técnico.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="block text-sm font-medium text-[var(--ds-color-text-primary)] mb-1">
              Conselho
            </label>
            <select
              value={form.responsible_registration_type}
              onChange={(e) =>
                onFormChange(
                  'responsible_registration_type',
                  e.target.value as ReportFormState['responsible_registration_type'],
                )
              }
              disabled={!canManage}
              className="w-full rounded-md border border-[var(--ds-color-border-input)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)] disabled:opacity-50"
            >
              <option value="">Não informado</option>
              {REGISTRATION_TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Número do registro"
            value={form.responsible_registration_number}
            onChange={(v) => onFormChange('responsible_registration_number', v)}
            disabled={!canManage}
            placeholder="Ex: 5069874521"
          />
          <Field
            label="UF"
            value={form.responsible_registration_state}
            onChange={(v) =>
              onFormChange(
                'responsible_registration_state',
                v.toUpperCase().slice(0, 2),
              )
            }
            disabled={!canManage}
            placeholder="SP"
          />
          <Field
            label="ART"
            value={form.art_number}
            onChange={(v) => onFormChange('art_number', v)}
            disabled={!canManage}
            placeholder="Nº da ART, se houver"
          />
        </div>
      </div>

      {/* Escopo normativo */}
      <MultiChipSelector
        label="Normas regulamentadoras aplicáveis"
        description="Selecione as NRs que a inspeção observou. Aparecem em seção própria do relatório."
        options={APPLICABLE_NR_OPTIONS}
        values={form.applicable_nrs}
        onChange={(values) => onFormChange('applicable_nrs', values)}
        optionLabels={NR_LABELS}
        disabled={!canManage}
      />

      {/* Advanced section */}
      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1.5 text-sm text-[var(--ds-color-text-muted)] hover:text-[var(--ds-color-text-primary)] transition-colors"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
          />
          Detalhes avançados
        </button>

        {advancedOpen && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 rounded-lg border border-dashed border-[var(--ds-color-border-subtle)] p-4 bg-[var(--ds-color-surface-muted)]/30">
            <Field
              label="Unidade / seção"
              value={form.unit_name}
              onChange={(v) => onFormChange('unit_name', v)}
              disabled={!canManage}
              placeholder="Ex: Setor de manutenção"
            />
            <Field
              label="Localização"
              value={form.location}
              onChange={(v) => onFormChange('location', v)}
              disabled={!canManage}
              placeholder="Ex: Galpão B, piso 2"
            />
            <Field
              label="Código do cliente"
              value={form.client_id}
              onChange={(v) => onFormChange('client_id', v)}
              disabled={!canManage}
            />
            <Field
              label="Código da obra"
              value={form.project_id}
              onChange={(v) => onFormChange('project_id', v)}
              disabled={!canManage}
            />
            <Field
              label="Data final"
              value={form.end_date}
              onChange={(v) => onFormChange('end_date', v)}
              type="date"
              disabled={!canManage}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Horário início"
                value={form.start_time}
                onChange={(v) => onFormChange('start_time', v)}
                type="time"
                disabled={!canManage}
              />
              <Field
                label="Horário término"
                value={form.end_time}
                onChange={(v) => onFormChange('end_time', v)}
                type="time"
                disabled={!canManage}
              />
            </div>
            <div className="sm:col-span-2">
              <TextArea
                label="Observações gerais"
                value={form.general_observations}
                onChange={(v) => onFormChange('general_observations', v)}
                disabled={!canManage}
              />
            </div>
          </div>
        )}
      </div>

      {/* Action */}
      <div className="flex justify-end pt-2">
        <Button
          type="button"
          onClick={onNext}
          loading={saving}
          disabled={!canManage || !canProceed}
        >
          Próximo → Fotos
        </Button>
      </div>
    </div>
  );
}
