'use client';

import type { ReactNode } from 'react';
import type { FieldErrors, FieldPath } from 'react-hook-form';
import {
  ArrowLeft,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  ClipboardList,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/ui/metric-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  FormFieldGroup,
  FormGrid,
  FormPageLayout,
  FormSection,
} from '@/components/layout';
import { cn } from '@/lib/utils';
import { DID_STATUS_LABEL } from '@/services/didsService';
import { DID_TURNO_LABEL } from '../didMeta';
import type { DidFormData } from '../didForm.schema';

export const inputClassName =
  'mt-2 block min-h-12 w-full rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[var(--component-field-bg)] px-3.5 py-3 text-sm font-medium leading-6 text-[var(--ds-color-text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.05)] placeholder:text-[color:var(--ds-color-text-secondary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--component-field-border-focus)] focus:outline-none focus:shadow-[var(--component-field-shadow-focus)]';

export const textareaClassName = `${inputClassName} min-h-[152px] resize-y align-top`;
export const labelClassName =
  'text-sm font-semibold text-[var(--ds-color-text-primary)]';
export const helperClassName =
  'mt-2 text-xs font-medium leading-5 text-[var(--ds-color-text-secondary)]';
export const errorClassName = 'mt-1 text-xs text-[var(--ds-color-danger)]';

function getUserInitials(name?: string | null) {
  if (!name) {
    return '??';
  }

  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

type DidFormPageShellProps = {
  children: ReactNode;
  footer: ReactNode;
  extraActions?: ReactNode;
  id?: string;
  isReadOnly: boolean;
  readOnlyMessage?: string | null;
  currentStatus?: keyof typeof DID_STATUS_LABEL;
  selectedTurno?: string;
  selectedCompanyName?: string;
  selectedSiteName?: string;
  participantCount: number;
  selectedMainActivity?: string;
  selectedTitle?: string;
  onBack: () => void;
  saving: boolean;
  isSubmitting: boolean;
};

export function DidFormPageShell({
  children,
  footer,
  extraActions,
  id,
  isReadOnly,
  readOnlyMessage,
  currentStatus,
  selectedTurno,
  selectedCompanyName,
  selectedSiteName,
  participantCount,
  selectedMainActivity,
  selectedTitle,
  onBack,
  saving,
  isSubmitting,
}: DidFormPageShellProps) {
  return (
    <FormPageLayout
      className="space-y-8"
      eyebrow="Formalização diária"
      title={id ? 'Editar Diálogo do Início do Dia' : 'Novo Diálogo do Início do Dia'}
      description="Registro diário com leitura direta para equipe, atividade, riscos e combinados do turno."
      icon={<ClipboardList className="h-5 w-5" />}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="info">DID</StatusPill>
          <StatusPill tone={id ? 'warning' : 'success'}>
            {id ? 'Edição' : 'Novo registro'}
          </StatusPill>
          <StatusPill tone={isReadOnly ? 'warning' : 'success'}>
            {isReadOnly ? 'Somente leitura' : 'Fluxo ativo'}
          </StatusPill>
          <Button type="button" variant="secondary" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Voltar para DIDs
          </Button>
          {extraActions}
        </div>
      }
      summary={
        <>
          <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
              Fluxo guiado
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
              Estruture empresa, frente, atividade e equipe antes de consolidar os combinados do dia.
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              O foco aqui é dar leitura rápida para o campo sem perder rastreabilidade do alinhamento diário.
            </p>
          </div>
          {readOnlyMessage ? (
            <div
              role="alert"
              className="rounded-[var(--ds-radius-xl)] border border-[color:var(--ds-color-warning)]/30 bg-[color:var(--ds-color-warning-subtle)] px-5 py-4 text-sm text-[color:var(--ds-color-warning)]"
            >
              <p className="font-semibold text-[color:var(--ds-color-warning)]">
                Documento travado para edição
              </p>
              <p className="mt-1 text-[color:var(--ds-color-warning)]/90">
                {readOnlyMessage}
              </p>
            </div>
          ) : null}
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Status visual"
              value={currentStatus ? DID_STATUS_LABEL[currentStatus] : 'Rascunho'}
              note={isReadOnly ? 'Registro finalizado.' : 'Registro pronto para edição.'}
              tone="primary"
            />
            <MetricCard
              label="Turno"
              value={
                selectedTurno
                  ? DID_TURNO_LABEL[selectedTurno] || selectedTurno
                  : 'A definir'
              }
              note={selectedCompanyName || 'Selecione a empresa'}
              tone="info"
            />
            <MetricCard
              label="Equipe"
              value={participantCount}
              note="participante(s) marcados"
              tone="success"
            />
            <MetricCard
              label="Frente / atividade"
              value={selectedSiteName || 'Local pendente'}
              note={selectedMainActivity || selectedTitle || 'Defina o foco do alinhamento'}
            />
          </section>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusPill tone="info">{selectedCompanyName || 'Empresa pendente'}</StatusPill>
            <StatusPill tone="warning">
              {selectedSiteName || 'Site / frente pendente'}
            </StatusPill>
            <StatusPill tone="success">{participantCount} participante(s)</StatusPill>
          </div>
        </>
      }
    >
      <fieldset
        disabled={isReadOnly || saving || isSubmitting}
        className={cn('space-y-7', isReadOnly && 'opacity-90')}
      >
        {children}
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-base)] px-5 py-5 shadow-[var(--ds-shadow-sm)]">
          {footer}
        </div>
      </fieldset>
    </FormPageLayout>
  );
}

