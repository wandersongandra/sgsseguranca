import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { TenantService } from '../../shared/tenant/tenant.service';
import { EpiAssignment } from './entities/epi-assignment.entity';
import { EpiAssignmentsService } from './epi-assignments.service';
import { Epi } from '../epis/entities/epi.entity';
import { User } from '../users/entities/user.entity';
import { AuditService } from '../audit-trail/audit.service';
import { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';

const cloneAssignment = (
  dto: Partial<EpiAssignment>,
): Partial<EpiAssignment> => ({ ...dto });

function makeQb() {
  const qb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  return qb;
}

function makeService(overrides: {
  tenantId?: string;
  assignmentsRepository?: Partial<Repository<EpiAssignment>>;
  episRepository?: Partial<Repository<Epi>>;
  usersRepository?: Partial<Repository<User>>;
}) {
  const assignmentsRepository = {
    create: jest.fn((dto: Partial<EpiAssignment>) => cloneAssignment(dto)),
    save: jest.fn((entity: Partial<EpiAssignment>) =>
      Promise.resolve(entity as EpiAssignment),
    ),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue(makeQb()),
    ...overrides.assignmentsRepository,
  } as unknown as Repository<EpiAssignment>;

  const episRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    ...overrides.episRepository,
  } as unknown as Repository<Epi>;

  const usersRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    ...overrides.usersRepository,
  } as unknown as Repository<User>;

  const tenantService = {
    getTenantId: jest.fn().mockReturnValue(overrides.tenantId ?? 'company-1'),
  } as unknown as TenantService;

  const auditService = {
    log: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;

  const signatureTimestampService = {
    issueFromRaw: jest.fn().mockReturnValue({
      signature_hash: 'hash',
      timestamp_token: null,
      timestamp_issued_at: null,
    }),
  } as unknown as SignatureTimestampService;

  return new EpiAssignmentsService(
    assignmentsRepository,
    episRepository,
    {} as never, // sitesRepository — not needed for these unit tests
    usersRepository,
    tenantService,
    signatureTimestampService,
    auditService,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('EpiAssignmentsService', () => {
  describe('create()', () => {
    it('throws NotFoundException when EPI does not belong to the company', async () => {
      const service = makeService({
        episRepository: { findOne: jest.fn().mockResolvedValue(null) },
        usersRepository: { findOne: jest.fn().mockResolvedValue({ id: 'u1' }) },
      });

      await expect(
        service.create({
          epi_id: 'epi-1',
          user_id: 'u1',
          assinatura_entrega: {
            signature_data: 'data',
            signer_name: 'Test',
            signature_type: 'drawn',
          },
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when user does not belong to the company', async () => {
      const mockEpi = { id: 'epi-1', ca: 'CA-001', validade_ca: null };
      const service = makeService({
        episRepository: { findOne: jest.fn().mockResolvedValue(mockEpi) },
        usersRepository: { findOne: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.create({
          epi_id: 'epi-1',
          user_id: 'u1',
          assinatura_entrega: {
            signature_data: 'data',
            signer_name: 'Test',
            signature_type: 'drawn',
          },
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates assignment with status entregue and sets entregue_em', async () => {
      const mockEpi = { id: 'epi-1', ca: 'CA-001', validade_ca: null };
      const mockUser = { id: 'u1', company_id: 'company-1' };
      const created: Partial<EpiAssignment> = {};

      const service = makeService({
        episRepository: { findOne: jest.fn().mockResolvedValue(mockEpi) },
        usersRepository: { findOne: jest.fn().mockResolvedValue(mockUser) },
        assignmentsRepository: {
          create: jest.fn((dto) => {
            Object.assign(created, dto);
            return dto as EpiAssignment;
          }),
          save: jest.fn((entity: Partial<EpiAssignment>) =>
            Promise.resolve(entity as EpiAssignment),
          ),
        } as unknown as Partial<Repository<EpiAssignment>>,
      });

      const sig = {
        signature_data: 'data',
        signer_name: 'Test',
        signature_type: 'drawn',
      } as never;
      await service.create({
        epi_id: 'epi-1',
        user_id: 'u1',
        assinatura_entrega: sig,
      });

      expect(created.status).toBe('entregue');
      expect(created.entregue_em).toBeInstanceOf(Date);
    });

    it('copies ca and validade_ca from the EPI to the assignment', async () => {
      const validadeDate = new Date('2099-12-31');
      const mockEpi = { id: 'epi-1', ca: 'CA-999', validade_ca: validadeDate, status: true };
      const mockUser = { id: 'u1', company_id: 'company-1' };
      const created: Partial<EpiAssignment> = {};

      const service = makeService({
        episRepository: { findOne: jest.fn().mockResolvedValue(mockEpi) },
        usersRepository: { findOne: jest.fn().mockResolvedValue(mockUser) },
        assignmentsRepository: {
          create: jest.fn((dto) => {
            Object.assign(created, dto);
            return dto as EpiAssignment;
          }),
          save: jest.fn((entity: Partial<EpiAssignment>) =>
            Promise.resolve(entity as EpiAssignment),
          ),
        } as unknown as Partial<Repository<EpiAssignment>>,
      });

      const sig = {
        signature_data: 'data',
        signer_name: 'Test',
        signature_type: 'drawn',
      } as never;
      await service.create({
        epi_id: 'epi-1',
        user_id: 'u1',
        assinatura_entrega: sig,
      });

      expect(created.ca).toBe('CA-999');
      expect(created.validade_ca).toBe(validadeDate);
    });
  });

  describe('findOne()', () => {
    it('throws NotFoundException when assignment does not exist', async () => {
      const service = makeService({
        assignmentsRepository: { findOne: jest.fn().mockResolvedValue(null) },
      });

      await expect(service.findOne('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the assignment when found', async () => {
      const mockAssignment = { id: 'assign-1', company_id: 'company-1' };
      const service = makeService({
        assignmentsRepository: {
          findOne: jest.fn().mockResolvedValue(mockAssignment),
        },
      });

      const result = await service.findOne('assign-1');

      expect(result.id).toBe('assign-1');
    });
  });

  describe('getTenantIdOrThrow()', () => {
    it('throws BadRequestException when tenant context is not set', async () => {
      const service = makeService({ tenantId: '' });

      await expect(
        service.create({
          epi_id: 'epi-1',
          user_id: 'u1',
          assinatura_entrega: {
            signature_data: 'data',
            signer_name: 'Test',
            signature_type: 'drawn',
          },
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findPaginated()', () => {
    it('exclui atribuições soft-deletadas (deleted_at IS NULL)', async () => {
      // Regressão LGPD: gdpr_delete_user_data() soft-deleta epi_assignments do
      // titular anonimizado. Sem este filtro, as fichas de um usuário que
      // exerceu o direito de exclusão continuariam aparecendo na listagem.
      const qb = makeQb();
      const service = makeService({
        assignmentsRepository: {
          createQueryBuilder: jest.fn().mockReturnValue(qb),
        },
      });

      await service.findPaginated({});

      expect(qb.andWhere).toHaveBeenCalledWith('assignment.deleted_at IS NULL');
    });
  });
});
