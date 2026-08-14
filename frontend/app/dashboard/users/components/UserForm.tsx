'use client';

import { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usersService, UserIdentityType } from '@/services/usersService';
import { companiesService, Company } from '@/services/companiesService';
import { profilesService, Profile } from '@/services/profilesService';
import { sitesService, Site } from '@/services/sitesService';
import { useAuth } from '@/context/AuthContext';
import { handleApiError } from '@/lib/error-handler';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';
import { useFormSubmit } from '@/hooks/useFormSubmit';
import { Button } from '@/components/ui/button';
import { InlineLoadingState } from '@/components/ui/state';
import { StatusPill } from '@/components/ui/status-pill';
import { PageHeader } from '@/components/layout';

const fieldClassName =
  'w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2.5 text-sm text-[var(--ds-color-text-primary)] motion-safe:transition-all motion-safe:duration-[var(--ds-motion-base)] focus:border-[var(--ds-color-action-primary)] focus:outline-none focus:shadow-[var(--ds-shadow-sm)] disabled:cursor-not-allowed disabled:bg-[var(--ds-color-surface-muted)] disabled:text-[var(--ds-color-text-muted)]';
const labelClassName = 'text-sm font-medium text-[var(--ds-color-text-secondary)]';
const helperClassName = 'text-xs text-[var(--ds-color-text-muted)]';
const errorClassName = 'text-xs text-[var(--ds-color-danger)]';
const sectionCardClassName =
  'rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-5 shadow-[var(--ds-shadow-xs)]';

const userSchema = z.object({
  nome: z.string().min(3, 'O nome deve ter pelo menos 3 caracteres'),
  email: z.string().refine((val) => val === '' || z.string().email().safeParse(val).success, {
    message: 'Email inválido',
  }),
  cpf: z
    .string()
    .min(11, 'CPF inválido')
    .refine(
      (val) => {
        const digits = val.replace(/\D/g, '');
        if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
        let sum = 0;
        for (let i = 0; i < 9; i++) sum += parseInt(digits.charAt(i)) * (10 - i);
        let rem = (sum * 10) % 11;
        if (rem === 10 || rem === 11) rem = 0;
        if (rem !== parseInt(digits.charAt(9))) return false;
        sum = 0;
        for (let i = 0; i < 10; i++) sum += parseInt(digits.charAt(i)) * (11 - i);
        rem = (sum * 10) % 11;
        if (rem === 10 || rem === 11) rem = 0;
        return rem === parseInt(digits.charAt(10));
      },
      { message: 'CPF inválido' },
    ),
  funcao: z.string().min(2, 'A função é obrigatória'),
  role: z.string().optional().or(z.literal('')),
  company_id: z.string().min(1, 'Selecione uma empresa'),
  site_id: z.string().optional().or(z.literal('')),
  site_ids: z.array(z.string()).optional(),
  profile_id: z.string().optional().or(z.literal('')),
  identity_type: z
    .enum([UserIdentityType.SYSTEM_USER, UserIdentityType.EMPLOYEE_SIGNER])
    .optional(),
  password: z
    .string()
    .min(8, 'A senha deve ter pelo menos 8 caracteres')
    .optional()
    .or(z.literal('')),
});

type UserFormData = z.infer<typeof userSchema>;

interface UserFormProps {
  id?: string;
}