type DidContextSectionProps = {
  register: (name: FieldPath<DidFormData>) => Record<string, unknown>;
  errors: FieldErrors<DidFormData>;
  companies: Array<{ id: string; razao_social: string }>;
  filteredSites: Array<{ id: string; nome: string }>;
  filteredUsers: Array<{ id: string; nome: string }>;
  isAdminGeral: boolean;
  companyLabel?: string | null;
  selectedCompanyId: string;
  handleCompanyChange: (companyId: string) => void;
};

export function DidContextSection({
  register,
  errors,
  companies,
  filteredSites,
  filteredUsers,
  isAdminGeral,
  companyLabel,
  selectedCompanyId,
  handleCompanyChange,
}: DidContextSectionProps) {
  return (
    <FormSection
      title="Contexto do dia"
      description="Defina o contexto do documento com mais contraste e menos ruído visual."
      icon={<CalendarDays className="h-4 w-4" />}
      badge="Etapa 1"
      className="border-l-4 border-l-[var(--ds-color-info)]"
    >
      <FormGrid cols={2}>
        <div className="md:col-span-2">
          <label htmlFor="did-titulo" className={labelClassName}>
            Título
          </label>
          <input
            id="did-titulo"
            type="text"
            {...register('titulo')}
            className={inputClassName}
            placeholder="Ex.: Alinhamento da equipe de montagem"
          />
          {errors.titulo ? (
            <p className={errorClassName}>{errors.titulo.message}</p>
          ) : (
            <p className={helperClassName}>
              Use um título curto que identifique o DID com facilidade.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="did-data" className={labelClassName}>
            Data
          </label>
          <input
            id="did-data"
            type="date"
            {...register('data')}
            className={inputClassName}
          />
          {errors.data ? <p className={errorClassName}>{errors.data.message}</p> : null}
        </div>

        <div>
          <label htmlFor="did-turno" className={labelClassName}>
            Turno
          </label>
          <select id="did-turno" {...register('turno')} className={inputClassName}>
            <option value="">Selecione</option>
            <option value="manha">{DID_TURNO_LABEL.manha}</option>
            <option value="tarde">{DID_TURNO_LABEL.tarde}</option>
            <option value="noite">{DID_TURNO_LABEL.noite}</option>
            <option value="integral">{DID_TURNO_LABEL.integral}</option>
          </select>
        </div>

        <div>
          <label htmlFor="did-company" className={labelClassName}>
            Empresa
          </label>
          {isAdminGeral ? (
            <select
              id="did-company"
              {...register('company_id')}
              onChange={(event) => handleCompanyChange(event.target.value)}
              className={inputClassName}
            >
              <option value="">Selecione a empresa</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.razao_social}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input type="hidden" {...register('company_id')} />
              <div className="mt-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)] px-3.5 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                  {companyLabel || 'Empresa vinculada ao seu acesso'}
                </p>
                <p className={cn(helperClassName, 'mt-2')}>
                  Empresa fixa para este usuário. A troca de empresa é exclusiva do Administrador Geral.
                </p>
              </div>
            </>
          )}
          {errors.company_id ? (
            <p className={errorClassName}>{errors.company_id.message}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="did-site" className={labelClassName}>
            Site / frente
          </label>
          <select
            id="did-site"
            {...register('site_id')}
            className={inputClassName}
            disabled={!selectedCompanyId}
          >
            <option value="">
              {selectedCompanyId ? 'Selecione o site' : 'Selecione uma empresa primeiro'}
            </option>
            {filteredSites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.nome}
              </option>
            ))}
          </select>
          {errors.site_id ? <p className={errorClassName}>{errors.site_id.message}</p> : null}
        </div>

        <div>
          <label htmlFor="did-responsavel" className={labelClassName}>
            Responsável
          </label>
          <select
            id="did-responsavel"
            {...register('responsavel_id')}
            className={inputClassName}
            disabled={!selectedCompanyId}
          >
            <option value="">
              {selectedCompanyId ? 'Selecione o responsável' : 'Selecione uma empresa primeiro'}
            </option>
            {filteredUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.nome}
              </option>
            ))}
          </select>
          {errors.responsavel_id ? (
            <p className={errorClassName}>{errors.responsavel_id.message}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="did-frente" className={labelClassName}>
            Frente de trabalho
          </label>
          <input
            id="did-frente"
            type="text"
            {...register('frente_trabalho')}
            className={inputClassName}
            placeholder="Ex.: Galpão 02, Área externa, Setor B"
          />
        </div>

        <div className="md:col-span-2">
          <label htmlFor="did-descricao" className={labelClassName}>
            Descrição e objetivo do alinhamento
          </label>
          <textarea
            id="did-descricao"
            {...register('descricao')}
            className={textareaClassName}
            placeholder="Explique rapidamente o foco do alinhamento e o combinado principal do dia."
          />
        </div>
      </FormGrid>
    </FormSection>
  );
}

