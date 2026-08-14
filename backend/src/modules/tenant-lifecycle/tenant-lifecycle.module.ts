import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantLifecycleController } from './tenant-lifecycle.controller';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { TenantOnboardingInvite } from './entities/tenant-onboarding-invite.entity';
import { Company } from '../companies/entities/company.entity';
import { User } from '../users/entities/user.entity';
import { UserSite } from '../users/entities/user-site.entity';
import { Site } from '../sites/entities/site.entity';
import { Profile } from '../profiles/entities/profile.entity';
import { MailModule } from '../../infra/mail/mail.module';
import { CompaniesModule } from '../companies/companies.module';

@Module({
  imports: [
    // As entidades continuam registradas aqui — não porque o serviço injete
    // repositórios (ele não injeta mais; opera sobre o EntityManager da conexão
    // de provisionamento), mas porque `autoLoadEntities` monta a lista de
    // metadados a partir destes registros, e é dessa lista que o
    // ProvisioningDataSourceService clona as entidades.
    TypeOrmModule.forFeature([
      TenantOnboardingInvite,
      Company,
      User,
      UserSite,
      Site,
      Profile,
    ]),
    CompaniesModule,
    forwardRef(() => MailModule),
  ],
  controllers: [TenantLifecycleController],
  providers: [TenantLifecycleService],
  exports: [TenantLifecycleService],
})
export class TenantLifecycleModule {}
