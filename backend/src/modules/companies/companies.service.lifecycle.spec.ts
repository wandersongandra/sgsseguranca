import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CompaniesService } from './companies.service';
import { Company } from './entities/company.entity';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StorageService } from '../../shared/services/storage.service';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import { Profile } from '../profiles/entities/profile.entity';
import { Dds } from '../dds/entities/dds.entity';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { GDPRDeletionService } from '../admin/services/gdpr-deletion.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { ProvisioningDataSourceService } from '../../shared/database/provisioning-datasource.service';
import {
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';

const COMPANY_ID = 'company-uuid-1';

const makeCompany = (overrides: Partial<Company> = {}): Company =>
  ({
    id: COMPANY_ID,
    razao_social: 'Empresa Teste',
    cnpj: '12345678000190',
    status: true,
    logo_url: null,
    logo_storage_key: null,
    logo_content_type: null,
    logo_sha256: null,
    ...overrides,
  }) as Company;

const makeMockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn((e: unknown) => Promise.resolve(e as Company)),
  create: jest.fn((d: unknown) => d as Company),
  remove: jest.fn().mockResolvedValue(undefined),
  softDelete: jest.fn().mockResolvedValue(undefined),
  count: jest.fn().mockResolvedValue(0),
  createQueryBuilder: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  }),
  manager: {
    getRepository: jest.fn().mockReturnValue({
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((d: unknown) => d),
    }),
  },
});