type DidOperationalSectionProps = {
  register: (name: FieldPath<DidFormData>) => Record<string, unknown>;
  errors: FieldErrors<DidFormData>;
};

export function DidOperationalSection({
  register,
  errors,
}: DidOperationalSectionProps) {
  return (
    <FormSection
      title="Conteúdo operacional"
      description="Separe o plano do turno, os pontos de atenção e os complementos em blocos mais claros e fáceis de revisar."
      icon={<BriefcaseBusiness className="h-4 w-4" />}
      badge="Etapa 2"
      className="border-l-4 border-l-[var(--ds-color-warning)]"
    >
      <div className="space-y-5">
        <FormFieldGroup
          tone="primary"
          label="Plano do turno"
          description="Organize o que será feito e como a equipe deve se orientar."
          className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)] px-5 py-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        >
          <FormGrid cols={1}>
            <div>
              <label htmlFor="did-atividade-principal" className={labelClassName}>
                Atividade principal
              </label>
              <input
                id="did-atividade-principal"
                type="text"
                {...register('atividade_principal')}
                className={inputClassName}
                placeholder="Ex.: Montagem de linha, concretagem, inspeção visual"
              />
              {errors.atividade_principal ? (
                <p className={errorClassName}>{errors.atividade_principal.message}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="did-atividades-planejadas" className={labelClassName}>
                Atividades planejadas
              </label>
              <textarea
                id="did-atividades-planejadas"
                {...register('atividades_planejadas')}
                className={cn(textareaClassName, 'min-h-[144px]')}
                placeholder="Liste as frentes, a sequência ou os combinados principais do dia."
              />
              {errors.atividades_planejadas ? (
                <p className={errorClassName}>{errors.atividades_planejadas.message}</p>
              ) : null}
            </div>
          </FormGrid>
        </FormFieldGroup>

        <FormFieldGroup
          tone="warning"
          label="Riscos e controles"
          description="Deixe claro o que merece atenção e como a equipe deve se organizar."
          className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)] px-5 py-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        >
          <FormGrid cols={2}>
            <div>
              <label htmlFor="did-riscos-operacionais" className={labelClassName}>
                Riscos operacionais
              </label>
              <textarea
                id="did-riscos-operacionais"
                {...register('riscos_operacionais')}
                className={cn(textareaClassName, 'min-h-[150px]')}
                placeholder="Ex.: movimentação de carga, acesso de veículos, piso irregular."
              />
              {errors.riscos_operacionais ? (
                <p className={errorClassName}>{errors.riscos_operacionais.message}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="did-controles-planejados" className={labelClassName}>
                Controles planejados
              </label>
              <textarea
                id="did-controles-planejados"
                {...register('controles_planejados')}
                className={cn(textareaClassName, 'min-h-[150px]')}
                placeholder="Ex.: isolamento da área, conferência antes do início, comunicação por rádio."
              />
              {errors.controles_planejados ? (
                <p className={errorClassName}>{errors.controles_planejados.message}</p>
              ) : null}
            </div>
          </FormGrid>
        </FormFieldGroup>

        <FormFieldGroup
          tone="default"
          label="Complementos"
          description="Campos extras para reforçar o combinado visual do turno."
          className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)] px-5 py-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        >
          <FormGrid cols={2}>
            <div>
              <label htmlFor="did-epi-epc" className={labelClassName}>
                EPIs / EPCs aplicáveis
              </label>
              <textarea
                id="did-epi-epc"
                {...register('epi_epc_aplicaveis')}
                className={textareaClassName}
                placeholder="Ex.: capacete, luvas, colete refletivo, cones."
              />
            </div>

            <div>
              <label htmlFor="did-observacoes" className={labelClassName}>
                Observações
              </label>
              <textarea
                id="did-observacoes"
                {...register('observacoes')}
                className={textareaClassName}
                placeholder="Registre recados rápidos, alinhamentos complementares ou observações gerais."
              />
            </div>
          </FormGrid>
        </FormFieldGroup>
      </div>
    </FormSection>
  );
}

