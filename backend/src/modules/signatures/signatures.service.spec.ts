import { Repository } from 'typeorm';
import { SignaturesService } from './signatures.service';
import { Signature } from './entities/signature.entity';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { UsersService } from '../users/users.service';
import type { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import type { AppendForensicTrailEventInput } from '../forensic-trail/forensic-trail.service';
import type { DataSource } from 'typeorm';
import { Apr, AprStatus } from '../aprs/entities/apr.entity';
import { Dds } from '../dds/entities/dds.entity';
import { Cat } from '../cats/entities/cat.entity';
import { Inspection } from '../../shared/entities/inspection.entity';
import { Rdo } from '../rdos/entities/rdo.entity';
import { Training } from '../trainings/entities/training.entity';
import {
  SIGNATURE_PROOF_SCOPES,
  SIGNATURE_VERIFICATION_MODES,
} from './signature-proof.util';
import { stringMatchingMatcher } from '../../../test/helpers/typed-matchers';

describe('SignaturesService', () => {
  let service: SignaturesService;
  let storageService: {
    uploadFile: jest.Mock;
    createReference: jest.Mock;
    downloadFileBuffer: jest.Mock;
    deleteFile: jest.Mock;
    referenceForExistingObject: jest.Mock;
  };
  const savedEntities: Signature[] = [];

  const transactionalRepository = {
    create: jest.fn((input: Signature) => input),
    save: jest.fn((input: Signature) => {
      savedEntities.push(input);
      return Promise.resolve(input);
    }),
    find: jest.fn(() => Promise.resolve([] as Signature[])),
    findOne: jest.fn(() => Promise.resolve(null as Signature | null)),
    delete: jest.fn(() => Promise.resolve(undefined)),
    softDelete: jest.fn(() => Promise.resolve({ affected: 1 })),
  };

  const queryBuilder = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    getMany: jest.fn<Promise<Signature[]>, []>(),
  };
  const trainingScopeQueryBuilder = {
    leftJoin: jest.fn(),
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getRawOne: jest.fn<
      Promise<{ company_id: string; site_id: string | null } | null>,
      []
    >(),
  };

  const repository = {
    create: jest.fn((input: Signature) => input),
    save: jest.fn((input: Signature) => Promise.resolve(input)),
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    softDelete: jest.fn(() => Promise.resolve({ affected: 1 })),
    createQueryBuilder: jest.fn(() => queryBuilder),
    manager: {
      transaction: jest.fn((callback: (manager: unknown) => unknown) =>
        Promise.resolve(
          callback({
            query: jest.fn(() => Promise.resolve([{ id: 'dds-1' }])),
            getRepository: jest.fn(() => transactionalRepository),
          }),
        ),
      ),
    },
  };

  const signatureTimestampService = {
    issueFromHash: jest.fn(() => ({
      signature_hash: 'hash-1',
      timestamp_token: 'token-1',
      timestamp_authority: 'authority-1',
      timestamp_issued_at: '2026-03-16T12:00:00.000Z',
    })),
    verify: jest.fn(),
  };

  const documentGovernanceService = {
    findRegistryContextForSignature: jest.fn(() => Promise.resolve(null)),
  };

  const forensicTrailService = {
    append: jest.fn(() =>
      Promise.resolve({ id: 'trail-1' } as unknown as Awaited<
        ReturnType<ForensicTrailService['append']>
      >),
    ),
  };

  const usersService = {
    deriveHmacKey: jest.fn(() => Promise.resolve('derived-key')),
    computeHmac: jest.fn(() => 'computed-hmac'),
  };

  const aprRepository = {
    findOne: jest.fn().mockResolvedValue(null as Partial<Apr> | null),
  };
  const catRepository = {
    findOne: jest
      .fn()
      .mockResolvedValue(null as Record<string, unknown> | null),
  };
  const inspectionRepository = {
    findOne: jest
      .fn()
      .mockResolvedValue(null as Record<string, unknown> | null),
  };
  const rdoRepository = {
    findOne: jest
      .fn()
      .mockResolvedValue(null as Record<string, unknown> | null),
  };

  const dataSource = {
    query: jest.fn(() => Promise.resolve([{ count: '0' }])),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === Apr) {
        return aprRepository;
      }

      if (entity === Dds) {
        return {
          findOne: jest.fn(() =>
            Promise.resolve({
              id: 'dds-1',
              company_id: 'company-1',
              site_id: 'site-1',
              tema: 'DDS diário',
              status: 'publicado',
              updated_at: new Date('2026-03-16T11:55:00.000Z'),
            }),
          ),
        };
      }

      if (entity === Cat) {
        return catRepository;
      }

      if (entity === Inspection) {
        return inspectionRepository;
      }

      if (entity === Rdo) {
        return rdoRepository;
      }

      if (entity === Training) {
        return {
          createQueryBuilder: jest.fn(() => trainingScopeQueryBuilder),
        };
      }

      return {
        findOne: jest.fn(() => Promise.resolve(null)),
      };
    }),
  };

  beforeEach(() => {
    savedEntities.length = 0;
    jest.clearAllMocks();
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);
    queryBuilder.orderBy.mockReturnValue(queryBuilder);
    queryBuilder.getMany.mockResolvedValue([]);
    trainingScopeQueryBuilder.leftJoin.mockReturnValue(
      trainingScopeQueryBuilder,
    );
    trainingScopeQueryBuilder.select.mockReturnValue(trainingScopeQueryBuilder);
    trainingScopeQueryBuilder.addSelect.mockReturnValue(
      trainingScopeQueryBuilder,
    );
    trainingScopeQueryBuilder.where.mockReturnValue(trainingScopeQueryBuilder);
    trainingScopeQueryBuilder.andWhere.mockReturnValue(
      trainingScopeQueryBuilder,
    );
    trainingScopeQueryBuilder.getRawOne.mockResolvedValue(null);
    transactionalRepository.find.mockResolvedValue([]);
    dataSource.query.mockResolvedValue([{ count: '0' }]);
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      numero: 'APR-001',
      versao: 1,
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
      updated_at: new Date('2026-03-16T11:55:00.000Z'),
    });
    catRepository.findOne.mockResolvedValue({
      id: 'cat-1',
      company_id: 'company-1',
      site_id: 'site-1',
      numero: 'CAT-001',
      status: 'aberta',
      pdf_file_key: null,
      updated_at: new Date('2026-03-16T11:55:00.000Z'),
    });
    inspectionRepository.findOne.mockResolvedValue({
      id: 'inspection-1',
      company_id: 'company-1',
      site_id: 'site-1',
      tipo_inspecao: 'Rotina',
      setor_area: 'Caldeiraria',
      updated_at: new Date('2026-03-16T11:55:00.000Z'),
    });
    rdoRepository.findOne.mockResolvedValue({
      id: 'rdo-1',
      company_id: 'company-1',
      site_id: 'site-1',
      numero: 'RDO-001',
      status: 'enviado',
      pdf_file_key: null,
      updated_at: new Date('2026-03-16T11:55:00.000Z'),
    });

    storageService = {
      uploadFile: jest.fn().mockResolvedValue(undefined),
      createReference: jest.fn((reference: unknown) => reference),
      downloadFileBuffer: jest.fn().mockResolvedValue(Buffer.from('')),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      referenceForExistingObject: jest.fn((key: string) => ({
        tenantId: 'company-1',
        key,
        owner: { resourceType: 'test', resourceId: key },
        purpose: 'test',
        legacy: !key.startsWith('documents/company-1/'),
      })),
    };

    service = new SignaturesService(
      repository as unknown as Repository<Signature>,
      dataSource as unknown as DataSource,
      { getTenantId: jest.fn(() => 'company-1') } as unknown as TenantService,
      signatureTimestampService as unknown as SignatureTimestampService,
      documentGovernanceService as unknown as DocumentGovernanceService,
      usersService as unknown as UsersService,
      forensicTrailService as unknown as ForensicTrailService,
      storageService as never,
    );
  });

  const useSiteScopedTenant = (siteIds = ['site-a']) => {
    service = new SignaturesService(
      repository as unknown as Repository<Signature>,
      dataSource as unknown as DataSource,
      {
        getTenantId: jest.fn(() => 'company-1'),
        getContext: jest.fn(() => ({
          companyId: 'company-1',
          userId: 'user-obra-a',
          siteId: siteIds[0],
          siteIds,
          siteScope: 'single',
          isSuperAdmin: false,
        })),
      } as unknown as TenantService,
      signatureTimestampService as unknown as SignatureTimestampService,
      documentGovernanceService as unknown as DocumentGovernanceService,
      usersService as unknown as UsersService,
      forensicTrailService as unknown as ForensicTrailService,
      storageService as never,
    );
  };

  it('permite assinatura DDS direta somente para participante vinculado', async () => {
    dataSource.query.mockResolvedValueOnce([{ user_id: 'user-1' }] as never);

    await expect(
      service.create(
        {
          document_id: 'dds-1',
          document_type: 'DDS',
          user_id: 'user-1',
          signature_data: 'data:image/png;base64,AAAA',
          type: 'drawn',
        },
        'user-1',
      ),
    ).resolves.toBeDefined();

    dataSource.query.mockResolvedValueOnce([]);
    await expect(
      service.create(
        {
          document_id: 'dds-1',
          document_type: 'DDS',
          user_id: 'user-2',
          signature_data: 'data:image/png;base64,BBBB',
          type: 'drawn',
        },
        'user-2',
      ),
    ).rejects.toThrow(
      'Somente participantes vinculados ao DDS podem assiná-lo por este fluxo.',
    );
  });

  it('rejeita replay de assinatura DDS direta para o mesmo participante', async () => {
    dataSource.query.mockResolvedValue([{ user_id: 'user-1' }] as never);
    transactionalRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'signature-1' } as Signature);

    const input = {
      document_id: 'dds-1',
      document_type: 'DDS',
      user_id: 'user-1',
      signature_data: 'data:image/png;base64,AAAA',
      type: 'drawn',
    } as const;

    await expect(service.create(input, 'user-1')).resolves.toBeDefined();
    await expect(service.create(input, 'user-1')).rejects.toThrow(
      'Usuário já possui uma assinatura ativa para este DDS.',
    );
    expect(transactionalRepository.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        document_id: 'dds-1',
        document_type: 'DDS',
        company_id: 'company-1',
        user_id: 'user-1',
      }) as unknown,
    });
  });

  it('usa o participante como signatario efetivo ao substituir assinaturas do DDS', async () => {
    await service.replaceDocumentSignatures({
      document_id: 'dds-1',
      document_type: 'DDS',
      company_id: 'company-1',
      authenticated_user_id: 'operador-1',
      signatures: [
        {
          document_id: 'dds-1',
          document_type: 'DDS',
          user_id: 'participante-1',
          signer_user_id: 'participante-1',
          type: 'hmac',
          signature_data: 'HMAC_PENDING',
          pin: '1234',
        },
      ],
    });

    expect(usersService.deriveHmacKey).toHaveBeenCalledWith(
      'participante-1',
      '1234',
    );
    expect(usersService.computeHmac).toHaveBeenCalledWith(
      'derived-key',
      expect.stringContaining('participante-1'),
    );
    expect(transactionalRepository.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        document_id: 'dds-1',
        document_type: 'DDS',
      }),
    );
    const persistedSignature = savedEntities[0];

    expect(persistedSignature).toEqual(
      expect.objectContaining({
        user_id: 'participante-1',
        document_id: 'dds-1',
        document_type: 'DDS',
        site_id: 'site-1',
        signature_data: 'computed-hmac',
        type: 'hmac',
        signature_hash: 'hash-1',
        timestamp_token: 'token-1',
      }),
    );
    const integrityPayload = persistedSignature?.integrity_payload;
    if (!integrityPayload) {
      throw new Error('Expected persisted integrity payload');
    }
    const documentBinding = integrityPayload.document_binding as
      Record<string, unknown> | undefined;
    if (!documentBinding) {
      throw new Error('Expected persisted document binding');
    }
    expect(integrityPayload.verification_mode).toBe(
      SIGNATURE_VERIFICATION_MODES.SERVER_VERIFIABLE,
    );
    expect(integrityPayload.proof_scope).toBe(
      SIGNATURE_PROOF_SCOPES.DOCUMENT_REVISION,
    );
    expect(integrityPayload.user_id).toBe('participante-1');
    expect(integrityPayload.captured_by_user_id).toBe('operador-1');
    expect(integrityPayload.hmac_verified).toBe(true);
    expect(integrityPayload.canonical_payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(integrityPayload.signature_evidence_hash).toEqual(
      expect.any(String),
    );
    expect(documentBinding.proof_scope).toBe(
      SIGNATURE_PROOF_SCOPES.DOCUMENT_REVISION,
    );
    expect(documentBinding.reference).toBe('DDS diário');
    expect(documentBinding.status).toBe('publicado');
    expect(signatureTimestampService.issueFromHash).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String),
    );
    const appendCalls = (forensicTrailService.append as jest.Mock).mock
      .calls as Array<[AppendForensicTrailEventInput, { manager?: unknown }]>;
    const firstAppendCall = appendCalls[0];
    if (!firstAppendCall) {
      throw new Error('Expected forensic append call');
    }
    const [appendInput, appendOptions] = firstAppendCall;
    const appendMetadata = appendInput.metadata as Record<string, unknown>;
    expect(appendInput.eventType).toBe(FORENSIC_EVENT_TYPES.SIGNATURE_RECORDED);
    expect(appendInput.module).toBe('dds');
    expect(appendInput.entityId).toBe('dds-1');
    expect(appendInput.companyId).toBe('company-1');
    expect(appendInput.userId).toBe('participante-1');
    expect(appendMetadata.signatureType).toBe('hmac');
    expect(appendMetadata.documentType).toBe('DDS');
    expect(appendMetadata.signatureHash).toBe('hash-1');
    expect(appendMetadata.verificationMode).toBe(
      SIGNATURE_VERIFICATION_MODES.SERVER_VERIFIABLE,
    );
    expect(appendMetadata.proofScope).toBe(
      SIGNATURE_PROOF_SCOPES.DOCUMENT_REVISION,
    );
    expect(appendOptions.manager).toBeDefined();
  });

  it('reutiliza o manager recebido sem abrir uma transação aninhada', async () => {
    const transactionManager = {
      getRepository: jest.fn(() => transactionalRepository),
    };

    await service.replaceDocumentSignatures({
      document_id: 'dds-1',
      document_type: 'DDS',
      company_id: 'company-1',
      authenticated_user_id: 'operador-1',
      signatures: [],
      manager: transactionManager as never,
    });

    expect(repository.manager.transaction).not.toHaveBeenCalled();
    expect(transactionalRepository.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        document_id: 'dds-1',
        document_type: 'DDS',
      }),
    );
  });

  it('hidrata signature_data externalizado ao listar assinaturas do documento', async () => {
    repository.find.mockResolvedValue([
      {
        id: 'signature-1',
        company_id: 'company-1',
        document_id: 'dds-1',
        document_type: 'DDS',
        user_id: 'user-1',
        type: 'drawn',
        signature_data: null,
        signature_data_key: 'signatures/dds-1/digital.dat',
        user: {
          id: 'user-1',
          nome: 'Ana',
          funcao: 'TST',
          cpf: '12345678901',
          email: 'ana@example.test',
          profile: { id: 'profile-1', nome: 'TST' },
        },
      },
    ]);
    storageService.downloadFileBuffer.mockResolvedValue(
      Buffer.from('data:image/png;base64,ASSINATURA', 'utf8'),
    );

    const result = await service.findByDocument('dds-1', 'DDS');

    expect(repository.find).toHaveBeenCalledWith({
      where: {
        document_id: 'dds-1',
        document_type: 'DDS',
        company_id: 'company-1',
        deleted_at: expect.anything() as unknown,
      },
      relations: { user: true },
      select: {
        user: {
          id: true,
          nome: true,
          funcao: true,
        },
      },
    });
    expect(storageService.downloadFileBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'signatures/dds-1/digital.dat' }),
    );
    expect(result[0]).toEqual(
      expect.objectContaining({
        signature_data: 'data:image/png;base64,ASSINATURA',
        user: {
          id: 'user-1',
          nome: 'Ana',
          funcao: 'TST',
        },
      }),
    );
  });

  it('usa chave S3 não colisível ao externalizar evidência grande', async () => {
    const signatureData = `data:image/png;base64,${'A'.repeat(5000)}`;

    await service.create(
      {
        document_id: 'apr-1',
        document_type: 'APR',
        user_id: 'user-1',
        signature_data: signatureData,
        type: 'drawn',
      },
      'user-1',
    );

    expect(storageService.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: stringMatchingMatcher(
          /^documents\/company-1\/signatures\/apr-1\/drawn-\d+-[0-9a-f-]{36}\.dat$/,
        ),
      }),
      Buffer.from(signatureData, 'utf8'),
      'application/octet-stream',
    );
  });

  it('persiste site_id resolvido do documento assinado', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-obra-a',
      company_id: 'company-1',
      site_id: 'site-a',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
      updated_at: new Date('2026-03-16T11:55:00.000Z'),
    });
    useSiteScopedTenant();

    await service.create(
      {
        document_id: 'apr-obra-a',
        document_type: 'APR',
        user_id: 'user-obra-a',
        signature_data: 'data:image/png;base64,ASSINATURA_OBRA_A',
        type: 'drawn',
      },
      'user-obra-a',
    );

    const createdSignature = savedEntities[savedEntities.length - 1];
    const canonicalPayload = createdSignature?.integrity_payload
      ?.canonical_payload as Record<string, unknown> | undefined;
    const canonicalDocument = canonicalPayload?.document as
      Record<string, unknown> | undefined;
    const documentBinding = createdSignature?.integrity_payload
      ?.document_binding as Record<string, unknown> | undefined;

    expect(createdSignature).toEqual(
      expect.objectContaining({
        company_id: 'company-1',
        site_id: 'site-a',
      }),
    );
    expect(canonicalDocument?.site_id).toBe('site-a');
    expect(documentBinding?.site_id).toBe('site-a');
  });

  it('filtra busca em lote pelo escopo de obras do usuario', async () => {
    useSiteScopedTenant(['site-a', 'site-c']);

    await expect(
      service.findManyByDocuments(['dds-a', 'dds-c'], 'DDS'),
    ).resolves.toEqual([]);

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'signature.site_id IN (:...siteIds)',
      { siteIds: ['site-a', 'site-c'] },
    );
  });

  it('bloqueia leitura de assinaturas quando o documento pertence a outra obra', async () => {
    repository.find.mockResolvedValue([
      {
        id: 'signature-obra-b',
        company_id: 'company-1',
        document_id: 'apr-obra-b',
        document_type: 'APR',
        user_id: 'user-obra-b',
        type: 'drawn',
        signature_data: 'data:image/png;base64,ASSINATURA_OBRA_B',
      },
    ]);
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-obra-b',
      company_id: 'company-1',
      site_id: 'site-b',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    });
    useSiteScopedTenant();

    await expect(service.findByDocument('apr-obra-b', 'APR')).rejects.toThrow(
      'Documento não encontrado para assinaturas.',
    );
    expect(repository.find).not.toHaveBeenCalled();
    expect(storageService.downloadFileBuffer).not.toHaveBeenCalled();
  });

  it('permite leitura de assinatura da mesma obra sem retornar PII excessiva', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-obra-a',
      company_id: 'company-1',
      site_id: 'site-a',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    });
    repository.find.mockResolvedValue([
      {
        id: 'signature-obra-a',
        company_id: 'company-1',
        document_id: 'apr-obra-a',
        document_type: 'APR',
        user_id: 'user-obra-a',
        type: 'drawn',
        signature_data: 'data:image/png;base64,ASSINATURA_OBRA_A',
        user: {
          id: 'user-obra-a',
          nome: 'Ana',
          funcao: 'TST',
          cpf: '12345678901',
          email: 'ana@example.test',
        },
      },
    ]);
    useSiteScopedTenant();

    const result = await service.findByDocument('apr-obra-a', 'APR');

    expect(result[0]?.user).toEqual({
      id: 'user-obra-a',
      nome: 'Ana',
      funcao: 'TST',
    });
  });

  it('mantem assinatura legada de treinamento roteavel pelo site do trabalhador', async () => {
    useSiteScopedTenant(['site-a']);
    trainingScopeQueryBuilder.getRawOne.mockResolvedValue({
      company_id: 'company-1',
      site_id: 'site-a',
    });
    repository.find.mockResolvedValue([
      {
        id: 'signature-training',
        company_id: 'company-1',
        document_id: 'training-1',
        document_type: 'TREINAMENTO',
        user_id: 'worker-a',
        type: 'drawn',
        signature_data: 'data:image/png;base64,ASSINATURA_TREINAMENTO',
        user: {
          id: 'worker-a',
          nome: 'Trabalhador A',
          funcao: 'Operador',
          cpf: '12345678901',
          email: 'worker@example.test',
        },
      },
    ]);

    const result = await service.findByDocument('training-1', 'TREINAMENTO');

    expect(dataSource.getRepository).toHaveBeenCalledWith(Training);
    expect(trainingScopeQueryBuilder.where).toHaveBeenCalledWith(
      'training.id = :documentId',
      { documentId: 'training-1' },
    );
    expect(result[0]?.user).toEqual({
      id: 'worker-a',
      nome: 'Trabalhador A',
      funcao: 'Operador',
    });
  });

  it('bloqueia criação de assinatura quando o documento pertence a outra obra', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-obra-b',
      company_id: 'company-1',
      site_id: 'site-b',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    });
    useSiteScopedTenant();

    await expect(
      service.create(
        {
          document_id: 'apr-obra-b',
          document_type: 'APR',
          signature_data: 'data:image/png;base64,ASSINATURA_OBRA_A',
          type: 'drawn',
          user_id: 'user-obra-a',
        },
        'user-obra-a',
      ),
    ).rejects.toThrow('Documento não encontrado para assinaturas.');
    expect(repository.manager.transaction).not.toHaveBeenCalled();
  });

  it('bloqueia criação de assinatura vinculada a RDO inexistente', async () => {
    rdoRepository.findOne.mockResolvedValue(null);

    await expect(
      service.create(
        {
          document_id: 'rdo-inexistente',
          document_type: 'RDO',
          signature_data: 'data:image/png;base64,ASSINATURA',
          type: 'drawn',
          user_id: 'user-1',
        },
        'user-1',
      ),
    ).rejects.toThrow('Documento não encontrado para assinaturas.');
    expect(repository.manager.transaction).not.toHaveBeenCalled();
  });

  it('bloqueia verificação autenticada quando a assinatura pertence a outra obra', async () => {
    repository.findOne.mockResolvedValue({
      id: 'signature-obra-b',
      company_id: 'company-1',
      document_id: 'apr-obra-b',
      document_type: 'APR',
      user_id: 'user-obra-b',
      signature_hash: 'hash-obra-b',
      timestamp_token: 'token-obra-b',
    });
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-obra-b',
      company_id: 'company-1',
      site_id: 'site-b',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    });
    useSiteScopedTenant();

    await expect(service.verifyById('signature-obra-b')).rejects.toThrow(
      'Documento não encontrado para assinaturas.',
    );
    expect(signatureTimestampService.verify).not.toHaveBeenCalled();
  });

  it('bloqueia remoção de assinaturas quando o documento pertence a outra obra', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-obra-b',
      company_id: 'company-1',
      site_id: 'site-b',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    });
    useSiteScopedTenant();

    await expect(
      service.removeByDocument('apr-obra-b', 'APR', 'user-obra-a'),
    ).rejects.toThrow('Documento não encontrado para assinaturas.');
    expect(repository.find).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
    // soft delete not asserted in this path
    // Note: softDelete not expected in this negative test path
  });

  it('remove evidência externalizada do storage após excluir assinatura', async () => {
    repository.findOne.mockResolvedValue({
      id: 'signature-1',
      company_id: 'company-1',
      document_id: 'apr-1',
      document_type: 'APR',
      user_id: 'user-1',
      signature_data: null,
      signature_data_key: 'signatures/apr-1/digital.dat',
    });

    await service.remove('signature-1', 'user-1');

    expect(repository.softDelete).toHaveBeenCalledWith({ id: 'signature-1' });
    expect(storageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'signatures/apr-1/digital.dat' }),
    );
  });

  it('remove evidências externalizadas do storage após excluir por documento', async () => {
    repository.find.mockResolvedValue([
      {
        id: 'signature-1',
        company_id: 'company-1',
        document_id: 'apr-1',
        document_type: 'APR',
        user_id: 'user-1',
        signature_data: null,
        signature_data_key: 'signatures/apr-1/digital.dat',
      },
    ]);

    await service.removeByDocument('apr-1', 'APR', 'user-1');

    expect(storageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'signatures/apr-1/digital.dat' }),
    );
  });

  it('remove evidências externalizadas do storage após exclusão interna', async () => {
    repository.find.mockResolvedValue([
      {
        id: 'signature-1',
        signature_data_key: 'signatures/apr-1/digital.dat',
      },
    ]);

    await expect(service.removeByDocumentSystem('apr-1', 'APR')).resolves.toBe(
      1,
    );

    expect(storageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'signatures/apr-1/digital.dat' }),
    );
  });

  it('permite exclusão interna após soft delete quando o escopo conhecido pertence à obra', async () => {
    repository.find.mockResolvedValue([]);
    useSiteScopedTenant();

    await expect(
      service.removeByDocumentSystem('checklist-removido', 'CHECKLIST', {
        companyId: 'company-1',
        siteId: 'site-a',
      }),
    ).resolves.toBe(1);
  });

  it('bloqueia exclusão interna quando o escopo conhecido pertence a outra obra', async () => {
    useSiteScopedTenant();

    await expect(
      service.removeByDocumentSystem('checklist-obra-b', 'CHECKLIST', {
        companyId: 'company-1',
        siteId: 'site-b',
      }),
    ).rejects.toThrow('Documento não encontrado para assinaturas.');
    expect(repository.find).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
    // soft delete not asserted in this path
    // Note: softDelete not expected in this negative test path
  });

  it('remove evidências externalizadas substituídas no fluxo em lote', async () => {
    transactionalRepository.find.mockResolvedValue([
      {
        id: 'signature-antiga',
        signature_data_key: 'signatures/dds-1/team-photo.dat',
      } as unknown as Signature,
    ]);

    await service.replaceDocumentSignatures({
      document_id: 'dds-1',
      document_type: 'DDS',
      company_id: 'company-1',
      authenticated_user_id: 'operador-1',
      signatures: [],
    });

    expect(storageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'signatures/dds-1/team-photo.dat' }),
    );
  });

  it('incorpora o integrity_context ao envelope canônico da assinatura HMAC', async () => {
    await service.createWithManager(
      {
        document_id: 'dds-1',
        document_type: 'DDS',
        user_id: 'user-1',
        company_id: 'company-1',
        type: 'hmac',
        signature_data: 'HMAC_PENDING',
        pin: '1234',
        integrity_context: {
          scope: 'dds_approval_flow',
          approval_cycle: 2,
          approval_level_order: 1,
        },
      },
      'user-1',
      {
        getRepository: jest.fn(() => transactionalRepository),
      } as never,
      'user-1',
    );

    const createdSignature = savedEntities[savedEntities.length - 1];
    if (!createdSignature?.integrity_payload) {
      throw new Error('Expected DDS integrity payload');
    }

    expect(createdSignature.integrity_payload.signature_context).toEqual({
      scope: 'dds_approval_flow',
      approval_cycle: 2,
      approval_level_order: 1,
    });
    expect(createdSignature.integrity_payload.signature_context_hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('bloqueia novas assinaturas para document_type legado de inspeção', async () => {
    await expect(
      service.create(
        {
          document_id: 'inspection-1',
          document_type: 'Inspeção',
          user_id: 'user-1',
          signature_data: 'data:image/png;base64,BBBB',
          type: 'drawn',
        },
        'user-1',
      ),
    ).rejects.toThrow(
      'Novas assinaturas para relatório de inspeção foram descontinuadas.',
    );
  });

  it('ignora hashes e tokens enviados pelo cliente e valida o envelope server-side', async () => {
    await service.create(
      {
        document_id: 'apr-1',
        document_type: 'APR',
        user_id: 'user-1',
        signature_data: 'data:image/png;base64,AAAA',
        type: 'drawn',
        signature_hash: 'client-hash',
        timestamp_token: 'client-token',
        timestamp_authority: 'client-authority',
      },
      'user-1',
    );

    const createdSignature = savedEntities[savedEntities.length - 1];
    if (!createdSignature) {
      throw new Error('Expected created signature');
    }
    expect(createdSignature.signature_hash).toBe('hash-1');
    expect(createdSignature.timestamp_token).toBe('token-1');
    expect(createdSignature.timestamp_authority).toBe('authority-1');

    repository.findOne.mockResolvedValue({
      id: 'sig-1',
      signature_hash: 'hash-1',
      timestamp_token: 'token-1',
      timestamp_authority: 'authority-1',
      signed_at: new Date('2026-03-16T12:00:00.000Z'),
      document_id: 'apr-1',
      document_type: 'APR',
      type: 'drawn',
      integrity_payload: {
        verification_mode: SIGNATURE_VERIFICATION_MODES.SERVER_VERIFIABLE,
        legal_assurance: 'not_legal_strong',
        proof_scope: SIGNATURE_PROOF_SCOPES.DOCUMENT_REVISION,
        signature_evidence_hash: 'evidence-hash',
        document_binding: {
          binding_hash: 'binding-hash',
        },
      },
    });
    signatureTimestampService.verify.mockReturnValue(true);

    const result = await service.verifyById('sig-1');

    expect(result).toEqual(
      expect.objectContaining({
        id: 'sig-1',
        valid: true,
        verification_mode: SIGNATURE_VERIFICATION_MODES.SERVER_VERIFIABLE,
        proof_scope: SIGNATURE_PROOF_SCOPES.DOCUMENT_REVISION,
        document_binding_hash: 'binding-hash',
        signature_evidence_hash: 'evidence-hash',
      }),
    );
  });

  describe('allowlist de tipo de assinatura', () => {
    const baseInput = {
      document_id: 'apr-1',
      document_type: 'APR',
      user_id: 'user-1',
      signature_data: 'data:image/png;base64,AAAA',
    };

    it.each(['digital', 'facial', 'simple', 'cpf_pin'])(
      'recusa o tipo legado "%s" (rótulo de prova sem verificação)',
      async (legacyType) => {
        // Regressão: o `type` era string livre e virava o rótulo impresso no
        // PDF governado — dava para gravar "digital" (apresentado como
        // "Assinatura Digital") sem nenhuma verificação criptográfica.
        await expect(
          service.create({ ...baseInput, type: legacyType }, 'user-1'),
        ).rejects.toThrow(/descontinuado por não representar prova verificada/);
      },
    );

    it('recusa tipo arbitrário inventado pelo cliente', async () => {
      await expect(
        service.create(
          { ...baseInput, type: 'assinatura_notarial_icp' },
          'user-1',
        ),
      ).rejects.toThrow(/Tipo de assinatura inválido/);
    });

    it.each(['drawn', 'upload', 'acknowledgement'])(
      'aceita o tipo canônico "%s"',
      async (type) => {
        await expect(
          service.create({ ...baseInput, type }, 'user-1'),
        ).resolves.toBeDefined();
      },
    );

    it('aceita team_photo_* do DDS', async () => {
      await expect(
        service.create({ ...baseInput, type: 'team_photo_1' }, 'user-1'),
      ).resolves.toBeDefined();
    });
  });

  it('prioriza o tenant autenticado sobre company_id legado no payload', async () => {
    await service.create(
      {
        document_id: 'apr-1',
        document_type: 'APR',
        user_id: 'user-1',
        signature_data: 'data:image/png;base64,AAAA',
        type: 'drawn',
        company_id: 'forged-company',
      } as unknown as Parameters<SignaturesService['create']>[0],
      'user-1',
    );

    const createdSignature = savedEntities[savedEntities.length - 1];

    expect(createdSignature.company_id).toBe('company-1');
    expect(createdSignature.site_id).toBe('site-1');
    expect(
      documentGovernanceService.findRegistryContextForSignature,
    ).toHaveBeenCalledWith('apr-1', 'APR', 'company-1');
  });

  it('não expõe metadados documentais sensíveis na validação pública por hash', async () => {
    // O serviço usa dataSource.query com SECURITY DEFINER — não passa pelo repository.
    // A função retorna somente as 6 colunas de prova técnica (sem id, document_id, etc.).
    dataSource.query.mockResolvedValueOnce([
      {
        signature_hash: 'a'.repeat(64),
        timestamp_token: 'token-1',
        timestamp_authority: 'authority-1',
        signed_at: new Date('2026-03-16T12:00:00.000Z'),
        type: 'hmac',
        integrity_payload: {
          verification_mode: SIGNATURE_VERIFICATION_MODES.SERVER_VERIFIABLE,
          legal_assurance: 'not_legal_strong',
          proof_scope: SIGNATURE_PROOF_SCOPES.DOCUMENT_REVISION,
          signature_evidence_hash: 'evidence-hash',
          document_binding: {
            binding_hash: 'binding-hash',
          },
        },
      },
    ] as never);
    signatureTimestampService.verify.mockReturnValue(true);

    await expect(service.verifyByHashPublic('a'.repeat(64))).resolves.toEqual({
      valid: true,
      message: 'Assinatura validada com sucesso.',
      signature: {
        hash: 'a'.repeat(64),
        signed_at: '2026-03-16T12:00:00.000Z',
        timestamp_authority: 'authority-1',
        type: 'hmac',
        verification_mode: SIGNATURE_VERIFICATION_MODES.SERVER_VERIFIABLE,
        legal_assurance: 'not_legal_strong',
        proof_scope: SIGNATURE_PROOF_SCOPES.DOCUMENT_REVISION,
        document_binding_hash: 'binding-hash',
        signature_evidence_hash: 'evidence-hash',
      },
    });
  });

  it('bloqueia criacao de assinatura quando a APR nao esta mais pendente', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: null,
    });

    await expect(
      service.create(
        {
          document_id: 'apr-1',
          document_type: 'APR',
          user_id: 'user-1',
          signature_data: 'data:image/png;base64,AAAA',
          type: 'drawn',
        },
        'user-1',
      ),
    ).rejects.toThrow(
      /Somente APRs pendentes podem ter assinaturas alteradas diretamente\./,
    );
  });

  it('bloqueia remocao de assinaturas quando a APR ja possui PDF final emitido', async () => {
    repository.find.mockResolvedValue([
      {
        id: 'sig-1',
        document_id: 'apr-1',
        document_type: 'APR',
        company_id: 'company-1',
        user_id: 'user-1',
      },
    ]);
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: 'documents/company-1/aprs/apr-1/apr-final.pdf',
    });

    await expect(
      service.removeByDocument('apr-1', 'APR', 'user-1'),
    ).rejects.toThrow(
      /APR com PDF final emitido está bloqueada para alterações de assinatura\./,
    );

    expect(repository.delete).not.toHaveBeenCalled();
    // soft delete not asserted in this path
  });

  it('bloqueia criacao de assinatura quando a CAT ja possui PDF final emitido', async () => {
    catRepository.findOne.mockResolvedValue({
      id: 'cat-1',
      company_id: 'company-1',
      numero: 'CAT-001',
      status: 'fechada',
      pdf_file_key: 'documents/company-1/cats/cat-1/final.pdf',
    });

    await expect(
      service.create(
        {
          document_id: 'cat-1',
          document_type: 'CAT',
          user_id: 'user-1',
          signature_data: 'data:image/png;base64,CCCC',
          type: 'drawn',
        },
        'user-1',
      ),
    ).rejects.toThrow(
      /CAT com PDF final emitido está bloqueado para alterações de assinatura\./,
    );
  });

  it('bloqueia criacao de assinatura quando o RDO ja possui PDF final emitido', async () => {
    rdoRepository.findOne.mockResolvedValue({
      id: 'rdo-1',
      company_id: 'company-1',
      numero: 'RDO-001',
      status: 'aprovado',
      pdf_file_key: 'documents/company-1/rdos/rdo-1/final.pdf',
    });

    await expect(
      service.create(
        {
          document_id: 'rdo-1',
          document_type: 'RDO',
          user_id: 'user-1',
          signature_data: 'data:image/png;base64,RRRR',
          type: 'drawn',
        },
        'user-1',
      ),
    ).rejects.toThrow(
      /RDO com PDF final emitido está bloqueado para alterações de assinatura\./,
    );
  });
});