export function UserForm({ id }: UserFormProps) {
  const router = useRouter();
  const [fetching, setFetching] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const { user, isAdminGeral } = useAuth();
  const isAdminGeneral = isAdminGeral || user?.profile?.nome === 'Administrador Geral';
  const canSelectCompany = isAdminGeneral;

  const isEmployeePath =
    typeof window !== 'undefined' && window.location.pathname.includes('/employees');
  const backPath = isEmployeePath ? '/dashboard/employees' : '/dashboard/users';

  const {
    register,
    handleSubmit: formSubmit,
    reset,
    control,
    setValue,
    formState: { errors },
  } = useForm<UserFormData>({
    resolver: zodResolver(userSchema),
    defaultValues: {
      nome: '',
      email: '',
      cpf: '',
      funcao: '',
      role: '',
      company_id: '',
      site_id: '',
      site_ids: [],
      profile_id: '',
      identity_type: isEmployeePath
        ? UserIdentityType.EMPLOYEE_SIGNER
        : UserIdentityType.SYSTEM_USER,
      password: '',
    },
  });

  const selectedCompanyId = useWatch({
    control,
    name: 'company_id',
  });
  const selectedSiteIdsRaw = useWatch({
    control,
    name: 'site_ids',
  });
  const selectedSiteIds = useMemo(() => selectedSiteIdsRaw ?? [], [selectedSiteIdsRaw]);
  const sessionCompanyId = user?.company_id || companies[0]?.id || '';
  const effectiveCompanyId = selectedCompanyId || sessionCompanyId;

  const { handleSubmit: onSubmit, loading } = useFormSubmit(
    async (data: UserFormData) => {
      const payload: Record<string, unknown> = {
        ...data,
        company_id: data.company_id || effectiveCompanyId,
        cpf: data.cpf.replace(/\D/g, ''),
        identity_type:
          data.identity_type ||
          (isEmployeePath ? UserIdentityType.EMPLOYEE_SIGNER : UserIdentityType.SYSTEM_USER),
      };

      if (isEmployeePath && !id) {
        const colaboradorProfile = profiles.find((p) => p.nome === 'Operador / Colaborador');
        if (colaboradorProfile) {
          payload.profile_id = colaboradorProfile.id;
        }
      }

      // Cleanup payload
      if (payload.email === '') delete payload.email;
      delete payload.role;
      const selectedSiteIdsPayload = Array.isArray(data.site_ids)
        ? data.site_ids.filter(Boolean)
        : [];
      payload.site_ids = selectedSiteIdsPayload;
      payload.site_id = selectedSiteIdsPayload[0] || null;
      if (payload.profile_id === '') delete payload.profile_id;
      if (!payload.password) delete payload.password;

      if (id) {
        // O endpoint de detalhes (PATCH /users/:id) usa UpdateUserDetailsDto, que NÃO
        // aceita profile_id — a troca de perfil tem fluxo próprio protegido por MFA em
        // PATCH /users/:id/role. Como o ValidationPipe global roda com
        // forbidNonWhitelisted, enviar profile_id aqui derruba o save inteiro com
        // 400 "dados inválidos" (inclusive ao apenas adicionar/remover uma obra).
        // profile_id só é enviado na criação.
        delete payload.profile_id;
        await usersService.update(id, payload);
      } else {
        if (!isEmployeePath && !payload.password && !payload.email) {
          throw new Error(
            'Informe um e-mail (para enviar as credenciais) ou defina uma senha.',
          );
        }
        if (!isEmployeePath && !payload.profile_id) {
          throw new Error('Selecione um perfil de acesso.');
        }
        await usersService.create(payload);
      }
    },
    {
      successMessage: (result) => {
        if (id) return `${isEmployeePath ? 'Funcionário' : 'Usuário'} atualizado com sucesso!`;
        const created = result as { must_change_password?: boolean } | undefined;
        if (!isEmployeePath && created?.must_change_password) {
          return 'Usuário cadastrado! As credenciais de acesso foram enviadas por e-mail.';
        }
        return `${isEmployeePath ? 'Funcionário' : 'Usuário'} cadastrado com sucesso!`;
      },
      redirectTo: backPath,
      context: isEmployeePath ? 'Funcionário' : 'Usuário',
    },
  );

  useEffect(() => {
    async function loadData() {
      try {
        const [profilesData, userData] = await Promise.all([
          profilesService.findAll(),
          id ? usersService.findOne(id) : Promise.resolve(null),
        ]);
        setProfiles(profilesData);

        const selectedCompanyId = userData?.company_id || user?.company_id || '';
        let companiesData: Company[] = [];

        if (isAdminGeneral) {
          try {
            const companiesPage = await companiesService.findPaginated({
              page: 1,
              limit: 100,
            });
            companiesData = companiesPage.data;
          } catch {
            // sem permissão para listar todas as empresas — seguir com lista vazia
          }
          if (
            selectedCompanyId &&
            !companiesData.some((company) => company.id === selectedCompanyId)
          ) {
            try {
              const selectedCompany = await companiesService.findOne(selectedCompanyId);
              companiesData = dedupeById([selectedCompany, ...companiesData]);
            } catch {
              companiesData = dedupeById(companiesData);
            }
          }
        } else if (selectedCompanyId) {
          try {
            const selectedCompany = await companiesService.findOne(selectedCompanyId);
            companiesData = [selectedCompany];
          } catch {
            companiesData = [];
          }
        }

        setCompanies(dedupeById(companiesData));

        if (userData) {
          reset({
            nome: userData.nome,
            email: userData.email,
            cpf: userData.cpf || '',
            funcao: userData.funcao || '',
            role: userData.role,
            company_id: userData.company_id,
            site_id: userData.site_id || '',
            site_ids: userData.site_ids?.length
              ? userData.site_ids
              : userData.site_id
                ? [userData.site_id]
                : [],
            profile_id: userData.profile_id,
            identity_type:
              userData.identity_type ||
              (isEmployeePath ? UserIdentityType.EMPLOYEE_SIGNER : UserIdentityType.SYSTEM_USER),
          });
        }
      } catch (error) {
        handleApiError(error, 'Formulário');
        router.push(backPath);
      } finally {
        setFetching(false);
      }
    }

    loadData();
  }, [id, reset, router, backPath, isAdminGeneral, isEmployeePath, user?.company_id]);

  useEffect(() => {
    async function loadSites() {
      if (!effectiveCompanyId) {
        setSites([]);
        return;
      }
      try {
        const sitesPage = await sitesService.findPaginated({
          page: 1,
          limit: 100,
          companyId: effectiveCompanyId,
        });
        let nextSites = sitesPage.data;
        if (
          selectedSiteIds.length > 0 &&
          selectedSiteIds.some((siteId) => !nextSites.some((site) => site.id === siteId))
        ) {
          try {
            const selectedSites = await Promise.all(
              selectedSiteIds
                .filter((siteId) => !nextSites.some((site) => site.id === siteId))
                .map((siteId) => sitesService.findOne(siteId)),
            );
            nextSites = dedupeById([...selectedSites, ...nextSites]);
          } catch {
            nextSites = dedupeById(nextSites);
          }
        } else {
          nextSites = dedupeById(nextSites);
        }
        setSites(nextSites);
      } catch (error) {
        handleApiError(error, 'Obras');
        setSites([]);
      }
    }
    loadSites();
  }, [effectiveCompanyId, selectedSiteIds]);

  useEffect(() => {
    if (!id && !selectedCompanyId && sessionCompanyId) {
      setValue('company_id', sessionCompanyId, {
        shouldDirty: false,
        shouldValidate: true,
      });
    }
  }, [id, selectedCompanyId, sessionCompanyId, setValue]);

  return (
    <div className="ds-form-page mx-auto max-w-2xl space-y-6">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState label={id ? 'Carregando cadastro...' : 'Preparando cadastro...'} />
        </div>
      ) : null}

      {!fetching ? (
        <>
          <PageHeader
            eyebrow={isEmployeePath ? 'Cadastro de funcionários' : 'Gestão de usuários'}
            title={
              id
                ? `Editar ${isEmployeePath ? 'funcionário' : 'usuário'}`
                : `Novo ${isEmployeePath ? 'funcionário' : 'usuário'}`
            }
            description={
              isEmployeePath
                ? 'Estruture identificação, vínculo com empresa e lotação operacional em um fluxo curto.'
                : 'Defina identidade, vínculo organizacional e permissões de acesso com clareza.'
            }
            icon={
              <Link
                href={backPath}
                aria-label="Voltar para a listagem"
                className="rounded-full p-2 text-[var(--ds-color-text-muted)] motion-safe:transition-colors hover:bg-[var(--ds-color-primary-subtle)] hover:text-[var(--ds-color-text-secondary)]"
                title="Voltar"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
            }
            actions={
              <div className="flex flex-wrap gap-2">
                <StatusPill tone={isEmployeePath ? 'info' : 'primary'}>
                  {isEmployeePath ? 'Funcionário' : 'Usuário'}
                </StatusPill>
                <StatusPill tone={id ? 'warning' : 'success'}>
                  {id ? 'Edição' : 'Novo cadastro'}
                </StatusPill>
              </div>
            }
          />
          <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/22 px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ds-color-text-secondary)]">
              Cadastro guiado
            </p>
            <p className="mt-2 text-sm font-semibold text-[var(--ds-color-text-primary)]">
              {isEmployeePath
                ? 'Dados essenciais do funcionário e lotação operacional.'
                : 'Identidade, vínculo organizacional e acesso em um único fluxo.'}
            </p>
            <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
              {canSelectCompany
                ? 'Revise empresa, obra e perfil antes de salvar para evitar retrabalho de acesso.'
                : 'Selecione a obra/setor quando o cadastro precisar de lotação operacional.'}
            </p>
          </div>

          <form
            onSubmit={formSubmit(onSubmit)}
            className="space-y-5 rounded-xl border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]"
          >
            {!canSelectCompany ? <input type="hidden" {...register('company_id')} /> : null}
            <input type="hidden" {...register('identity_type')} />
            <section className={sectionCardClassName}>
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                  Identificação
                </p>
                <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                  Informações básicas para localizar e reconhecer rapidamente o cadastro.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <label htmlFor="nome" className={labelClassName}>
                    Nome Completo
                  </label>
                  <input
                    id="nome"
                    type="text"
                    {...register('nome')}
                    aria-invalid={errors.nome ? 'true' : undefined}
                    className={fieldClassName}
                    placeholder="Nome do usuário"
                  />
                  {errors.nome && <p className={errorClassName}>{errors.nome.message}</p>}
                </div>

                {!isEmployeePath && (
                  <div className="space-y-2">
                    <label htmlFor="email" className={labelClassName}>
                      E-mail
                    </label>
                    <input
                      id="email"
                      type="text"
                      autoComplete="email"
                      inputMode="email"
                      {...register('email')}
                      aria-invalid={errors.email ? 'true' : undefined}
                      className={fieldClassName}
                      placeholder="email@exemplo.com"
                    />
                    {errors.email && <p className={errorClassName}>{errors.email.message}</p>}
                  </div>
                )}

                <div className="space-y-2">
                  <label htmlFor="cpf" className={labelClassName}>
                    CPF
                  </label>
                  <input
                    id="cpf"
                    type="text"
                    {...register('cpf')}
                    aria-invalid={errors.cpf ? 'true' : undefined}
                    className={fieldClassName}
                    placeholder="000.000.000-00"
                  />
                  {errors.cpf ? (
                    <p className={errorClassName}>{errors.cpf.message}</p>
                  ) : (
                    <p className={helperClassName}>
                      Use um CPF válido para evitar duplicidade de cadastro.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <label htmlFor="funcao" className={labelClassName}>
                    Função
                  </label>
                  <input
                    id="funcao"
                    type="text"
                    {...register('funcao')}
                    aria-invalid={errors.funcao ? 'true' : undefined}
                    className={fieldClassName}
                    placeholder="Ex: Engenheiro de Segurança"
                  />
                  {!errors.funcao ? (
                    <p className={helperClassName}>
                      Descreva a função principal exercida na operação ou no sistema.
                    </p>
                  ) : null}
                </div>
              </div>
            </section>

            <section className={sectionCardClassName}>
              <div className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                  Vínculo e acesso
                </p>
                <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                  {canSelectCompany
                    ? 'Defina empresa, obra e perfil para posicionar corretamente o cadastro no tenant.'
                    : 'A empresa vem da sua sessão; defina apenas a obra/setor quando aplicável.'}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {!isEmployeePath && (
                  <div className="space-y-2">
                    <label htmlFor="role" className={labelClassName}>
                      Regra (Role)
                    </label>
                    <select
                      id="role"
                      {...register('role')}
                      aria-label="Regra de acesso"
                      className={fieldClassName}
                    >
                      <option value="">Selecione uma regra</option>
                      <option value="admin">Administrador</option>
                      <option value="user">Usuário</option>
                      <option value="manager">Gerente</option>
                    </select>
                    <p className={helperClassName}>
                      Use a regra apenas quando houver necessidade de diferenciação operacional.
                    </p>
                  </div>
                )}

                {canSelectCompany ? (
                  <div className="space-y-2">
                    <label htmlFor="company_id" className={labelClassName}>
                      Empresa
                    </label>
                    <select
                      id="company_id"
                      {...register('company_id', {
                        onChange: (e) => {
                          setValue('company_id', e.target.value);
                          setValue('site_id', '');
                          setValue('site_ids', []);
                        },
                      })}
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
                      <p className={helperClassName}>
                        A empresa define obras disponíveis e escopo de acesso.
                      </p>
                    )}
                  </div>
                ) : null}

                <div className="space-y-2">
                  <span className={labelClassName}>Obras/Setores</span>
                  <input type="hidden" {...register('site_id')} />
                  <div className="max-h-48 overflow-y-auto rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-2">
                    {sites.length === 0 ? (
                      <p className={helperClassName}>
                        Nenhuma obra disponível para a empresa selecionada.
                      </p>
                    ) : (
                      sites.map((site) => {
                        const checked = selectedSiteIds.includes(site.id);
                        return (
                          <label
                            key={site.id}
                            className="flex items-center gap-2 rounded-[var(--ds-radius-sm)] px-2 py-1.5 text-sm text-[var(--ds-color-text-primary)] hover:bg-[var(--ds-color-surface-muted)]"
                          >
                            <input
                              type="checkbox"
                              value={site.id}
                              checked={checked}
                              disabled={!effectiveCompanyId}
                              onChange={(event) => {
                                const next = event.target.checked
                                  ? [...selectedSiteIds, site.id]
                                  : selectedSiteIds.filter((id) => id !== site.id);
                                setValue('site_ids', next, {
                                  shouldDirty: true,
                                  shouldValidate: true,
                                });
                                setValue('site_id', next[0] || '', {
                                  shouldDirty: true,
                                  shouldValidate: true,
                                });
                              }}
                            />
                            <span>{site.nome}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                  {!effectiveCompanyId ? (
                    <p className={helperClassName}>
                      Não foi possível identificar a empresa da sessão.
                    </p>
                  ) : (
                    <p className={helperClassName}>
                      Marque todas as obras em que este usuário pode atuar.
                    </p>
                  )}
                </div>

                {!isEmployeePath && (
                  <div className="space-y-2">
                    <label htmlFor="profile_id" className={labelClassName}>
                      Perfil de Acesso
                    </label>
                    <select
                      id="profile_id"
                      {...register('profile_id')}
                      aria-label="Perfil de acesso"
                      className={fieldClassName}
                    >
                      <option value="">Selecione um perfil</option>
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.nome}
                        </option>
                      ))}
                    </select>
                    <p className={helperClassName}>
                      O perfil controla permissões de tela, ações e governança de acesso.
                    </p>
                  </div>
                )}
              </div>
            </section>

            {!isEmployeePath && (
              <section className={sectionCardClassName}>
                <div className="mb-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ds-color-text-secondary)]">
                    Credenciais
                  </p>
                  <p className="mt-1 text-sm text-[var(--ds-color-text-secondary)]">
                    {id
                      ? 'Em edição, deixe vazio para preservar a senha atual.'
                      : 'Opcional: defina a senha inicial aqui, ou deixe em branco e informe um e-mail acima — o sistema gera uma senha temporária e envia por e-mail, com troca obrigatória no primeiro acesso.'}
                  </p>
                </div>
                <div className="space-y-2">
                  <label htmlFor="password" className={labelClassName}>
                    Senha {id ? '(deixe em branco para não alterar)' : '(opcional)'}
                  </label>
                  <input
                    id="password"
                    type="password"
                    {...register('password')}
                    aria-invalid={errors.password ? 'true' : undefined}
                    className={fieldClassName}
                    placeholder="******"
                  />
                  {errors.password ? (
                    <p className={errorClassName}>{errors.password.message}</p>
                  ) : (
                    <p className={helperClassName}>
                      {id
                        ? 'Use pelo menos 8 caracteres, com maiúsculas, minúsculas, números e símbolos.'
                        : 'Deixe em branco para enviar as credenciais por e-mail. Se preenchida, use pelo menos 8 caracteres, com maiúsculas, minúsculas, números e símbolos.'}
                    </p>
                  )}
                </div>
              </section>
            )}

            <div className="flex justify-end space-x-4 border-t pt-6">
              <Button type="button" variant="outline" onClick={() => router.push(backPath)}>
                Cancelar
              </Button>
              <Button type="submit" loading={loading} leftIcon={<Save className="h-4 w-4" />}>
                {id ? 'Salvar alterações' : isEmployeePath ? 'Criar funcionário' : 'Criar usuário'}
              </Button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}
