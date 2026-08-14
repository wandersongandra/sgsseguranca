/* eslint-disable @typescript-eslint/unbound-method -- asserções sobre mocks de
   repositório (`expect(repo.save).not.toHaveBeenCalled()`); mesmo padrão já
   adotado em auth.service.spec.ts. */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cache } from 'cache-manager';
import { ProfilesService } from './profiles.service';
import { Profile } from './entities/profile.entity';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { TestHelper } from '../../../test/helpers/test.helper';
import { RbacService } from '../rbac/rbac.service';
import { ProvisioningDataSourceService } from '../../shared/database/provisioning-datasource.service';
import { NotFoundException } from '@nestjs/common';

describe('ProfilesService', () => {
  let service: ProfilesService;
  let repo: jest.Mocked<Repository<Profile>>;
  let cacheManager: jest.Mocked<Cache>;
  let provisioningDataSource: {
    isDedicated: jest.Mock;
    requiredTransaction: jest.Mock;
  };
  /**
   * Manager da conexão privilegiada — é onde as escritas de perfil ocorrem.
   *
   * `EntityManager.save` tem duas sobrecargas e o serviço usa **as duas**:
   *   - `create()`  → `manager.save(manager.create(Profile, dto))`  — 1 argumento
   *   - `update()`  → `manager.save(Profile, profile)`              — 2 argumentos
   *
   * O mock precisa modelar as duas. Quando modelava só a de 2 argumentos, a
   * chamada de `create()` gravava `undefined` em `perfisGravados` e o teste
   * ainda passava — exatamente o tipo de mock que esconde regressão de
   * persistência em vez de detectá-la.
   */
  let perfisGravados: Record<string, unknown>[];
  let linhasRemovidas: number;
  const provisioningManager = {
    create: (_entity: unknown, data: Record<string, unknown>) => ({ ...data }),
    save: (
      alvoOuEntidade: unknown,
      talvezEntidade?: Record<string, unknown>,
    ) => {
      const entidade = (talvezEntidade ?? alvoOuEntidade) as Record<
        string,
        unknown
      >;
      perfisGravados.push(entidade);
      return Promise.resolve({ id: 'profile-1', ...entidade });
    },
    delete: () => Promise.resolve({ affected: linhasRemovidas }),
  };

  beforeEach(async () => {
    perfisGravados = [];
    linhasRemovidas = 1;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilesService,
        {
          provide: getRepositoryToken(Profile),
          useValue: TestHelper.mockRepository(),
        },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          provide: RbacService,
          useValue: {
            invalidateUsersByProfileId: jest.fn(),
          },
        },
        {
          // Escritas em `profiles` passam pela conexão privilegiada: as
          // policies de INSERT/UPDATE/DELETE exigem `is_super_admin()`, que é
          // falso para `sgs_app` desde a migration 361. Ver o comentário de
          // classe em profiles.service.ts.
          provide: ProvisioningDataSourceService,
          useValue: (provisioningDataSource = {
            isDedicated: jest.fn(() => true),
            requiredTransaction: jest.fn(
              (_op: string, fn: (m: unknown) => unknown) =>
                Promise.resolve(fn(provisioningManager)),
            ),
          }),
        },
      ],
    }).compile();

    service = module.get<ProfilesService>(ProfilesService);
    repo = module.get(getRepositoryToken(Profile));
    cacheManager = module.get(CACHE_MANAGER);
  });

  describe('findAll', () => {
    it('should return cached profiles', async () => {
      (cacheManager.get as jest.Mock).mockResolvedValue([{ id: 1 }]);
      const result = await service.findAll();
      expect(result).toHaveLength(1);
      expect((repo.find as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('should cache results after fetching', async () => {
      (cacheManager.get as jest.Mock).mockResolvedValue(null);
      (repo.find as jest.Mock).mockResolvedValue([{ id: 1 }]);
      await service.findAll();
      expect((cacheManager.set as jest.Mock).mock.calls).toHaveLength(1);
    });
  });

  /**
   * Travas de regressão de escrita silenciosamente descartada.
   *
   * As policies de INSERT/UPDATE/DELETE de `profiles` (migration 187) exigem
   * `is_super_admin()` e **não têm cláusula de tenant**. Para `sgs_app` isso é
   * escrita morta desde a migration 361, com ou sem `x-company-id`. O efeito
   * era `PATCH /profiles/:id` responder 200 com o payload novo, invalidar os
   * caches e não persistir nada — revogar uma permissão parecia funcionar e a
   * permissão continuava concedida.
   */
  describe('escritas — sempre pela conexão privilegiada', () => {
    it('update persiste pela conexão privilegiada, nunca pelo repositório de runtime', async () => {
      (cacheManager.get as jest.Mock).mockResolvedValue(undefined);
      (repo.findOne as jest.Mock).mockResolvedValue({
        id: 'profile-1',
        nome: 'Técnico',
        permissoes: ['can_view_aprs'],
      });

      await service.update('profile-1', { permissoes: [] });

      expect(provisioningDataSource.requiredTransaction).toHaveBeenCalledWith(
        'profile_update',
        expect.any(Function),
      );
      expect(perfisGravados).toHaveLength(1);
      expect(jest.mocked(repo.save)).not.toHaveBeenCalled();
    });

    it('remove exclui pela conexão privilegiada', async () => {
      (cacheManager.get as jest.Mock).mockResolvedValue(undefined);
      (repo.findOne as jest.Mock).mockResolvedValue({
        id: 'profile-1',
        nome: 'Técnico',
      });

      await service.remove('profile-1');

      expect(provisioningDataSource.requiredTransaction).toHaveBeenCalledWith(
        'profile_delete',
        expect.any(Function),
      );
      expect(jest.mocked(repo.remove)).not.toHaveBeenCalled();
    });

    it('remove falha alto quando 0 linhas são afetadas', async () => {
      // Sem esta guarda, uma exclusão que não aconteceu invalidava os caches e
      // respondia sucesso.
      (cacheManager.get as jest.Mock).mockResolvedValue(undefined);
      (repo.findOne as jest.Mock).mockResolvedValue({
        id: 'profile-1',
        nome: 'Técnico',
      });
      linhasRemovidas = 0;

      await expect(service.remove('profile-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(cacheManager.del).not.toHaveBeenCalled();
    });

    it('create persiste o payload completo pela conexão privilegiada', async () => {
      const resultado = await service.create({
        nome: 'Novo Perfil',
        permissoes: ['can_view_aprs', 'can_edit_aprs'],
        status: true,
      });

      expect(provisioningDataSource.requiredTransaction).toHaveBeenCalledWith(
        'profile_create',
        expect.any(Function),
      );
      expect(jest.mocked(repo.save)).not.toHaveBeenCalled();

      // O que importa não é "chamou save": é que o PAYLOAD chegou inteiro. Com
      // o mock modelando só a sobrecarga de 2 argumentos, o que era gravado
      // aqui era `undefined` e o teste passava do mesmo jeito.
      expect(perfisGravados).toHaveLength(1);
      expect(perfisGravados[0]).toMatchObject({
        nome: 'Novo Perfil',
        permissoes: ['can_view_aprs', 'can_edit_aprs'],
        status: true,
      });
      expect(resultado).toMatchObject({ id: 'profile-1', nome: 'Novo Perfil' });
    });

    it('update persiste as permissões novas, não as antigas', async () => {
      (cacheManager.get as jest.Mock).mockResolvedValue(undefined);
      (repo.findOne as jest.Mock).mockResolvedValue({
        id: 'profile-1',
        nome: 'Técnico',
        permissoes: ['can_view_aprs', 'can_delete_aprs'],
        status: true,
      });

      await service.update('profile-1', {
        permissoes: ['can_view_aprs'],
        status: false,
      });

      expect(perfisGravados).toHaveLength(1);
      expect(perfisGravados[0]).toMatchObject({
        id: 'profile-1',
        nome: 'Técnico',
        permissoes: ['can_view_aprs'],
        status: false,
      });
    });
  });
});