type DidParticipantsSectionProps = {
  selectedCompanyId: string;
  filteredUsers: Array<{ id: string; nome: string }>;
  selectedParticipantIds: string[];
  toggleParticipant: (userId: string) => void;
  participantsError?: string;
};

export function DidParticipantsSection({
  selectedCompanyId,
  filteredUsers,
  selectedParticipantIds,
  toggleParticipant,
  participantsError,
}: DidParticipantsSectionProps) {
  return (
    <FormSection
      title="Participantes"
      description="A seleção da equipe usa contraste mais forte para facilitar a conferência antes do fechamento do DID."
      icon={<Users className="h-4 w-4" />}
      badge="Etapa 3"
      actions={<StatusPill tone="info">{selectedParticipantIds.length} selecionado(s)</StatusPill>}
      className="border-l-4 border-l-[var(--ds-color-action-primary)]"
    >
      {!selectedCompanyId ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-dashed border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)] px-5 py-8 text-center text-sm text-[var(--ds-color-text-muted)]">
          Selecione uma empresa para listar os participantes.
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-dashed border-[var(--ds-color-border-default)] bg-[color:var(--ds-color-surface-muted)] px-5 py-8 text-center text-sm text-[var(--ds-color-text-muted)]">
          Nenhum usuário disponível para a empresa selecionada.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filteredUsers.map((user) => {
            const selected = selectedParticipantIds.includes(user.id);
            return (
              <button
                key={user.id}
                type="button"
                onClick={() => toggleParticipant(user.id)}
                aria-label={
                  selected
                    ? `${user.nome}: participante selecionado. Clique para remover da equipe do DID.`
                    : `${user.nome}: participante disponível. Clique para incluir na equipe do DID.`
                }
                className={cn(
                  'flex min-h-[86px] items-center justify-between rounded-[var(--ds-radius-lg)] border px-4 py-3 text-left text-sm motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)]',
                  selected
                    ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-primary-subtle)] text-[var(--ds-color-text-primary)] shadow-[var(--component-card-shadow)]'
                    : 'border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-secondary)] hover:border-[var(--ds-color-border-default)] hover:bg-[var(--ds-color-surface-muted)]',
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      'flex h-11 w-11 items-center justify-center rounded-full border text-xs font-semibold tracking-[0.08em]',
                      selected
                        ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-action-primary)]'
                        : 'border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)]',
                    )}
                  >
                    {getUserInitials(user.nome)}
                  </div>
                  <div className="space-y-1">
                    <p className="font-semibold text-[var(--ds-color-text-primary)]">
                      {user.nome}
                    </p>
                    <p className="text-xs font-medium leading-5 text-[var(--ds-color-text-secondary)]">
                      {selected
                        ? 'Participante incluído na equipe deste DID'
                        : 'Participante disponível para este DID'}
                    </p>
                  </div>
                </div>
                <div
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full border',
                    selected
                      ? 'border-[var(--ds-color-action-primary)] bg-[var(--ds-color-action-primary)] text-[var(--ds-color-action-primary-foreground)]'
                      : 'border-[var(--ds-color-border-default)] text-[var(--ds-color-text-muted)]',
                  )}
                >
                  {selected ? (
                    <ShieldCheck className="h-4 w-4" />
                  ) : (
                    <Building2 className="h-4 w-4" />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {participantsError ? (
        <p className={errorClassName}>{participantsError}</p>
      ) : selectedParticipantIds.length === 0 ? (
        <div
          role="alert"
          className="rounded-[var(--ds-radius-lg)] border border-[color:var(--ds-color-warning)]/22 bg-[color:var(--ds-color-warning-subtle)] px-4 py-3 text-sm text-[var(--ds-color-warning)]"
        >
          <p className="font-semibold">Equipe ainda não definida</p>
          <p className="mt-1 text-[color:var(--ds-color-warning)]/90">
            Selecione pelo menos um participante para formalizar o DID do turno.
          </p>
        </div>
      ) : null}
    </FormSection>
  );
}
