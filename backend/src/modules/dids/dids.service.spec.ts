/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { DidsService } from './dids.service';
import { Did, DidStatus } from './entities/did.entity';
import { User } from '../users/entities/user.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';

type RegisterFinalDocumentInput = Parameters<
  DocumentGovernanceService['registerFinalDocument']
>[0];

describe('DidsService', () => {
  let service: DidsService;
  let didRepository: jest.Mocked<Repository<Did>>;
  let usersRepository: jest.Mocked<Repository<User>>;
  let tenantService: Partial<TenantService>;
  let documentStorageService: Partial<DocumentStorageService>;
  let documentGovernanceService: Partial<DocumentGovernanceService>;

  beforeEach(() => {
    didRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn((input: Did) => Promise.resolve(input)),
      create: jest.fn((input: Partial<Did>) => input),
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<Did>>;

    usersRepository = {
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<User>>;

    tenantService = {
      getTenantId: jest.fn().mockReturnValue('company-1'),
    };

    documentStorageService = {
      generateDocumentKey: jest.fn(
        (companyId: string, module: string, entityId: string) =>
          `documents/${companyId}/${module}/${entityId}/did-final.pdf`,
      ),
      uploadFile: jest.fn(() => Promise.resolve()),
      deleteFile: jest.fn(() => Promise.resolve()),
      getSignedUrl: jest.fn(() =>
        Promise.resolve('https://signed.example/pdf'),
      ),
    };

    documentGovernanceService = {
      registerFinalDocument: jest.fn(),
      removeFinalDocumentReference: jest.fn(),
    };

    service = new DidsService(
      didRepository,
      usersRepository,
      tenantService as TenantService,
      documentStorageService as DocumentStorageService,
      documentGovernanceService as DocumentGovernanceService,
      {
        issueToken: jest.fn().mockResolvedValue('token-mock'),
      } as unknown as import('../../shared/services/public-validation-grant.service').PublicValidationGrantService,
    );
  });

  it('rejeita company_id forjado no payload ao criar DID', async () => {
    await expect(
      service.create({
        titulo: 'DID operação de içamento',
        data: '2026-04-15',
        atividade_principal: 'Içamento de componentes',
        atividades_planejadas:
          'Movimentação controlada com sinalização e spotter.',
        riscos_operacionais: 'Esmagamento, colisão e queda de carga suspensa.',
        controles_planejados:
          'Isolamento da área, sinaleiro e checklist pré-uso.',
        site_id: '11111111-1111-4111-8111-111111111111',
        responsavel_id: '22222222-2222-4222-8222-222222222222',
        participants: ['33333333-3333-4333-8333-333333333333'],
        company_id: 'tenant-forjado',
      } as never),
    ).rejects.toThrow(BadRequestException);

    expect(didRepository.create).not.toHaveBeenCalled();
  });

  it('findPaginated: retorna vazio sem 400 quando usuario de obra nao tem site no contexto', async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
    };
    didRepository.createQueryBuilder.mockReturnValue(queryBuilder as never);
    tenantService.getContext = jest.fn(() => ({
      companyId: 'company-1',
      userId: 'user-tst-sem-obra',
      isSuperAdmin: false,
      siteScope: 'single',
      siteIds: [],
    }));

    await expect(
      service.findPaginated({ page: 1, limit: 10 }),
    ).resolves.toMatchObject({
      data: [],
      total: 0,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('1 = 0');
    expect(didRepository.find).not.toHaveBeenCalled();
  });

  it('findPaginated: rejeita search malformado em vez de cair em 500', async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
    };
    didRepository.createQueryBuilder.mockReturnValue(queryBuilder as never);

    await expect(
      service.findPaginated({
        page: 1,
        limit: 10,
        search: ['forged'] as unknown as string,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(queryBuilder.getRawMany).not.toHaveBeenCalled();
    expect(queryBuilder.getCount).not.toHaveBeenCalled();
  });

  it('rejeita participante fora da obra selecionada ao criar DID', async () => {
    const siteRepository = {
      findOne: jest.fn(() => Promise.resolve({ id: 'site-1' })),
    };
    const userRepository = {
      find: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'responsavel-1' }])
        .mockResolvedValueOnce([]),
    };
    const userSiteRepository = {
      find: jest.fn(() => Promise.resolve([])),
    };
    (
      didRepository as unknown as {
        manager: { getRepository: jest.Mock };
      }
    ).manager = {
      getRepository: jest
        .fn()
        .mockReturnValueOnce(siteRepository)
        .mockReturnValueOnce(userRepository)
        .mockReturnValueOnce(userSiteRepository)
        .mockReturnValueOnce(userRepository)
        .mockReturnValueOnce(userSiteRepository),
    };

    await expect(
      service.create({
        titulo: 'DID operação de içamento',
        data: '2026-04-15',
        atividade_principal: 'Içamento de componentes',
        atividades_planejadas:
          'Movimentação controlada com sinalização e spotter.',
        riscos_operacionais: 'Esmagamento, colisão e queda de carga suspensa.',
        controles_planejados:
          'Isolamento da área, sinaleiro e checklist pré-uso.',
        site_id: 'site-1',
        responsavel_id: 'responsavel-1',
        participants: ['participante-outra-obra'],
      }),
    ).rejects.toThrow(
      'Participantes informado(s) não pertencem à obra/setor selecionada do documento.',
    );

    expect(didRepository.save).not.toHaveBeenCalled();
  });

  it('permite participante company-scoped ao criar DID', async () => {
    const siteRepository = {
      findOne: jest.fn(() => Promise.resolve({ id: 'site-1' })),
    };
    const userRepository = {
      find: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'responsavel-1' }])
        .mockResolvedValueOnce([{ id: 'participante-company-scoped' }]),
    };
    const userSiteRepository = {
      find: jest.fn(() => Promise.resolve([])),
    };
    (
      didRepository as unknown as {
        manager: { getRepository: jest.Mock };
      }
    ).manager = {
      getRepository: jest
        .fn()
        .mockReturnValueOnce(siteRepository)
        .mockReturnValueOnce(userRepository)
        .mockReturnValueOnce(userSiteRepository)
        .mockReturnValueOnce(userRepository)
        .mockReturnValueOnce(userSiteRepository),
    };

    await expect(
      service.create({
        titulo: 'DID operação de içamento',
        data: '2026-04-15',
        atividade_principal: 'Içamento de componentes',
        atividades_planejadas:
          'Movimentação controlada com sinalização e spotter.',
        riscos_operacionais: 'Esmagamento, colisão e queda de carga suspensa.',
        controles_planejados:
          'Isolamento da área, sinaleiro e checklist pré-uso.',
        site_id: 'site-1',
        responsavel_id: 'responsavel-1',
        participants: ['participante-company-scoped'],
      }),
    ).resolves.toBeTruthy();

    expect(didRepository.save).toHaveBeenCalled();
  });

  it('permite participante vinculado à obra via user_sites ao criar DID', async () => {
    const siteRepository = {
      findOne: jest.fn(() => Promise.resolve({ id: 'site-1' })),
    };
    const userRepository = {
      find: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'responsavel-1' }])
        .mockResolvedValueOnce([]),
    };
    const userSiteRepository = {
      find: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ user_id: 'participante-vinculado' }]),
    };
    (
      didRepository as unknown as {
        manager: { getRepository: jest.Mock };
      }
    ).manager = {
      getRepository: jest
        .fn()
        .mockReturnValueOnce(siteRepository)
        .mockReturnValueOnce(userRepository)
        .mockReturnValueOnce(userSiteRepository)
        .mockReturnValueOnce(userRepository)
        .mockReturnValueOnce(userSiteRepository),
    };

    await expect(
      service.create({
        titulo: 'DID operação de içamento',
        data: '2026-04-15',
        atividade_principal: 'Içamento de componentes',
        atividades_planejadas:
          'Movimentação controlada com sinalização e spotter.',
        riscos_operacionais: 'Esmagamento, colisão e queda de carga suspensa.',
        controles_planejados:
          'Isolamento da área, sinaleiro e checklist pré-uso.',
        site_id: 'site-1',
        responsavel_id: 'responsavel-1',
        participants: ['participante-vinculado'],
      }),
    ).resolves.toBeTruthy();

    expect(didRepository.save).toHaveBeenCalled();
  });

  it('listPeople: retorna funcionarios ativos vinculados a obra selecionada ou sem obra — regra de negocio: obra X exibe apenas seus funcionarios', async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([
        [
          {
            id: 'user-site-1',
            nome: 'Equipe Site',
            funcao: 'Operador',
            company_id: 'company-1',
            site_id: 'site-1',
            status: true,
          },
          {
            id: 'user-company',
            nome: 'Equipe Global',
            funcao: 'Supervisor',
            company_id: 'company-1',
            site_id: null,
            status: true,
          },
        ],
        2,
      ]),
    };
    usersRepository.createQueryBuilder.mockReturnValue(queryBuilder as never);
    tenantService.getContext = jest.fn(() => ({
      companyId: 'company-1',
      userId: 'user-tst',
      isSuperAdmin: false,
      siteScope: 'single',
      siteIds: ['site-1'],
    }));

    await expect(
      service.listPeople({ page: 1, limit: 100, siteId: 'site-1' }),
    ).resolves.toMatchObject({
      total: 2,
      data: [
        { id: 'user-site-1', site_id: 'site-1' },
        { id: 'user-company', site_id: null },
      ],
    });

    // siteId da obra selecionada gera filtro WHERE — apenas vinculados a essa obra (ou sem obra) aparecem
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('site_id IN (:...siteIds)'),
      { siteIds: ['site-1'] },
    );
  });

  it('listPeople: TST ve lista vazia ao selecionar obra sem funcionarios vinculados', async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    usersRepository.createQueryBuilder.mockReturnValue(queryBuilder as never);
    tenantService.getContext = jest.fn(() => ({
      companyId: 'company-1',
      userId: 'user-tst',
      isSuperAdmin: false,
      siteScope: 'single',
      siteIds: ['site-1'],
    }));

    await expect(
      service.listPeople({ page: 1, limit: 20, siteId: 'site-2' }),
    ).resolves.toMatchObject({ total: 0, data: [] });

    expect(usersRepository.createQueryBuilder).toHaveBeenCalled();
    // filtro de obra aplicado mesmo para TST — obra selecionada delimita os participantes
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('site_id IN (:...siteIds)'),
      { siteIds: ['site-2'] },
    );
  });

  it('emite 20 PDFs finais de DID simultaneamente sem degradar o fluxo governado', async () => {
    const dids = Array.from({ length: 20 }, (_, index) => {
      const didId = `did-${index + 1}`;
      return {
        id: didId,
        titulo: `DID ${index + 1}`,
        company_id: 'company-1',
        site_id: 'site-1',
        responsavel_id: 'user-1',
        status: DidStatus.ALINHADO,
        data: new Date('2026-04-15'),
        created_at: new Date('2026-04-15T07:00:00.000Z'),
        participants: [{ id: `participant-${index + 1}` }],
        pdf_file_key: null,
        pdf_folder_path: null,
        pdf_original_name: null,
      } as unknown as Did;
    });

    const didMap = new Map(dids.map((did) => [did.id, did]));
    didRepository.findOne.mockImplementation(({ where }) => {
      const candidateId =
        typeof where === 'object' &&
        where !== null &&
        'id' in where &&
        typeof where.id === 'string'
          ? where.id
          : '';
      return Promise.resolve(didMap.get(candidateId) || null);
    });

    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      const update = jest.fn().mockResolvedValue({ affected: 1 });
      const manager = {
        getRepository: jest.fn(() => ({ update })),
      } as unknown as EntityManager;
      await input.persistEntityMetadata?.(manager, `hash-${input.entityId}`);
      return {
        hash: `hash-${input.entityId}`,
        registryEntry: { id: `registry-${input.entityId}` },
      };
    });

    const files = dids.map((did) => ({
      originalname: `${did.id}.pdf`,
      mimetype: 'application/pdf',
      buffer: Buffer.from(`%PDF-${did.id}`),
    })) as Express.Multer.File[];

    const results = await Promise.all(
      dids.map((did, index) =>
        service.attachPdf(did.id, files[index], {
          userId: `emitter-${index + 1}`,
        }),
      ),
    );

    expect(results).toHaveLength(20);
    expect(results.every((result) => result.degraded === false)).toBe(true);
    expect(documentStorageService.uploadFile).toHaveBeenCalledTimes(20);
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledTimes(20);
    expect(documentStorageService.generateDocumentKey).toHaveBeenCalledTimes(
      20,
    );
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        module: 'did',
        entityId: 'did-1',
        createdBy: 'emitter-1',
      }),
    );
  });

  it('bloqueia emissao final quando o DID ainda esta em rascunho', async () => {
    didRepository.findOne.mockResolvedValue({
      id: 'did-rascunho',
      titulo: 'DID rascunho',
      company_id: 'company-1',
      site_id: 'site-1',
      responsavel_id: 'user-1',
      status: DidStatus.RASCUNHO,
      data: new Date('2026-04-15'),
      created_at: new Date('2026-04-15T07:00:00.000Z'),
      participants: [{ id: 'participant-1' }],
      pdf_file_key: null,
      pdf_folder_path: null,
      pdf_original_name: null,
    } as unknown as Did);

    const file = {
      originalname: 'did-rascunho.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-did-rascunho'),
    } as Express.Multer.File;

    await expect(service.attachPdf('did-rascunho', file)).rejects.toThrow(
      BadRequestException,
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
  });

  it('permite emissao final de DID arquivado sem alterar o status arquivado', async () => {
    didRepository.findOne.mockResolvedValue({
      id: 'did-arquivado',
      titulo: 'DID arquivado',
      company_id: 'company-1',
      site_id: 'site-1',
      responsavel_id: 'user-1',
      status: DidStatus.ARQUIVADO,
      data: new Date('2026-04-15'),
      created_at: new Date('2026-04-15T07:00:00.000Z'),
      participants: [{ id: 'participant-1' }],
      pdf_file_key: null,
      pdf_folder_path: null,
      pdf_original_name: null,
    } as unknown as Did);

    const updateMetadata = jest.fn().mockResolvedValue({ affected: 1 });
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      const manager = {
        getRepository: jest.fn(() => ({ update: updateMetadata })),
      } as unknown as EntityManager;
      await input.persistEntityMetadata?.(manager, 'hash-did-arquivado');
      return {
        hash: 'hash-did-arquivado',
        registryEntry: { id: 'registry-did-arquivado' },
      };
    });

    const file = {
      originalname: 'did-arquivado.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-did-arquivado'),
    } as Express.Multer.File;

    await expect(
      service.attachPdf('did-arquivado', file, { userId: 'emitter-1' }),
    ).resolves.toMatchObject({
      fileKey: 'documents/company-1/did/did-arquivado/did-final.pdf',
      degraded: false,
    });

    expect(documentStorageService.uploadFile).toHaveBeenCalledTimes(1);
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'did',
        entityId: 'did-arquivado',
        createdBy: 'emitter-1',
      }),
    );
    expect(updateMetadata).toHaveBeenCalledWith('did-arquivado', {
      pdf_file_key: 'documents/company-1/did/did-arquivado/did-final.pdf',
      pdf_folder_path: 'documents/company-1/did/did-arquivado',
      pdf_original_name: 'did-arquivado.pdf',
      status: DidStatus.ARQUIVADO,
    });
  });

  it('bloqueia remocao de DID que ja tem PDF final emitido', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: 'did-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/did-1.pdf',
    } as unknown as Did);

    await expect(service.remove('did-1')).rejects.toThrow('sem PDF final');
  });
});
