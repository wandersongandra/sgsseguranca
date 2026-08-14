'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { trainingsService, TrainingLookupUser } from '@/services/trainingsService';
import { companiesService, Company } from '@/services/companiesService';
import { signaturesService } from '@/services/signaturesService';
import { SignatureModal } from './SignatureModal';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ArrowLeft, Save, PenTool, CheckCircle } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { toInputDateValue } from '@/lib/date/safeFormat';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout';
import { InlineLoadingState } from '@/components/ui/state';
import { StatusPill } from '@/components/ui/status-pill';

const trainingSchema = z.object({
  nome: z.string().min(2, 'O nome deve ter pelo menos 2 caracteres'),
  data_conclusao: z.string().min(1, 'Data de conclusão é obrigatória'),
  data_vencimento: z.string().min(1, 'Data de vencimento é obrigatória'),
  certificado_url: z.string().optional().or(z.literal('')),
  user_id: z.string().min(1, 'Selecione um colaborador'),
  company_id: z.string().min(1, 'Selecione uma empresa'),
  auditado_por_id: z.string().optional(),
  data_auditoria: z.string().optional(),
  resultado_auditoria: z.string().optional(),
  notas_auditoria: z.string().optional(),
});

type TrainingFormData = z.infer<typeof trainingSchema>;

interface TrainingFormProps {
  id?: string;
}

import { AuditSection } from './AuditSection';
import { isAdminGeralAccount } from '@/lib/auth-session-state';
import { sessionStore } from '@/lib/sessionStore';

const fieldClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] transition-all duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--ds-shadow-sm)]';
const labelClassName = 'text-sm font-medium text-[var(--ds-color-text-secondary)]';
const helperClassName = 'text-xs text-[var(--ds-color-text-muted)]';
const errorClassName = 'text-xs text-[var(--ds-color-danger)]';
const sectionCardClassName =
  'rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--ds-color-surface-base)_94%,white_6%)_0%,var(--ds-color-surface-base)_100%)] p-5 shadow-[var(--ds-shadow-xs)]';
const sectionHeaderClassName = 'space-y-1';
const sectionEyebrowClassName =
  'text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-muted)]';
const sectionDescriptionClassName = 'text-sm text-[var(--ds-color-text-secondary)]';

