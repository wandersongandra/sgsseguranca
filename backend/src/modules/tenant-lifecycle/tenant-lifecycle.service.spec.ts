/* eslint-disable @typescript-eslint/no-unsafe-assignment -- os matchers
   assimétricos do Jest (`expect.any`, `expect.stringContaining`) são tipados
   como `any`; anotar cada um dispara `no-unnecessary-type-assertion`, então as
   duas regras se anulam. Mesmo padrão já adotado em auth.service.spec.ts. */
import type { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Company } from '../companies/entities/company.entity';
import type { CompaniesService } from '../companies/companies.service';
import type { MailService } from '../../infra/mail/mail.service';
import type { PasswordService } from '../../shared/services/password.service';
import type { ProvisioningDataSourceService } from '../../shared/database/provisioning-datasource.service';
import { Profile } from '../profiles/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Role } from '../auth/enums/roles.enum';
import { TenantOnboardingInvite } from './entities/tenant-onboarding-invite.entity';
import { TenantLifecycleService } from './tenant-lifecycle.service';

type TestManager = {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
};

describe('TenantLifecycleService', () => {
  const originalEncryptionEnv = {
    FIELD_ENCRYPTION_ENABLED: process.env.FIELD_ENCRYPTION_ENABLED,
    FIELD_ENCRYPTION_KEY: process.env.FIELD_ENCRYPTION_KEY,
    FIELD_ENCRYPTION_HASH_KEY: process.env.FIELD_ENCRYPTION_HASH_KEY,
  };

  const savedEntities: Record<string, unknown>[] = [];

  /**
   * Manager compartilhado por todos os testes. `findOne` é reprogramado por
   * teste; o default devolve null para tudo.
   */
  const manager: TestManager = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn(
      (_entity: unknown, input: Record<string, unknown>) => input,
    ),
    save: jest.fn((input: Record<string, unknown>) => {
      const entity = {
        id:
          input.id ??
          (input.razao_social
            ? 'company-1'
            : input.local
              ? 'site-1'
              : input.token_hash
                ? 'invite-1'
                : input.user_id && input.site_id
                  ? 'user-site-1'
                  : 'saved-1'),
        ...input,
      };
      savedEntities.push(entity);
      return Promise.resolve(entity);
    }),
  };

  const provisioningDataSource = {
    isDedicated: jest.fn(() => true),
    transaction: jest.fn((callback: (m: unknown) => unknown) =>
      Promise.resolve(callback(manager)),
    ),
  };

  const configService = {
    get: jest.fn((key: string): string | undefined =>
      key === 'FRONTEND_URL' ? 'https://app.sgs.test' : undefined,
    ),
  };

  const mailService = { sendMailSimple: jest.fn() };

  const passwordService = {
    validate: jest.fn((): { valid: boolean; errors: string[] } => ({
      valid: true,
      errors: [],
    })),
    hash: jest.fn(() => Promise.resolve('hashed-password')),
  };

  const companiesService = { ensureDefaultDdsThemeLibrary: jest.fn() };

  const onboardingDto = {
    razao_social: 'Cliente SGS LTDA',
    cnpj: '11222333000181',
    endereco: 'Rua Principal, 100',
    responsavel: 'Maria Cliente',
    email_contato: 'contato@cliente.test',
    admin_nome: 'Admin Cliente',
    admin_cpf: '52998224725',
    admin_email: 'admin@cliente.test',
    admin_password: 'SenhaForte123!',
    termsAccepted: true as const,
  };

  const inviteValido = (): Partial<TenantOnboardingInvite> => ({
    id: 'invite-1',
    email: 'admin@cliente.test',
    expires_at: new Date(Date.now() + 86_400_000),
    used_at: null,
    revoked_at: null,
  });

  /** Programa o manager para o caminho feliz de provisionamento. */
  const programarOnboarding = (invite: Partial<TenantOnboardingInvite>) => {
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === TenantOnboardingInvite) return Promise.resolve(invite);
      if (entity === Company || entity === User) return Promise.resolve(null);
      if (entity === Profile) {
        return Promise.resolve({
          id: 'profile-admin',
          nome: Role.ADMIN_EMPRESA,
        });
      }
      return Promise.resolve(null);
    });
  };

  let service: TenantLifecycleService;

  beforeEach(() => {
    jest.clearAllMocks();
    savedEntities.length = 0;
    manager.findOne.mockImplementation(() => Promise.resolve(null));
    manager.create.mockImplementation(
      (_entity: unknown, input: Record<string, unknown>) => input,
    );
    provisioningDataSource.transaction.mockImplementation(
      (callback: (m: unknown) => unknown) => Promise.resolve(callback(manager)),
    );
    mailService.sendMailSimple.mockResolvedValue({});
    companiesService.ensureDefaultDdsThemeLibrary.mockResolvedValue(undefined);
    passwordService.validate.mockReturnValue({ valid: true, errors: [] });

    process.env.FIELD_ENCRYPTION_ENABLED = 'true';
    process.env.FIELD_ENCRYPTION_KEY = 'tenant-lifecycle-test-key-123456';
    process.env.FIELD_ENCRYPTION_HASH_KEY =
      'tenant-lifecycle-test-hash-key-123456';

    service = new TenantLifecycleService(
      provisioningDataSource as unknown as ProvisioningDataSourceService,
      configService as unknown as ConfigService,
      mailService as unknown as MailService,
      passwordService as unknown as PasswordService,
      companiesService as unknown as CompaniesService,
    );
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEncryptionEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /**
   * Trava de regressão do defeito que originou esta refatoração.
   *
   * As quatro rotas deste módulo operam sobre `tenant_onboarding_invites`, cujas
   * políticas de RLS exigem `current_company()` (inexistente antes da empresa
   * nascer) ou `is_super_admin()` (inerte na conexão de runtime desde a
   * migration 361). Qualquer uma delas que volte a usar a conexão comum passa a
   * falhar em produção **sem erro** — só devolvendo "não encontrado". Se um
   * destes testes quebrar, é isso que está acontecendo.
   */
  describe('todas as operações passam pela conexão de provisionamento', () => {
    it('createInvite', async () => {
      await service.createInvite({ email: 'cliente@sgs.test' });
      expect(provisioningDataSource.transaction).toHaveBeenCalled();
    });

    it('getInvitePublicView', async () => {
      manager.findOne.mockResolvedValue(inviteValido());
      await service.getInvitePublicView('token-1');
      expect(provisioningDataSource.transaction).toHaveBeenCalled();
    });

    it('completeOnboarding', async () => {
      programarOnboarding(inviteValido());
      await service.completeOnboarding('token-1', onboardingDto);
      expect(provisioningDataSource.transaction).toHaveBeenCalled();
    });

    it('revokeInvite', async () => {
      manager.findOne.mockResolvedValue(inviteValido());
      await service.revokeInvite('invite-1');
      expect(provisioningDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe('createInvite', () => {
    it('cria convite com URL pública de onboarding', async () => {
      const result = await service.createInvite({
        email: 'cliente@sgs.test',
        intended_company_name: 'Cliente SGS',
        expiresInDays: 7,
      });

      expect(result).toEqual(
        expect.objectContaining({
          id: 'invite-1',
          email: 'cliente@sgs.test',
          intended_company_name: 'Cliente SGS',
        }),
      );
      expect(result.onboarding_url).toMatch(
        /^https:\/\/app\.sgs\.test\/onboarding\/[A-Za-z0-9_-]+$/,
      );
    });

    it('normaliza o e-mail e nunca persiste o token em claro', async () => {
      await service.createInvite({ email: '  Cliente@SGS.Test  ' });

      const persistido = savedEntities.at(-1)!;
      expect(persistido.email).toBe('cliente@sgs.test');
      expect(persistido.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(persistido).not.toHaveProperty('token');
    });

    it('envia o e-mail de convite com o prazo de teste configurado', async () => {
      // O texto dizia "30 dias" fixo; agora acompanha TRIAL_DAYS_DEFAULT.
      configService.get.mockImplementation((key: string) => {
        if (key === 'FRONTEND_URL') return 'https://app.sgs.test';
        if (key === 'TRIAL_DAYS_DEFAULT') return '21';
        return undefined;
      });

      await service.createInvite({ email: 'cliente@sgs.test' });

      expect(mailService.sendMailSimple).toHaveBeenCalledWith(
        'cliente@sgs.test',
        'Convite para teste do SGS',
        expect.stringContaining('/onboarding/'),
        undefined,
        undefined,
        expect.objectContaining({
          filename: 'tenant-onboarding-invite',
          html: expect.stringContaining('21 dias de teste'),
        }),
      );

      configService.get.mockImplementation((key: string) =>
        key === 'FRONTEND_URL' ? 'https://app.sgs.test' : undefined,
      );
    });

    it('não deixa a falha no envio do e-mail derrubar a criação do convite', async () => {
      mailService.sendMailSimple.mockRejectedValueOnce(new Error('SMTP fora'));
      await expect(
        service.createInvite({ email: 'cliente@sgs.test' }),
      ).resolves.toEqual(expect.objectContaining({ id: 'invite-1' }));
    });
  });

  describe('getInvitePublicView', () => {
    it('devolve os dados públicos do convite', async () => {
      const invite = inviteValido();
      manager.findOne.mockResolvedValue(invite);

      await expect(service.getInvitePublicView('token-1')).resolves.toEqual({
        email: 'admin@cliente.test',
        intended_company_name: null,
        expires_at: invite.expires_at,
      });
    });

    it('nunca expõe o hash do token', async () => {
      manager.findOne.mockResolvedValue({
        ...inviteValido(),
        token_hash: 'a'.repeat(64),
      });
      const view = await service.getInvitePublicView('token-1');
      expect(view).not.toHaveProperty('token_hash');
    });

    it('recusa convite expirado', async () => {
      manager.findOne.mockResolvedValue({
        ...inviteValido(),
        expires_at: new Date(Date.now() - 1_000),
      });
      await expect(service.getInvitePublicView('token-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('recusa token inexistente', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.getInvitePublicView('token-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('completeOnboarding', () => {
    it('cria empresa em trial, obra geral, admin e vínculo de obra', async () => {
      const invite = inviteValido();
      programarOnboarding(invite);

      const result = await service.completeOnboarding('token-1', onboardingDto);

      expect(result.company_id).toBe('company-1');
      expect(result.user_id).toEqual(expect.any(String));
      expect(invite.used_at).toBeInstanceOf(Date);
      expect(invite.created_company_id).toBe('company-1');
      expect(savedEntities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            razao_social: 'Cliente SGS LTDA',
            account_status: 'trialing',
            status: true,
          }),
          expect.objectContaining({
            nome: 'Geral',
            company_id: 'company-1',
            status: true,
          }),
          expect.objectContaining({
            nome: 'Admin Cliente',
            email: 'admin@cliente.test',
            cpf: null,
            profile_id: 'profile-admin',
            funcao: 'Administrador da Empresa',
          }),
          expect.objectContaining({
            user_id: expect.any(String),
            company_id: 'company-1',
            site_id: 'site-1',
          }),
        ]),
      );
    });

    it('honra TRIAL_DAYS_DEFAULT no cálculo de trial_ends_at', async () => {
      configService.get.mockImplementation((key: string) =>
        key === 'TRIAL_DAYS_DEFAULT' ? '21' : undefined,
      );
      programarOnboarding(inviteValido());

      const antes = Date.now();
      const result = await service.completeOnboarding('token-1', onboardingDto);
      const dias = Math.round(
        (result.trial_ends_at.getTime() - antes) / 86_400_000,
      );

      expect(dias).toBe(21);

      configService.get.mockImplementation((key: string) =>
        key === 'FRONTEND_URL' ? 'https://app.sgs.test' : undefined,
      );
    });

    it('nunca grava o CPF em claro — só hash e ciphertext', async () => {
      programarOnboarding(inviteValido());
      await service.completeOnboarding('token-1', onboardingDto);

      const admin = savedEntities.find((e) => e.nome === 'Admin Cliente')!;
      expect(admin.cpf).toBeNull();
      expect(admin.cpf_hash).toEqual(expect.any(String));
      expect(admin.cpf_ciphertext).toEqual(expect.any(String));
      expect(JSON.stringify(admin)).not.toContain('52998224725');
    });

    it('nunca grava a senha em claro', async () => {
      programarOnboarding(inviteValido());
      await service.completeOnboarding('token-1', onboardingDto);

      const admin = savedEntities.find((e) => e.nome === 'Admin Cliente')!;
      expect(admin.password).toBe('hashed-password');
      expect(JSON.stringify(admin)).not.toContain('SenhaForte123!');
    });

    it('exige que o e-mail do admin seja o mesmo do convite', async () => {
      programarOnboarding({ ...inviteValido(), email: 'outro@cliente.test' });

      await expect(
        service.completeOnboarding('token-1', onboardingDto),
      ).rejects.toThrow(/mesmo do convite/i);
      expect(savedEntities).toHaveLength(0);
    });

    it('recusa convite expirado sem criar nada', async () => {
      programarOnboarding({
        ...inviteValido(),
        expires_at: new Date(Date.now() - 1_000),
      });

      await expect(
        service.completeOnboarding('token-1', onboardingDto),
      ).rejects.toThrow(NotFoundException);
      expect(savedEntities).toHaveLength(0);
    });

    it('recusa senha fraca antes de abrir a transação', async () => {
      passwordService.validate.mockReturnValueOnce({
        valid: false,
        errors: ['muito curta'],
      });

      await expect(
        service.completeOnboarding('token-1', onboardingDto),
      ).rejects.toThrow(BadRequestException);
      expect(provisioningDataSource.transaction).not.toHaveBeenCalled();
    });

    it('recusa CNPJ já cadastrado', async () => {
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === TenantOnboardingInvite) {
          return Promise.resolve(inviteValido());
        }
        if (entity === Company) return Promise.resolve({ id: 'company-x' });
        return Promise.resolve(null);
      });

      await expect(
        service.completeOnboarding('token-1', onboardingDto),
      ).rejects.toThrow(/CNPJ já cadastrado/i);
    });

    it('recusa administrador já cadastrado', async () => {
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === TenantOnboardingInvite) {
          return Promise.resolve(inviteValido());
        }
        if (entity === User) return Promise.resolve({ id: 'user-x' });
        return Promise.resolve(null);
      });

      await expect(
        service.completeOnboarding('token-1', onboardingDto),
      ).rejects.toThrow(/Administrador já cadastrado/i);
    });

    it('semeia os temas de DDS no MESMO contexto privilegiado', async () => {
      // Rodar o seed na conexão de runtime era um no-op silencioso: a
      // requisição é pública e não tem tenant, então nada era lido nem gravado
      // e a empresa nova nascia sem biblioteca de temas.
      programarOnboarding(inviteValido());
      await service.completeOnboarding('token-1', onboardingDto);

      expect(
        companiesService.ensureDefaultDdsThemeLibrary,
      ).toHaveBeenCalledWith('company-1', manager as unknown as EntityManager);
    });

    it('não derruba o onboarding quando o seed de temas falha', async () => {
      programarOnboarding(inviteValido());
      companiesService.ensureDefaultDdsThemeLibrary.mockRejectedValueOnce(
        new Error('seed falhou'),
      );

      await expect(
        service.completeOnboarding('token-1', onboardingDto),
      ).resolves.toEqual(expect.objectContaining({ company_id: 'company-1' }));
    });
  });

  describe('revokeInvite', () => {
    it('revoga convite pendente', async () => {
      manager.findOne.mockResolvedValue(inviteValido());

      const result = await service.revokeInvite('invite-1');

      expect(result.id).toBe('invite-1');
      expect(result.revoked_at).toBeInstanceOf(Date);
    });

    it('recusa convite inexistente', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.revokeInvite('invite-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('recusa convite já utilizado', async () => {
      manager.findOne.mockResolvedValue({
        ...inviteValido(),
        used_at: new Date(),
      });
      await expect(service.revokeInvite('invite-1')).rejects.toThrow(
        /já utilizado/i,
      );
    });

    it('recusa convite já revogado', async () => {
      manager.findOne.mockResolvedValue({
        ...inviteValido(),
        revoked_at: new Date(),
      });
      await expect(service.revokeInvite('invite-1')).rejects.toThrow(
        /já foi revogado/i,
      );
    });
  });
});