describe('CompaniesService — lifecycle e validação', () => {
  let service: CompaniesService;
  let companyRepo: ReturnType<typeof makeMockRepo>;
  let cacheManager: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let gdprService: { deleteCompanyData: jest.Mock };

  /**
   * Quantos usuários a conexão PRIVILEGIADA enxerga — ou seja, a verdade.
   * Os testes de `remove` abaixo controlam este número, e não o do repositório
   * de runtime, porque é este que a guarda precisa consultar.
   */
  let usuariosVinculados: number;
  /**
   * Quando definido, `requiredTransaction` rejeita com este erro em vez de
   * contar — simula conexão privilegiada ausente (503) ou indisponível
   * (ECONNREFUSED, timeout, falha de autenticação).
   */
  let erroDaConexaoPrivilegiada: Error | null;
  let provisioningDataSource: {
    isDedicated: jest.Mock;
    transaction: jest.Mock;
    requiredTransaction: jest.Mock;
  };

  beforeEach(async () => {
    usuariosVinculados = 0;
    erroDaConexaoPrivilegiada = null;

    const executar = (cb: (m: unknown) => unknown) => {
      if (erroDaConexaoPrivilegiada) {
        return Promise.reject(erroDaConexaoPrivilegiada);
      }
      return Promise.resolve(
        cb({
          getRepository: () => ({
            count: jest.fn(() => Promise.resolve(usuariosVinculados)),
          }),
        }),
      );
    };

    provisioningDataSource = {
      isDedicated: jest.fn(() => !erroDaConexaoPrivilegiada),
      transaction: jest.fn(executar),
      requiredTransaction: jest.fn((_op: string, cb: (m: unknown) => unknown) =>
        executar(cb),
      ),
    };
    companyRepo = makeMockRepo();
    cacheManager = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    gdprService = {
      deleteCompanyData: jest.fn().mockResolvedValue({ status: 'success' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompaniesService,
        { provide: getRepositoryToken(Company), useValue: companyRepo },
        { provide: getRepositoryToken(Site), useValue: makeMockRepo() },
        { provide: getRepositoryToken(User), useValue: makeMockRepo() },
        { provide: getRepositoryToken(Profile), useValue: makeMockRepo() },
        { provide: getRepositoryToken(Dds), useValue: makeMockRepo() },
        { provide: CACHE_MANAGER, useValue: cacheManager },
        {
          provide: StorageService,
          useValue: {
            uploadFile: jest.fn().mockResolvedValue({ key: 'logo/key.png' }),
            deleteFile: jest.fn().mockResolvedValue(undefined),
            getPresignedInlineViewUrl: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: FileInspectionService,
          useValue: {
            inspect: jest
              .fn()
              .mockResolvedValue({ clean: true, provider: 'mock' }),
          },
        },
        {
          provide: GDPRDeletionService,
          useValue: gdprService,
        },
        {
          provide: ProvisioningDataSourceService,
          useValue: provisioningDataSource,
        },
        {
          provide: TenantService,
          useValue: {
            run: jest.fn((_ctx: unknown, cb: () => unknown) => cb()),
          },
        },
      ],
    }).compile();

    service = module.get<CompaniesService>(CompaniesService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('remove — restrições de lifecycle', () => {
    it('lança BadRequestException quando empresa tem usuários vinculados', async () => {
      companyRepo.findOne.mockResolvedValueOnce(makeCompany());
      usuariosVinculados = 3;

      await expect(service.remove(COMPANY_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(companyRepo.remove).not.toHaveBeenCalled();
    });

    it('conta os usuários pela conexão de provisionamento, não pela de runtime', async () => {
      // Trava de regressão de uma guarda que falhava ABERTA em produção.
      //
      // `/companies` está em GLOBAL_TENANT_OPTIONAL_PATHS, então o ADMIN_GERAL
      // chama esta rota sem `x-company-id`. Sem `current_company()`, e com
      // `is_super_admin()` inerte desde a migration 361, a RLS de `users` nega
      // tudo na conexão de runtime: o count devolvia 0, a trava nunca disparava
      // e a empresa era excluída com usuários ativos dentro — que a cascata de
      // GDPR levava junto.
      //
      // O teste acima passava mesmo com o defeito, porque o mock do repositório
      // de runtime devolvia a verdade que a RLS jamais deixaria passar. É por
      // isso que este teste existe separado: aqui o runtime devolve 0 (RLS
      // negando) e a conexão privilegiada devolve 2 (o que há de fato). A
      // guarda precisa acreditar na segunda.
      companyRepo.findOne.mockResolvedValueOnce(makeCompany());
      companyRepo.manager.getRepository.mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
      });
      usuariosVinculados = 2;

      await expect(service.remove(COMPANY_ID)).rejects.toThrow(
        /usuário vinculado/i,
      );
      // `requiredTransaction`, não `transaction`: a diferença é que a primeira
      // recusa a operação quando não há conexão privilegiada, em vez de
      // degradar para o runtime e voltar a contar 0.
      expect(provisioningDataSource.requiredTransaction).toHaveBeenCalledWith(
        'company_delete_guard',
        expect.any(Function),
      );
      expect(provisioningDataSource.transaction).not.toHaveBeenCalled();
      expect(companyRepo.softDelete).not.toHaveBeenCalled();
    });

    it('lança InternalServerErrorException quando pipeline GDPR falha', async () => {
      companyRepo.findOne.mockResolvedValueOnce(makeCompany());
      usuariosVinculados = 0;
      gdprService.deleteCompanyData.mockResolvedValueOnce({ status: 'failed' });

      await expect(service.remove(COMPANY_ID)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(companyRepo.softDelete).not.toHaveBeenCalled();
    });

    it('soft-deleta empresa sem usuários e invalida caches', async () => {
      companyRepo.findOne.mockResolvedValueOnce(makeCompany());
      usuariosVinculados = 0;

      await service.remove(COMPANY_ID);

      expect(gdprService.deleteCompanyData).toHaveBeenCalledWith(COMPANY_ID);
      expect(companyRepo.softDelete).toHaveBeenCalledWith(COMPANY_ID);
      expect(companyRepo.remove).not.toHaveBeenCalled();
      expect(cacheManager.del).toHaveBeenCalledWith('companies:all');
      expect(cacheManager.del).toHaveBeenCalledWith('companies:active:ids');
      expect(cacheManager.del).toHaveBeenCalledWith(`company:${COMPANY_ID}`);
    });

    it('TESTE C — sem conexão privilegiada, FALHA FECHADO e não exclui nada', async () => {
      // `requiredTransaction` responde 503 quando DATABASE_ADMIN_URL não existe.
      // O ponto é que a ausência de prova NÃO pode virar "empresa vazia".
      companyRepo.findOne.mockResolvedValueOnce(makeCompany());
      erroDaConexaoPrivilegiada = new ServiceUnavailableException(
        'Operação administrativa indisponível: conexão privilegiada não configurada.',
      );

      await expect(service.remove(COMPANY_ID)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(gdprService.deleteCompanyData).not.toHaveBeenCalled();
      expect(companyRepo.softDelete).not.toHaveBeenCalled();
      expect(companyRepo.remove).not.toHaveBeenCalled();
    });

    it('TESTE D — erro de infraestrutura na conexão admin nunca vira "0 usuários"', async () => {
      // ECONNREFUSED, timeout, falha de autenticação: qualquer um deles tem
      // que propagar. Um `catch` que devolvesse 0 aqui recriaria o fail-open
      // por outro caminho.
      for (const falha of [
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        }),
        Object.assign(new Error('Connection terminated due to timeout'), {
          code: 'ETIMEDOUT',
        }),
        new Error('password authentication failed for user "sgs_admin"'),
      ]) {
        jest.clearAllMocks();
        companyRepo.findOne.mockResolvedValueOnce(makeCompany());
        erroDaConexaoPrivilegiada = falha;

        await expect(service.remove(COMPANY_ID)).rejects.toThrow(falha.message);
        expect(gdprService.deleteCompanyData).not.toHaveBeenCalled();
        expect(companyRepo.softDelete).not.toHaveBeenCalled();
      }
    });

    it('lança NotFoundException ao remover empresa inexistente', async () => {
      companyRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.remove('inexistente')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update — logo e invalidação de cache', () => {
    it('invalida 3 chaves de cache após update', async () => {
      const company = makeCompany();
      companyRepo.findOne.mockResolvedValueOnce(company);
      companyRepo.save.mockResolvedValueOnce(company);

      await service.update(COMPANY_ID, { razao_social: 'Nova Razão Social' });

      expect(cacheManager.del).toHaveBeenCalledWith('companies:all');
      expect(cacheManager.del).toHaveBeenCalledWith('companies:active:ids');
      expect(cacheManager.del).toHaveBeenCalledWith(`company:${COMPANY_ID}`);
    });

    it('lança BadRequestException quando logo tem tipo inválido (SVG)', async () => {
      const company = makeCompany();
      companyRepo.findOne.mockResolvedValueOnce(company);

      const svgBase64 = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ).toString('base64');

      await expect(
        service.update(COMPANY_ID, {
          logo_url: `data:image/svg+xml;base64,${svgBase64}`,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(companyRepo.save).not.toHaveBeenCalled();
    });

    it('lança BadRequestException quando logo excede 2MB', async () => {
      const company = makeCompany();
      companyRepo.findOne.mockResolvedValueOnce(company);

      const oversizedBuffer = Buffer.alloc(3 * 1024 * 1024, 0xff);
      const pngBase64 = oversizedBuffer.toString('base64');

      await expect(
        service.update(COMPANY_ID, {
          logo_url: `data:image/png;base64,${pngBase64}`,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança NotFoundException quando empresa não existe', async () => {
      companyRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.update('inexistente', { razao_social: 'Nova Empresa' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('create — CNPJ e logo', () => {
    it('normaliza CNPJ removendo máscara antes de persistir', async () => {
      const company = makeCompany();
      jest
        .spyOn(service, 'ensureDefaultDdsThemeLibrary')
        .mockResolvedValue(undefined);
      companyRepo.save.mockResolvedValueOnce(company);

      await service.create({
        razao_social: 'Empresa',
        cnpj: '12.345.678/0001-90',
      });

      const calls = (companyRepo.create as jest.Mock).mock.calls as [
        Partial<Company>,
      ][];
      const created = calls[0][0];
      expect(created.cnpj).toBe('12345678000190');
    });

    it('lança BadRequestException quando logo tem content-type inválido', async () => {
      const gifBase64 = Buffer.from('GIF89a').toString('base64');

      await expect(
        service.create({
          razao_social: 'Empresa',
          logo_url: `data:image/gif;base64,${gifBase64}`,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('invalida caches companies:all e companies:active:ids após criação', async () => {
      const company = makeCompany();
      jest
        .spyOn(service, 'ensureDefaultDdsThemeLibrary')
        .mockResolvedValue(undefined);
      companyRepo.save.mockResolvedValueOnce(company);

      await service.create({ razao_social: 'Empresa', cnpj: '12345678000190' });

      expect(cacheManager.del).toHaveBeenCalledWith('companies:all');
      expect(cacheManager.del).toHaveBeenCalledWith('companies:active:ids');
    });
  });
});