export function TrainingForm({ id }: TrainingFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<TrainingLookupUser[]>([]);
  const isAdminGeral = isAdminGeralAccount(sessionStore.get());
  const [filteredUsers, setFilteredUsers] = useState<TrainingLookupUser[]>([]);

  // Estados para assinaturas
  const [isSignatureModalOpen, setIsSignatureModalOpen] = useState(false);
  const [signatures, setSignatures] = useState<Record<string, { data: string, type: string }>>({});
  const [currentSigningUser, setCurrentSigningUser] = useState<TrainingLookupUser | null>(null);
  const previousCompanyIdRef = useRef<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<TrainingFormData>({
    resolver: zodResolver(trainingSchema),
    defaultValues: {
      nome: '',
      data_conclusao: '',
      data_vencimento: '',
      certificado_url: '',
      user_id: '',
      company_id: isAdminGeral ? '' : (sessionStore.get()?.companyId || ''),
      auditado_por_id: '',
      data_auditoria: '',
      resultado_auditoria: '',
      notas_auditoria: '',
    },
  });

  const selectedCompanyId = watch('company_id');

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {

      try {
        if (isAdminGeral) {
          const companiesData = await companiesService.findAll();
          setCompanies(companiesData);
        }

        if (id) {
          setSignatures({});
          const docSignaturesPromise = signaturesService.findByDocument(
            id,
            'TRAINING',
          );
          const trainingData = await trainingsService.findOne(id);

          reset({
            nome: trainingData.nome,
            data_conclusao: toInputDateValue(trainingData.data_conclusao),
            data_vencimento: toInputDateValue(trainingData.data_vencimento),
            certificado_url: trainingData.certificado_url || '',
            user_id: trainingData.user_id,
            company_id: trainingData.company_id,
            auditado_por_id: trainingData.auditado_por_id || '',
            data_auditoria: toInputDateValue(trainingData.data_auditoria),
            resultado_auditoria: trainingData.resultado_auditoria || '',
            notas_auditoria: trainingData.notas_auditoria || '',
          });

          void docSignaturesPromise
            .then((docSignatures) => {
              if (cancelled) {
                return;
              }
              const sigs: Record<string, { data: string; type: string }> = {};
              docSignatures.forEach((sig) => {
                if (!sig.user_id) return;
                const data = sig.signature_data.startsWith('data:image')
                  ? sig.signature_data
                  : `data:image/png;base64,${sig.signature_data}`;
                sigs[sig.user_id] = { data, type: sig.type };
              });
              setSignatures(sigs);
            })
            .catch((error) => {
              if (cancelled) {
                return;
              }
              logger.error('Erro ao carregar assinaturas do treinamento:', error);
              toast.error('As assinaturas do treinamento não puderam ser carregadas agora.');
            });
        }
      } catch (error) {
        logger.error('Erro ao carregar dados:', error);
        toast.error('Erro ao carregar dados para o formulário.');
        router.push('/dashboard/trainings');
      } finally {
        if (cancelled) {
          return;
        }
        setFetching(false);
      }
    }

    void loadInitialData();
    return () => {
      cancelled = true;
    };
  }, [id, isAdminGeral, reset, router]);

  useEffect(() => {
    const previousCompanyId = previousCompanyIdRef.current;
    previousCompanyIdRef.current = selectedCompanyId;

    if (previousCompanyId === null) {
      return;
    }

    if (previousCompanyId !== selectedCompanyId) {
      setValue('user_id', '');
      setValue('auditado_por_id', '');
      setSignatures({});
      setCurrentSigningUser(null);
    }
  }, [selectedCompanyId, setValue]);

  useEffect(() => {
    let cancelled = false;

    async function loadCompanyUsers() {
      if (!selectedCompanyId) {
        setUsers([]);
        setFilteredUsers([]);
        return;
      }

      try {
        const companyUsers = await trainingsService.findAllLookupUsers(
          selectedCompanyId || undefined,
        );
        if (cancelled) {
          return;
        }
        setUsers(companyUsers);
        setFilteredUsers(companyUsers);
      } catch (error) {
        logger.error('Erro ao carregar colaboradores por empresa:', error);
        if (!cancelled) {
          setUsers([]);
          setFilteredUsers([]);
        }
      }
    }

    void loadCompanyUsers();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId]);

  const handleOpenSignature = () => {
    const userId = watch('user_id');
    if (!userId) {
      toast.error('Selecione um colaborador primeiro.');
      return;
    }
    const user = users.find(u => u.id === userId);
    if (user) {
      setCurrentSigningUser(user);
      setIsSignatureModalOpen(true);
    }
  };

  const handleSaveSignature = (signatureData: string, type: string) => {
    const userId = watch('user_id');
    if (userId) {
      setSignatures({
        [userId]: { data: signatureData, type }
      });
      toast.success('Assinatura do colaborador capturada!');
    }
  };

  async function onSubmit(data: TrainingFormData) {
    const userId = watch('user_id');
    if (!signatures[userId]) {
      toast.error('A assinatura do colaborador é obrigatória.');
      return;
    }

    try {
      setLoading(true);
      let training;
      if (id) {
        training = await trainingsService.update(id, data);
        toast.success('Treinamento atualizado com sucesso!');
      } else {
        training = await trainingsService.create(data);
        toast.success('Treinamento registrado com sucesso!');
      }

      // Salvar assinatura
      const trainingId = id || training.id;
      await signaturesService.create({
        document_id: trainingId,
        document_type: 'TRAINING',
        user_id: userId,
        signature_data: signatures[userId].data,
        type: signatures[userId].type
      });

      router.push('/dashboard/trainings');
      router.refresh();
    } catch (error) {
      logger.error('Erro ao salvar treinamento:', error);
      toast.error('Erro ao salvar treinamento. Verifique os dados e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ds-form-page mx-auto max-w-4xl space-y-6">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState
            label={id ? 'Carregando treinamento' : 'Preparando treinamento'}
          />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Gestão de treinamentos"
        title={id ? 'Editar treinamento' : 'Novo treinamento'}
        description="Registre validade, colaborador, certificado e assinatura em um fluxo único."
        icon={
          <Link
            href="/dashboard/trainings"
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-primary-subtle)] hover:text-[var(--ds-color-text-primary)]"
            aria-label="Voltar para a lista de treinamentos"
            title="Voltar"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="info">Treinamento</StatusPill>
            <StatusPill tone={id ? 'warning' : 'success'}>
              {id ? 'Edição' : 'Novo cadastro'}
            </StatusPill>
            <StatusPill tone={watch('user_id') && signatures[watch('user_id')] ? 'success' : 'warning'}>
              {watch('user_id') && signatures[watch('user_id')] ? 'Assinado' : 'Assinatura pendente'}
            </StatusPill>
          </div>
        }
      />

      <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 px-5 py-4 shadow-[var(--ds-shadow-xs)]">
        <p className={sectionEyebrowClassName}>
          Cadastro guiado
        </p>
        <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
          Estruture o treinamento com vínculo empresarial, validade documental e assinatura do colaborador.
        </p>
        <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
          Revise empresa, colaborador, nome do treinamento e datas antes de salvar para evitar vencimentos inconsistentes.
        </p>
      </div>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="space-y-5 rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]"
      >
        <section className={sectionCardClassName}>
          <div className={sectionHeaderClassName}>
            <p className={sectionEyebrowClassName}>
              Contexto e certificação
            </p>
            <p className={sectionDescriptionClassName}>
              Defina empresa, colaborador, treinamento e vigência para manter a trilha de conformidade atualizada.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {isAdminGeral ? (
            <div className="space-y-2 md:col-span-2">
              <label htmlFor="company_id" className={labelClassName}>
                Empresa
              </label>
              <select
                id="company_id"
                {...register('company_id')}
                aria-invalid={errors.company_id ? 'true' : undefined}
                className={fieldClassName}
              >
                <option value="">Selecione uma empresa</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.razao_social}
                  </option>
                ))}
              </select>
              {errors.company_id ? (
                <p className={errorClassName}>{errors.company_id.message}</p>
              ) : (
                <p className={helperClassName}>A empresa define o tenant e a base de colaboradores disponíveis.</p>
              )}
            </div>
          ) : (
            <input type="hidden" {...register('company_id')} />
          )}

            <div className="space-y-2 md:col-span-2">
              <label htmlFor="user_id" className={labelClassName}>
                Colaborador
              </label>
              <div className="flex flex-col gap-2 md:flex-row">
                <select
                  id="user_id"
                  {...register('user_id')}
                  disabled={!selectedCompanyId}
                  aria-invalid={errors.user_id ? 'true' : undefined}
                  className={`${fieldClassName} disabled:bg-[var(--ds-color-surface-muted)] md:flex-1`}
                  onChange={(e) => {
                    setValue('user_id', e.target.value);
                    setSignatures({});
                  }}
                >
                  <option value="">Selecione um colaborador</option>
                  {filteredUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.nome} - {user.funcao}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleOpenSignature}
                  disabled={!watch('user_id')}
                  className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--ds-radius-md)] px-4 py-2.5 text-sm font-semibold shadow-sm transition-all md:w-40 ${
                    signatures[watch('user_id')]
                      ? 'border border-[var(--ds-color-success-border)] bg-[var(--ds-color-success-subtle)] text-[var(--ds-color-success)]'
                      : 'border border-[var(--ds-color-action-primary)] bg-[var(--ds-color-action-primary)] text-[var(--ds-color-action-primary-foreground)] hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50'
                  }`}
                >
                  {signatures[watch('user_id')] ? (
                    <>
                      <CheckCircle className="h-4 w-4" />
                      <span>Assinado</span>
                    </>
                  ) : (
                    <>
                      <PenTool className="h-4 w-4" />
                      <span>Assinar</span>
                    </>
                  )}
                </button>
              </div>
              {errors.user_id ? (
                <p className={errorClassName}>{errors.user_id.message}</p>
              ) : !selectedCompanyId ? (
                <p className={helperClassName}>
                  Selecione uma empresa para liberar a lista de colaboradores.
                </p>
              ) : (
                <p className={helperClassName}>
                  A assinatura do colaborador é obrigatória para concluir o registro.
                </p>
              )}
            </div>

            <div className="space-y-2 md:col-span-2">
              <label htmlFor="nome" className={labelClassName}>
                Nome do Treinamento / NR
              </label>
              <input
                id="nome"
                type="text"
                {...register('nome')}
                aria-invalid={errors.nome ? 'true' : undefined}
                className={fieldClassName}
                placeholder="Ex: NR-35 Trabalho em Altura"
              />
              {errors.nome ? (
                <p className={errorClassName}>{errors.nome.message}</p>
              ) : (
                <p className={helperClassName}>
                  Use o nome oficial ou a NR para facilitar buscas e controle de vencimento.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="data_conclusao" className={labelClassName}>
                Data de Conclusão
              </label>
              <input
                id="data_conclusao"
                type="date"
                {...register('data_conclusao')}
                aria-invalid={errors.data_conclusao ? 'true' : undefined}
                className={fieldClassName}
              />
              {errors.data_conclusao ? (
                <p className={errorClassName}>{errors.data_conclusao.message}</p>
              ) : (
                <p className={helperClassName}>
                  Use a data real de conclusão para calcular a vigência corretamente.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="data_vencimento" className={labelClassName}>
                Data de Vencimento
              </label>
              <input
                id="data_vencimento"
                type="date"
                {...register('data_vencimento')}
                aria-invalid={errors.data_vencimento ? 'true' : undefined}
                className={fieldClassName}
              />
              {errors.data_vencimento ? (
                <p className={errorClassName}>{errors.data_vencimento.message}</p>
              ) : (
                <p className={helperClassName}>
                  Mantenha a data de renovação correta para alertas e bloqueios de conformidade.
                </p>
              )}
            </div>

            <div className="space-y-2 md:col-span-2">
              <label htmlFor="certificado_url" className={labelClassName}>
                URL do Certificado (Opcional)
              </label>
              <input
                id="certificado_url"
                type="url"
                {...register('certificado_url')}
                className={fieldClassName}
                placeholder="https://..."
              />
              <p className={helperClassName}>
                Use quando o certificado estiver publicado em repositório externo ou storage corporativo.
              </p>
            </div>
          </div>
        </section>

        <AuditSection
          register={register}
          auditors={users.filter((u) => u.role === 'admin' || u.role === 'manager')}
          disabled={!selectedCompanyId}
        />

        <div className="flex flex-col-reverse gap-3 border-t border-[var(--ds-color-border-subtle)] pt-6 md:flex-row md:justify-end">
          <Link
            href="/dashboard/trainings"
            className="inline-flex items-center justify-center rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] px-4 py-2.5 text-sm font-semibold text-[var(--ds-color-text-secondary)] hover:bg-[var(--ds-color-surface-muted)]"
          >
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center justify-center rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--ds-color-action-primary-foreground)] transition-colors hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50"
          >
            {loading ? (
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-[var(--ds-color-action-primary-foreground)] border-t-transparent"></div>
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {id ? 'Salvar alterações' : 'Registrar treinamento'}
          </button>
        </div>
      </form>

      <SignatureModal
        isOpen={isSignatureModalOpen}
        onClose={() => setIsSignatureModalOpen(false)}
        onSave={handleSaveSignature}
        userName={currentSigningUser?.nome || 'Colaborador'}
      />
    </div>
  );
}
