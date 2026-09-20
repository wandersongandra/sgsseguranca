import { createHash } from 'node:crypto';
import type { Repository } from 'typeorm';
import { Dds, DdsStatus } from './entities/dds.entity';
import { DdsSignatureInvite } from './entities/dds-signature-invite.entity';
import { DdsSignatureInviteService } from './dds-signature-invite.service';
import { signValidationToken } from '../../shared/security/validation-token.util';
import type { MailService } from '../../infra/mail/mail.service';
import type { TurnstileService } from '../auth/turnstile.service';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { SignaturesService } from '../signatures/signatures.service';
import type { ConfigService } from '@nestjs/config';

const TEST_SECRET = 'test-validation-token-secret-0123456789abcdef';
const TEST_COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TEST_DDS_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const TEST_INVITE_ID = 'cccccccc-0000-0000-0000-000000000001';
const DDS_PUBLIC_SIGNATURE_PORTAL = 'dds_public_signature';
const BASE_URL = 'https://app.sgs.test';
const SIGNING_URL_PREFIX = BASE_URL + '/assinar/dds/';
const EXPIRY_FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

type MailContextMock = { companyId?: string; userId?: string };
type SendMailSimpleMock = jest.Mock<
  Promise<Record<string, never>>,
  [string, string, string, MailContextMock?]
>;

