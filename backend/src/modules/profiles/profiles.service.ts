import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';
import type { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Profile } from './entities/profile.entity';
import { RbacService } from '../rbac/rbac.service';
import { ProvisioningDataSourceService } from '../../shared/database/provisioning-datasource.service';

/**
 * Perfis são a tabela de papéis RBAC — global, sem `company_id`.
 *
 * ## Por que as ESCRITAS passam pela conexão privilegiada
 *
 * As policies de `profiles` (migration 187) são:
 *
 *   SELECT → `rls_global_read`          USING (true)
 *   INSERT → `rls_super_admin_insert`   WITH CHECK (is_super_admin() = true)
 *   UPDATE → `rls_super_admin_update`   USING/CHECK (is_super_admin() = true)
 *   DELETE → `rls_super_admin_delete`   USING (is_super_admin() = true)
 *
 * Note que os predicados de escrita **não têm cláusula de tenant**: dependem
 * exclusivamente de `is_super_admin()`. Desde a migration 361 essa função é
 * falsa para `sgs_app` em qualquer circunstância — com ou sem `x-company-id`.
 *
 * Consequência antes desta correção: `PATCH /profiles/:id` respondia **200 com
 * o payload novo**, invalidava os caches e **não persistia nada**. Revogar uma
 * permissão de um perfil parecia funcionar e não funcionava; a permissão
 * continuava concedida. `DELETE` idem. Só o `create` falhava alto (INSERT
 * viola WITH CHECK), produzindo o pior sinal possível para quem opera: "criar
 * quebra, editar funciona".
 *
 * A leitura continua no repositório de runtime — `USING (true)` funciona para
 * todo mundo e não há motivo para privilegiar SELECT.
 *
 * Alternativa descartada: afrouxar as policies para lerem
 * `current_setting('app.is_super_admin')` direto, como a migration 364 fez em
 * `companies`. Aqui seria pior: `profiles.permissoes` é fonte de verdade do
 * RBAC, e uma sessão `sgs_app` comprometida passaria a poder se autoconceder
 * permissões com um `set_config`.
 */
@Injectable()
export class ProfilesService {
  constructor(
    @InjectRepository(Profile)
    private profilesRepository: Repository<Profile>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly rbacService: RbacService,
    private readonly provisioningDataSource: ProvisioningDataSourceService,
  ) {}

  async create(createProfileDto: DeepPartial<Profile>): Promise<Profile> {
    const saved = await this.provisioningDataSource.requiredTransaction(
      'profile_create',
      (manager) =>
        manager.save(manager.create(Profile, createProfileDto as Profile)),
    );
    await this.cacheManager.del('profiles:all');
    return saved;
  }

  async findAll(): Promise<Profile[]> {
    const cached = await this.cacheManager.get<Profile[]>('profiles:all');
    if (cached) {
      return cached;
    }

    // Profile é uma tabela global de papéis RBAC (sem company_id), criada só
    // por administração — não cresce com uso operacional. Teto de segurança
    // defensivo, não paginação real (não deveria ser atingido na prática).
    const profiles = await this.profilesRepository.find({ take: 1000 });

    // Cache por 24 horas (perfis mudam muito raramente)
    await this.cacheManager.set('profiles:all', profiles, 24 * 60 * 60 * 1000);

    return profiles;
  }

  async findOne(id: string): Promise<Profile> {
    const cached = await this.cacheManager.get<Profile>(`profile:${id}`);
    if (cached) {
      return cached;
    }

    const profile = await this.profilesRepository.findOne({ where: { id } });
    if (!profile) {
      throw new NotFoundException(`Perfil com ID ${id} não encontrado`);
    }

    // Cache por 24 horas
    await this.cacheManager.set(`profile:${id}`, profile, 24 * 60 * 60 * 1000);

    return profile;
  }

  async findByName(nome: string): Promise<Profile | null> {
    // Cache por nome também
    const cached = await this.cacheManager.get<Profile>(`profile:name:${nome}`);
    if (cached) {
      return cached;
    }

    const profile = await this.profilesRepository.findOne({ where: { nome } });

    if (profile) {
      await this.cacheManager.set(
        `profile:name:${nome}`,
        profile,
        24 * 60 * 60 * 1000,
      );
    }

    return profile;
  }

  async update(
    id: string,
    updateProfileDto: DeepPartial<Profile>,
  ): Promise<Profile> {
    const profile = await this.findOne(id);
    const previousName = profile.nome;
    Object.assign(profile, updateProfileDto);
    const saved = await this.provisioningDataSource.requiredTransaction(
      'profile_update',
      (manager) => manager.save(Profile, profile),
    );

    // Invalidar caches
    await this.cacheManager.del('profiles:all');
    await this.cacheManager.del(`profile:${id}`);
    await this.cacheManager.del(`profile:name:${previousName}`);
    await this.cacheManager.del(`profile:name:${saved.nome}`);
    await this.rbacService.invalidateUsersByProfileId(id);

    return saved;
  }

  async remove(id: string): Promise<void> {
    const profile = await this.findOne(id);
    const removidos = await this.provisioningDataSource.requiredTransaction(
      'profile_delete',
      async (manager) => {
        const resultado = await manager.delete(Profile, { id });
        return resultado.affected ?? 0;
      },
    );

    // 0 linhas aqui significaria que o perfil sumiu entre o findOne (que lê do
    // cache) e o delete. Falhar alto é melhor que invalidar caches e responder
    // 200 para uma exclusão que não aconteceu.
    if (removidos === 0) {
      throw new NotFoundException(`Perfil com ID ${id} não encontrado`);
    }

    // Invalidar caches
    await this.cacheManager.del('profiles:all');
    await this.cacheManager.del(`profile:${id}`);
    await this.cacheManager.del(`profile:name:${profile.nome}`);
    await this.rbacService.invalidateUsersByProfileId(id);
  }
}
