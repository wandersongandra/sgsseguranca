import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PageHeader } from './PageHeader';
import { MobileActionBar } from '@/components/ui/mobile-action-bar';

interface FormPageLayoutProps {
  eyebrow?: string;
  title: string;
  description?: string;
  icon?: ReactNode;
  /** Botões de ação no header (ex: voltar, ajuda) */
  actions?: ReactNode;
  /** Bloco de contexto/resumo abaixo do header e acima das seções */
  summary?: ReactNode;
  children: ReactNode;
  /**
   * Conteúdo do rodapé sticky.
   * Tipicamente: botões Salvar / Cancelar.
   * Ex: `footer={<><Button>Salvar</Button><Button variant="ghost">Cancelar</Button></>}`
   */
  footer?: ReactNode;
  className?: string;
}

interface FormSectionProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  badge?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

interface FormGridProps {
  /** Número de colunas. Colapsa para 1 em mobile. */
  cols?: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
}

interface FormFieldGroupProps {
  /** Label acima do grupo — ex: "Dados do solicitante" */
  label?: string;
  description?: string;
  /**
   * Cor semântica da borda lateral.
   * - `default` = borda cinza neutra
   * - `primary`  = borda verde principal (ações normativas)
   * - `warning`  = borda âmbar (campos de atenção)
   * - `danger`   = borda vermelha (campos críticos)
   */
  tone?: 'default' | 'primary' | 'warning' | 'danger';
  children: ReactNode;
  className?: string;
}

/**
 * FormPageLayout — template oficial para páginas de formulário longo.
 *
 * Estrutura:
 * ```
 * <PageHeader eyebrow title description icon actions />
 * {summary}                    ← opcional — resumo/contexto do registro
 * {children}                   ← seções (<FormSection>) empilhadas
 * <StickyFooter>{footer}</StickyFooter>
 * ```
 *
 * Uso:
 * ```tsx
 * <FormPageLayout
 *   eyebrow="Configurações"
 *   title="Dados da empresa"
 *   description="Informações cadastrais e operacionais."
 *   icon={<Building2 className="h-5 w-5" />}
 *   footer={<><Button>Salvar</Button><Button variant="ghost">Cancelar</Button></>}
 * >
 *   <FormSection title="Identificação" description="Razão social, CNPJ e contato.">
 *     <FormGrid cols={2}>
 *       <FormField label="Razão social"><Input /></FormField>
 *       <FormField label="CNPJ"><Input /></FormField>
 *     </FormGrid>
 *   </FormSection>
 * </FormPageLayout>
 * ```
 */
export function FormPageLayout({
  eyebrow,
  title,
  description,
  icon,
  actions,
  summary,
  children,
  footer,
  className,
}: FormPageLayoutProps) {
  return (
    <div className={cn('ds-form-shell ds-form-page', className)}>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        icon={icon}
        actions={actions}
      />
      {summary}
      {children}
      {footer ? <MobileActionBar>{footer}</MobileActionBar> : null}
    </div>
  );
}

/**
 * FormSection — card de seção dentro de um formulário.
 *
 * Agrupa campos relacionados sob um título claro com divisor.
 * Para subgrupos menores dentro de uma seção, use `FormFieldGroup`.
 *
 * ```tsx
 * <FormSection title="Localização" icon={<MapPin className="h-4 w-4" />}>
 *   <FormGrid cols={2}>
 *     <FormField label="CEP"><Input /></FormField>
 *     <FormField label="Cidade"><Input /></FormField>
 *   </FormGrid>
 * </FormSection>
 * ```
 */
export function FormSection({
  title,
  description,
  icon,
  badge,
  actions,
  children,
  className,
}: FormSectionProps) {
  return (
    <section className={cn('ds-form-section', className)}>
      {/* Responsive: column em mobile, row em md+ (definido em globals.css) */}
      <div className="ds-form-section__header">
        <div className="flex gap-3">
          {icon ? (
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] text-[var(--ds-color-text-secondary)]">
              {icon}
            </div>
          ) : null}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-[var(--ds-color-text-primary)]">{title}</h2>
              {badge ? (
                <span className="ds-badge ds-badge--info">{badge}</span>
              ) : null}
            </div>
            {description ? (
              <p className="mt-1 max-w-3xl text-sm text-[var(--ds-color-text-secondary)]">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * FormGrid — layout de colunas para campos de formulário.
 *
 * Colapsa para 1 coluna em mobile automaticamente.
 *
 * ```tsx
 * <FormGrid cols={2}>
 *   <FormField label="Nome"><Input /></FormField>
 *   <FormField label="CPF"><Input /></FormField>
 * </FormGrid>
 * ```
 */
export function FormGrid({ cols = 2, children, className }: FormGridProps) {
  const colClass = cols === 1 ? '' : cols === 3 ? 'ds-form-grid--3' : 'ds-form-grid--2';
  return (
    <div className={cn('ds-form-grid', colClass, className)}>
      {children}
    </div>
  );
}

/**
 * FormFieldGroup — subgrupo semântico com borda lateral.
 *
 * Use para destacar visualmente um conjunto de campos relacionados
 * dentro de uma `FormSection`, sem criar um novo card.
 * A `tone` da borda indica a criticidade do grupo.
 *
 * ```tsx
 * <FormSection title="Riscos identificados">
 *   <FormFieldGroup
 *     tone="warning"
 *     label="Agentes físicos"
 *     description="Ruído, vibração, temperatura e radiação."
 *   >
 *     <FormField label="Nível de ruído"><Input /></FormField>
 *     <FormField label="Vibração"><Input /></FormField>
 *   </FormFieldGroup>
 * </FormSection>
 * ```
 */
export function FormFieldGroup({ label, description, tone = 'default', children, className }: FormFieldGroupProps) {
  const toneClass = tone !== 'default' ? `ds-form-field-group--${tone}` : null;
  return (
    <div className={cn('ds-form-field-group', toneClass, className)}>
      {label ? <p className="ds-form-field-group__label">{label}</p> : null}
      {description ? <p className="ds-form-field-group__desc">{description}</p> : null}
      {children}
    </div>
  );
}
