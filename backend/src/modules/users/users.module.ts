import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { UserSite } from './entities/user-site.entity';
import { Profile } from '../profiles/entities/profile.entity';
import { MedicalExam } from '../medical-exams/entities/medical-exam.entity';
import { Training } from '../trainings/entities/training.entity';
import { EpiAssignment } from '../epi-assignments/entities/epi-assignment.entity';
import { WorkerOperationalStatusService } from './worker-operational-status.service';
import { WorkerTimelineService } from './worker-timeline.service';
import { DocumentRegistryEntry } from '../document-registry/entities/document-registry.entity';
import { SecurityAuditModule } from '../../shared/security/security-audit.module';
import { ConsentsModule } from '../consents/consents.module';
import { PwnedPasswordService } from '../auth/services/pwned-password.service';
import { MailModule } from '../../infra/mail/mail.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    SecurityAuditModule,
    ConsentsModule,
    forwardRef(() => MailModule),
    forwardRef(() => AuthModule),
    TypeOrmModule.forFeature([
      User,
      UserSite,
      Profile,
      MedicalExam,
      Training,
      EpiAssignment,
      DocumentRegistryEntry,
    ]),
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    WorkerOperationalStatusService,
    WorkerTimelineService,
    PwnedPasswordService,
  ],
  exports: [
    UsersService,
    WorkerOperationalStatusService,
    WorkerTimelineService,
  ],
})
export class UsersModule {}