function makeTestToken(overrides?: {
  inviteId?: string;
  ddsId?: string;
  companyId?: string;
}): string {
  return signValidationToken(
    {
      jti: overrides?.inviteId ?? TEST_INVITE_ID,
      code: overrides?.ddsId ?? TEST_DDS_ID,
      companyId: overrides?.companyId ?? TEST_COMPANY_ID,
      portal: DDS_PUBLIC_SIGNATURE_PORTAL,
    },
    { expiresIn: 60 * 60 * 24 * 7 },
  );
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function makeUser(id: string, nome: string, email: string, funcao?: string) {
  return { id, nome, email, funcao: funcao ?? null };
}

function makeInvite(token: string, participantId: string): DdsSignatureInvite {
  return {
    id: TEST_INVITE_ID,
    company_id: TEST_COMPANY_ID,
    dds_id: TEST_DDS_ID,
    participant_user_id: participantId,
    token_hash: hashToken(token),
    dds_version: 1,
    expires_at: EXPIRY_FUTURE,
    revoked_at: null,
    used_at: null,
    last_viewed_at: null,
    signed_ip_hash: null,
    signed_user_agent_hash: null,
    created_by_user_id: 'creator-1',
    signed_signature_id: null,
    created_at: new Date('2026-06-20T10:00:00.000Z'),
    updated_at: new Date('2026-06-20T10:00:00.000Z'),
    dds: {
      id: TEST_DDS_ID,
      tema: 'NR-35 — Trabalho em Altura',
      data: new Date('2026-06-22'),
      status: DdsStatus.PUBLICADO,
      is_modelo: false,
      pdf_file_key: null,
      version: 1,
      company_id: TEST_COMPANY_ID,
      company: { razao_social: 'Construtora Exemplo Ltda' } as never,
      site: { nome: 'Obra Residencial Norte' } as never,
      facilitador: { nome: 'Carlos Supervisor' } as never,
    } as unknown as Dds,
    participant: {
      id: participantId,
      nome: 'Joao Operario',
      funcao: 'Operador de Equipamentos',
    } as never,
  } as unknown as DdsSignatureInvite;
}

describe('DdsSignatureInviteService', () => {
  const originalEnv = {
    FRONTEND_URL: process.env.FRONTEND_URL,
    VALIDATION_TOKEN_SECRET: process.env.VALIDATION_TOKEN_SECRET,
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn<Promise<DdsSignatureInvite | null>, []>(),
  };

  const inviteWriteRepository = {
    update: jest.fn(() => Promise.resolve(undefined)),
    create: jest.fn(
      (input: Partial<DdsSignatureInvite>) => input as DdsSignatureInvite,
    ),
    save: jest.fn((input: Partial<DdsSignatureInvite>) =>
      Promise.resolve(input as DdsSignatureInvite),
    ),
  };

  const inviteRepository = {
    manager: {
      transaction: jest.fn(
        <T>(
          callback: (manager: {
            getRepository: () => typeof inviteWriteRepository;
          }) => Promise<T> | T,
        ) =>
          Promise.resolve(
            callback({ getRepository: () => inviteWriteRepository }),
          ),
      ),
    },
    createQueryBuilder: jest.fn(() => mockQueryBuilder),
    save: jest.fn((input: Partial<DdsSignatureInvite>) =>
      Promise.resolve(input as DdsSignatureInvite),
    ),
    find: jest.fn(() => Promise.resolve([] as DdsSignatureInvite[])),
  };

  const ddsRepository = { findOne: jest.fn() };

  const tenantService = {
    getContext: jest.fn(() => ({
      companyId: TEST_COMPANY_ID,
      userId: 'creator-1',
      isSuperAdmin: true,
      siteScope: 'all' as const,
      siteIds: [],
    })),
    getTenantId: jest.fn(() => TEST_COMPANY_ID),
    run: jest.fn(<T>(_ctx: unknown, callback: () => T): T => callback()),
  };

  const signaturesService = {
    findByDocument: jest.fn<Promise<unknown[]>, [string, string]>(() =>
      Promise.resolve([]),
    ),
    createWithManager: jest.fn(),
  };

  const mailService = {
    sendMailSimple: jest.fn<
      Promise<Record<string, never>>,
      [string, string, string, MailContextMock?]
    >(() => Promise.resolve({})) as SendMailSimpleMock,
  };

  const turnstileService = {
    isEnabled: jest.fn(() => false),
    assertHuman: jest.fn(() => Promise.resolve()),
  };

  const configService = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        FRONTEND_URL: BASE_URL,
        VALIDATION_TOKEN_SECRET: TEST_SECRET,
      };
      return values[key] ?? undefined;
    }),
  };

  let service: DdsSignatureInviteService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryBuilder.leftJoinAndSelect.mockReturnThis();
    mockQueryBuilder.where.mockReturnThis();
    mockQueryBuilder.andWhere.mockReturnThis();
    mockQueryBuilder.setLock.mockReturnThis();
    tenantService.run.mockImplementation(
      <T>(_ctx: unknown, callback: () => T): T => callback(),
    );

    process.env.FRONTEND_URL = BASE_URL;
    process.env.VALIDATION_TOKEN_SECRET = TEST_SECRET;

    service = new DdsSignatureInviteService(
      inviteRepository as unknown as Repository<DdsSignatureInvite>,
      ddsRepository as unknown as Repository<Dds>,
      tenantService as unknown as TenantService,
      signaturesService as unknown as SignaturesService,
      mailService as unknown as MailService,
      turnstileService as unknown as TurnstileService,
      configService as unknown as ConfigService,
    );
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // issueInvites
  // ---------------------------------------------------------------------------

  describe('issueInvites', () => {
    it('gera link publico e envia convite DDS com contexto de auditoria do tenant', async () => {
      ddsRepository.findOne.mockResolvedValue({
        id: TEST_DDS_ID,
        company_id: TEST_COMPANY_ID,
        tema: 'DDS Trabalho Seguro',
        version: 1,
        site_id: 'site-1',
        status: DdsStatus.PUBLICADO,
        is_modelo: false,
        pdf_file_key: null,
        participants: [
          {
            id: 'user-1',
            nome: 'Ana TST',
            email: 'ana@example.test',
            funcao: 'Tecnica de Seguranca',
          },
        ],
      });

      const result = await service.issueInvites(
        TEST_DDS_ID,
        { participant_user_ids: ['user-1'], expires_in_days: 7 },
        'creator-1',
      );

      expect(result.invites[0]).toMatchObject({
        participantUserId: 'user-1',
        participantName: 'Ana TST',
        participantRole: 'Tecnica de Seguranca',
        status: 'pending',
      });
      expect(result.invites[0]?.signingUrl).toContain(SIGNING_URL_PREFIX);

      expect(mailService.sendMailSimple).toHaveBeenCalledTimes(1);
      const [to, subject, body, context] = mailService.sendMailSimple.mock
        .calls[0] ?? ['', '', ''];
      expect(to).toBe('ana@example.test');
      expect(subject).toBe('Convite para assinar DDS: DDS Trabalho Seguro');
      expect(body).toContain(SIGNING_URL_PREFIX);
      expect(context).toEqual({
        companyId: TEST_COMPANY_ID,
        userId: 'creator-1',
      });
    });

    it('gera 20 links de assinatura e envia 20 emails em lote (simulacao DDS real)', async () => {
      const TOTAL = 20;
      const cargos = [
        'Soldador',
        'Eletricista',
        'Encanador',
        'Carpinteiro',
        'Pintor',
        'Armador',
        'Operador de Grua',
        'Operador de Betoneira',
        'Ajudante Geral',
        'Mestre de Obras',
        'Tecnico de Seguranca',
        'Engenheiro Civil',
        'Pedreiro',
        'Servente',
        'Motorista',
        'Topografo',
        'Almoxarife',
        'Auxiliar Administrativo',
        'Bombeiro Hidraulico',
        'Instalador de Drywall',
      ];

      const funcionarios = Array.from({ length: TOTAL }, (_, i) =>
        makeUser(
          'func-' + String(i + 1).padStart(2, '0'),
          'Funcionario ' + String(i + 1).padStart(2, '0') + ' Silva',
          'func' + String(i + 1).padStart(2, '0') + '@obra.test',
          cargos[i] ?? 'Cargo ' + String(i + 1),
        ),
      );

      ddsRepository.findOne.mockResolvedValue({
        id: TEST_DDS_ID,
        company_id: TEST_COMPANY_ID,
        tema: 'NR-35: Trabalho em Altura — Riscos e Prevencao',
        version: 2,
        site_id: 'site-obras-norte',
        status: DdsStatus.PUBLICADO,
        is_modelo: false,
        pdf_file_key: null,
        data: new Date('2026-06-22'),
        participants: funcionarios,
        company: { razao_social: 'Construtora SGS Ltda' },
        site: { nome: 'Obras do Norte' },
        facilitador: { nome: 'Roberto SST' },
      });

      signaturesService.findByDocument.mockResolvedValue([]);

      const participantIds = funcionarios.map((f) => f.id);
      const result = await service.issueInvites(
        TEST_DDS_ID,
        { participant_user_ids: participantIds, expires_in_days: 7 },
        'creator-supervisor',
      );

      // Quantidade e campos basicos
      expect(result.invites).toHaveLength(TOTAL);
      expect(result.ddsId).toBe(TEST_DDS_ID);

      for (const invite of result.invites) {
        expect(invite.status).toBe('pending');
        expect(invite.signingUrl).toContain(SIGNING_URL_PREFIX);
        expect(invite.signingPath).toContain('/assinar/dds/');
        expect(invite.expiresAt).toBeTruthy();
        expect(invite.signedAt).toBeNull();
        expect(invite.inviteId).toBeTruthy();
      }

      // Correspondencia participante <-> convite
      const nomesPorId = new Map(funcionarios.map((f) => [f.id, f.nome]));
      const cargosPorId = new Map(
        funcionarios.map((f) => [f.id, f.funcao ?? null]),
      );
      for (const invite of result.invites) {
        expect(invite.participantName).toBe(
          nomesPorId.get(invite.participantUserId),
        );
        expect(invite.participantRole).toBe(
          cargosPorId.get(invite.participantUserId),
        );
      }

      // Emails enviados a todos os 20 funcionarios
      expect(mailService.sendMailSimple).toHaveBeenCalledTimes(TOTAL);
      const emailsEnviados = mailService.sendMailSimple.mock.calls.map(
        ([to]) => to,
      );
      const emailsEsperados = funcionarios.map((f) => f.email);
      expect(emailsEnviados.sort()).toEqual(emailsEsperados.sort());

      for (const [, subject, body] of mailService.sendMailSimple.mock.calls) {
        expect(subject).toBe(
          'Convite para assinar DDS: NR-35: Trabalho em Altura — Riscos e Prevencao',
        );
        expect(body).toContain(SIGNING_URL_PREFIX);
      }

      // Sem duplicatas nos inviteIds
      const inviteIds = result.invites.map((i) => i.inviteId).filter(Boolean);
      expect(new Set(inviteIds).size).toBe(TOTAL);

      // Tokens JWT distintos em cada link
      const tokens = result.invites
        .map((i) => {
          const url = i.signingUrl ?? '';
          return url.split('/assinar/dds/')[1] ?? '';
        })
        .filter(Boolean);
      expect(new Set(tokens).size).toBe(TOTAL);
    });

    it('marca como signed participantes que ja possuem assinatura existente', async () => {
      const participanteJaAssinado = makeUser(
        'user-signed',
        'Maria Ja Assinou',
        'maria@obra.test',
        'Supervisora',
      );
      const participantePendente = makeUser(
        'user-pending',
        'Jose Vai Assinar',
        'jose@obra.test',
        'Auxiliar',
      );

      ddsRepository.findOne.mockResolvedValue({
        id: TEST_DDS_ID,
        company_id: TEST_COMPANY_ID,
        tema: 'Uso Correto de EPIs',
        version: 1,
        site_id: 'site-1',
        status: DdsStatus.PUBLICADO,
        is_modelo: false,
        pdf_file_key: null,
        participants: [participanteJaAssinado, participantePendente],
      });

      signaturesService.findByDocument.mockResolvedValue([
        {
          id: 'sig-existing',
          user_id: 'user-signed',
          company_id: TEST_COMPANY_ID,
          document_id: TEST_DDS_ID,
          document_type: 'DDS',
          type: 'digital',
          signed_at: new Date('2026-06-20T08:00:00.000Z'),
          created_at: new Date('2026-06-20T08:00:00.000Z'),
        },
      ]);

      const result = await service.issueInvites(
        TEST_DDS_ID,
        {
          participant_user_ids: ['user-signed', 'user-pending'],
          expires_in_days: 7,
        },
        'creator-1',
      );

      const signedInvite = result.invites.find(
        (i) => i.participantUserId === 'user-signed',
      );
      const pendingInvite = result.invites.find(
        (i) => i.participantUserId === 'user-pending',
      );

      expect(signedInvite?.status).toBe('signed');
      expect(signedInvite?.signedAt).toBeTruthy();
      expect(pendingInvite?.status).toBe('pending');
      expect(mailService.sendMailSimple).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getPublicContext
  // ---------------------------------------------------------------------------

  describe('getPublicContext', () => {
    it('retorna contexto correto com status pending', async () => {
      const token = makeTestToken();
      const invite = makeInvite(token, 'user-1');
      mockQueryBuilder.getOne.mockResolvedValue(invite);
      signaturesService.findByDocument.mockResolvedValue([]);

      const result = await service.getPublicContext(token);

      expect(result).toMatchObject({
        inviteId: TEST_INVITE_ID,
        status: 'pending',
        signedAt: null,
        signer: {
          name: 'Joao Operario',
          role: 'Operador de Equipamentos',
        },
        dds: {
          id: TEST_DDS_ID,
          tema: 'NR-35 — Trabalho em Altura',
          status: DdsStatus.PUBLICADO,
          companyName: 'Construtora Exemplo Ltda',
          siteName: 'Obra Residencial Norte',
          facilitatorName: 'Carlos Supervisor',
          version: 1,
        },
      });
      expect(result.expiresAt).toBeTruthy();
    });

    it('chama tenantService.run com companyId extraido do token', async () => {
      const token = makeTestToken();
      const invite = makeInvite(token, 'user-1');
      mockQueryBuilder.getOne.mockResolvedValue(invite);
      signaturesService.findByDocument.mockResolvedValue([]);

      await service.getPublicContext(token);

      expect(tenantService.run).toHaveBeenCalledTimes(1);
      expect(tenantService.run).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: TEST_COMPANY_ID }),
        expect.any(Function),
      );
    });

    it('chama findByDocument com ddsId e tipo DDS corretos', async () => {
      const token = makeTestToken();
      const invite = makeInvite(token, 'user-1');
      mockQueryBuilder.getOne.mockResolvedValue(invite);
      signaturesService.findByDocument.mockResolvedValue([]);

      await service.getPublicContext(token);

      expect(signaturesService.findByDocument).toHaveBeenCalledWith(
        TEST_DDS_ID,
        'DDS',
      );
    });

    it('retorna status signed quando participante ja possui assinatura', async () => {
      const token = makeTestToken();
      const signedAt = new Date('2026-06-21T14:30:00.000Z');
      const invite = makeInvite(token, 'user-1');
      mockQueryBuilder.getOne.mockResolvedValue(invite);

      signaturesService.findByDocument.mockResolvedValue([
        {
          id: 'sig-001',
          user_id: 'user-1',
          company_id: TEST_COMPANY_ID,
          document_id: TEST_DDS_ID,
          document_type: 'DDS',
          type: 'digital',
          signed_at: signedAt,
          created_at: signedAt,
        },
      ]);

      const result = await service.getPublicContext(token);

      expect(result.status).toBe('signed');
      expect(result.signedAt).toBe(signedAt.toISOString());
    });

    it('toca last_viewed_at quando invite ainda nao foi utilizado', async () => {
      const token = makeTestToken();
      const invite = makeInvite(token, 'user-1');
      invite.used_at = null;
      mockQueryBuilder.getOne.mockResolvedValue(invite);
      signaturesService.findByDocument.mockResolvedValue([]);

      await service.getPublicContext(token);

      expect(inviteRepository.save).toHaveBeenCalledTimes(1);
      const saved = inviteRepository.save.mock.calls[0]?.[0];
      expect(saved.last_viewed_at).toBeInstanceOf(Date);
    });

    it('nao toca last_viewed_at quando invite ja foi utilizado', async () => {
      const token = makeTestToken();
      const invite = makeInvite(token, 'user-1');
      invite.used_at = new Date('2026-06-20T16:00:00.000Z');
      mockQueryBuilder.getOne.mockResolvedValue(invite);
      signaturesService.findByDocument.mockResolvedValue([]);

      await service.getPublicContext(token);

      expect(inviteRepository.save).not.toHaveBeenCalled();
    });

    it('lanca ForbiddenException para token com portal errado', async () => {
      const badToken = signValidationToken(
        {
          jti: TEST_INVITE_ID,
          code: TEST_DDS_ID,
          companyId: TEST_COMPANY_ID,
          portal: 'outro_portal',
        },
        { expiresIn: 3600 },
      );

      await expect(service.getPublicContext(badToken)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('regressao: findByDocument e executado dentro do escopo do tenantService.run', async () => {
      // Antes do fix, findExistingParticipantSignature era chamada FORA do run().
      // Este teste verifica a ordem de execucao para garantir o fix.
      const token = makeTestToken();
      const invite = makeInvite(token, 'user-1');
      mockQueryBuilder.getOne.mockResolvedValue(invite);

      const callOrder: string[] = [];

      tenantService.run.mockImplementation(
        <T>(_ctx: unknown, callback: () => T): T => {
          callOrder.push('run:enter');
          const result = callback();
          if (result instanceof Promise) {
            return result.then((v: Awaited<T>) => {
              callOrder.push('run:exit');
              return v;
            }) as T;
          }
          callOrder.push('run:exit');
          return result;
        },
      );

      signaturesService.findByDocument.mockImplementation(() => {
        callOrder.push('findByDocument');
        return Promise.resolve([]);
      });

      await service.getPublicContext(token);

      const enterIdx = callOrder.indexOf('run:enter');
      const exitIdx = callOrder.indexOf('run:exit');
      const findIdx = callOrder.indexOf('findByDocument');

      expect(enterIdx).toBeGreaterThanOrEqual(0);
      expect(findIdx).toBeGreaterThan(enterIdx);
      expect(findIdx).toBeLessThan(exitIdx);
    });
  });

  describe('submitPublicSignature', () => {
    it('rejeita payload PNG vazio ou com base64 inválido antes de validar o token', async () => {
      await expect(
        service.submitPublicSignature('token-inválido', {
          acceptedTerms: true,
          signatureData: 'data:image/png;base64,***',
        }),
      ).rejects.toMatchObject({
        status: 400,
      });
    });
  });
});
