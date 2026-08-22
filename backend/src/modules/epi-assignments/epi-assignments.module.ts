import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit-trail/audit.module';
import { CommonModule } from '../../shared/common.module';
import { Epi } from '../epis/entities/epi.entity';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { EpisModule } from '../epis/epis.module';
import { DocumentRegistryModule } from '../document-registry/document-registry.module';
import { EpiAssignmentsController } from './epi-assignments.controller';
import { EpiAssignmentsService } from './epi-assignments.service';
import { EpiAssignment } from './entities/epi-assignment.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([EpiAssignment, Epi, Site, User]),
    CommonModule,
    AuditModule,
    forwardRef(() => UsersModule),
    EpisModule,
    DocumentRegistryModule,
  ],
  controllers: [EpiAssignmentsController],
  providers: [EpiAssignmentsService],
  exports: [EpiAssignmentsService],
})
export class EpiAssignmentsModule {}
