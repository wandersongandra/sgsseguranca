import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import type { TenantService } from '../../../shared/tenant/tenant.service';
import type { DocumentStorageService } from '../../../shared/services/document-storage.service';
import { markAuthorizedStorageReference } from '../../../shared/storage/storage-object-reference';
import type { StorageObjectReference } from '../../../shared/storage/storage-object-reference';
import { AprLog } from '../entities/apr-log.entity';
import { Apr, AprStatus } from '../entities/apr.entity';
import { AprsEvidenceService } from './aprs-evidence.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApr(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apr-1',
    company_id: 'company-1',
    status: AprStatus.PENDENTE,
    pdf_file_key: null,
    elaborador_id: 'user-1',
    participants: [],
    ...overrides,
  } as unknown as Apr;
}

function makeFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    originalname: 'evidence.jpg',
    mimetype: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]),
    size: 5,
    ...overrides,
  } as Express.Multer.File;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

describe('AprsEvidenceService', () => {
  let service: AprsEvidenceService;
  let aprRepository: {
    findOne: jest.Mock;
    manager: { getRepository: jest.Mock; query: jest.Mock };
  };
  let aprLogsRepository: { create: jest.Mock; save: jest.Mock };
  let tenantService: Pick<TenantService, 'getTenantId' | 'getContext' | 'run'>;
  let documentStorageService: Pick<
    DocumentStorageService,
    | 'generateDocumentKey'
    | 'createReference'
    | 'referenceForExistingObject'
    | 'uploadFile'
    | 'uploadFileWithCapability'
    | 'deleteFile'
    | 'getSignedUrl'
  >;

  let riskItemRepository: { findOne: jest.Mock };
  let evidenceRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(() => {
    riskItemRepository = { findOne: jest.fn() };
    evidenceRepository = {
      create: jest.fn((input: Record<string, unknown>) => input),
      save: jest.fn((input: Record<string, unknown>) =>
        Promise.resolve({ ...input, id: 'evidence-1' }),
      ),
      findOne: jest.fn(),
    };

    aprRepository = {
      findOne: jest.fn(),
      manager: {
        query: jest.fn(),
        getRepository: jest.fn((entity: { name?: string }) => {
          if (entity?.name === 'AprRiskItem') return riskItemRepository;
          if (entity?.name === 'AprRiskEvidence') return evidenceRepository;
          return evidenceRepository;
        }),
      },
    };
    aprLogsRepository = {
      create: jest.fn((input: Partial<AprLog>) => input as unknown as AprLog),
      save: jest.fn(() => Promise.resolve()),
    };
    tenantService = {
      getTenantId: jest.fn(() => 'company-1'),
      getContext: jest.fn(() => ({
        siteScope: 'all',
        companyId: 'company-1',
        isSuperAdmin: false,
      })),
      run: jest.fn((_ctx: unknown, fn: () => unknown) =>
        fn(),
      ) as TenantService['run'],
    };
    documentStorageService = {
      createReference: jest.fn((reference) => reference),
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: { resourceType: string; resourceId: string },
          purpose: string,
        ) => ({
          tenantId: 'company-1',
          key,
          owner,
          purpose,
        }),
      ),
      generateDocumentKey: jest.fn(
        () => 'documents/company-1/apr-evidences/apr-1/evidence.jpg',
      ),
      uploadFile: jest.fn(() => Promise.resolve()),
      uploadFileWithCapability: jest.fn(
        (
          reference: StorageObjectReference,
          _file: Parameters<
            DocumentStorageService['uploadFileWithCapability']
          >[1],
          _contentType: string,
          _metadata?: Record<string, string>,
        ) => Promise.resolve(markAuthorizedStorageReference(reference)),
      ),
      deleteFile: jest.fn(() => Promise.resolve()),
      getSignedUrl: jest.fn((reference) =>
        Promise.resolve(
          `https://signed.example/${encodeURIComponent(reference.key)}`,
        ),
      ),
    };

    service = new AprsEvidenceService(
      aprRepository as unknown as Repository<Apr>,
      aprLogsRepository as unknown as Repository<AprLog>,
      tenantService as unknown as TenantService,
      documentStorageService as DocumentStorageService,
    );
  });

  // ─── uploadRiskEvidence — happy path ─────────────────────────────────────

  it('uploadRiskEvidence grava evidência governada e retorna hash SHA-256', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });

    const file = makeFile();
    const result = await service.uploadRiskEvidence(
      'apr-1',
      'risk-1',
      file,
      {
        latitude: -23.55,
        longitude: -46.63,
      },
      'user-1',
      '127.0.0.1',
    );

    expect(
      documentStorageService.uploadFileWithCapability,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/apr-evidences/apr-1/evidence.jpg',
      }),
      file.buffer,
      'image/jpeg',
    );
    expect(result).toMatchObject({
      id: 'evidence-1',
      fileKey: 'documents/company-1/apr-evidences/apr-1/evidence.jpg',
      originalName: 'evidence.jpg',
    });
    expect(result.hashSha256).toHaveLength(64);
  });

  // ─── uploadRiskEvidence — permissões ─────────────────────────────────────

  it('uploadRiskEvidence lança ForbiddenException para usuário sem vínculo com APR', async () => {
    aprRepository.findOne.mockResolvedValue(
      makeApr({ elaborador_id: 'outro-user', participants: [] }),
    );

    await expect(
      service.uploadRiskEvidence(
        'apr-1',
        'risk-1',
        makeFile(),
        {},
        'intruder-id',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('uploadRiskEvidence permite upload pelo elaborador', async () => {
    aprRepository.findOne.mockResolvedValue(
      makeApr({ elaborador_id: 'user-1' }),
    );
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });

    await expect(
      service.uploadRiskEvidence('apr-1', 'risk-1', makeFile(), {}, 'user-1'),
    ).resolves.toBeDefined();
  });

  it('uploadRiskEvidence permite upload por participante da APR', async () => {
    aprRepository.findOne.mockResolvedValue(
      makeApr({
        elaborador_id: 'outro',
        participants: [{ id: 'participante-1' }],
      }),
    );
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });

    await expect(
      service.uploadRiskEvidence(
        'apr-1',
        'risk-1',
        makeFile(),
        {},
        'participante-1',
      ),
    ).resolves.toBeDefined();
  });

  it('uploadRiskEvidence permite upload sem userId (chamada interna batch)', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });

    await expect(
      service.uploadRiskEvidence('apr-1', 'risk-1', makeFile(), {}, undefined),
    ).resolves.toBeDefined();
  });

  // ─── uploadRiskEvidence — bloqueios de estado ─────────────────────────────

  it('uploadRiskEvidence lança BadRequestException quando APR tem PDF final', async () => {
    aprRepository.findOne.mockResolvedValue(
      makeApr({ pdf_file_key: 'documents/apr.pdf' }),
    );

    await expect(
      service.uploadRiskEvidence('apr-1', 'risk-1', makeFile(), {}, 'user-1'),
    ).rejects.toThrow('APR assinada anexada');
  });

  it('uploadRiskEvidence lança BadRequestException quando APR não é PENDENTE', async () => {
    aprRepository.findOne.mockResolvedValue(
      makeApr({ status: AprStatus.APROVADA }),
    );

    await expect(
      service.uploadRiskEvidence('apr-1', 'risk-1', makeFile(), {}, 'user-1'),
    ).rejects.toThrow('Somente APRs pendentes');
  });

  it('uploadRiskEvidence lança NotFoundException quando APR não existe', async () => {
    aprRepository.findOne.mockResolvedValue(null);

    await expect(
      service.uploadRiskEvidence('apr-1', 'risk-1', makeFile(), {}, 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('uploadRiskEvidence falha fechado quando tenant ausente', async () => {
    (tenantService.getTenantId as jest.Mock).mockReturnValue(null);
    (tenantService.getContext as jest.Mock).mockReturnValue(undefined);

    await expect(
      service.uploadRiskEvidence('apr-1', 'risk-1', makeFile(), {}, 'user-1'),
    ).rejects.toThrow('Contexto de empresa nao definido para APR.');
  });

  it('uploadRiskEvidence lança NotFoundException quando item de risco não existe', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    riskItemRepository.findOne.mockResolvedValue(null);

    await expect(
      service.uploadRiskEvidence(
        'apr-1',
        'risco-inexistente',
        makeFile(),
        {},
        'user-1',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── uploadRiskEvidence — cleanup on failure ──────────────────────────────

  it('uploadRiskEvidence remove arquivo do storage quando save de evidência falha', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });
    evidenceRepository.save.mockRejectedValue(
      new Error('constraint violation'),
    );

    await expect(
      service.uploadRiskEvidence('apr-1', 'risk-1', makeFile(), {}, 'user-1'),
    ).rejects.toThrow('constraint violation');

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/apr-evidences/apr-1/evidence.jpg',
      }),
    );
  });

  // ─── uploadRiskEvidence — metadados GPS e integridade ────────────────────

  it('uploadRiskEvidence popula integrity_flags corretamente com GPS completo', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });

    let capturedEvidence: Record<string, unknown> = {};
    evidenceRepository.create.mockImplementation(
      (input: Record<string, unknown>) => {
        capturedEvidence = input;
        return input;
      },
    );

    await service.uploadRiskEvidence(
      'apr-1',
      'risk-1',
      makeFile(),
      {
        latitude: -23.55,
        longitude: -46.63,
        accuracy_m: 5.0,
        device_id: 'device-001',
        exif_datetime: '2026-03-14T10:00:00.000Z',
      },
      'user-1',
      '192.168.1.1',
    );

    const flags = capturedEvidence.integrity_flags as Record<string, boolean>;
    expect(flags.gps).toBe(true);
    expect(flags.accuracy).toBe(true);
    expect(flags.device).toBe(true);
    expect(flags.ip).toBe(true);
    expect(flags.exif).toBe(true);
  });

  it('uploadRiskEvidence integrity_flags são false quando sem GPS ou IP', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });

    let capturedEvidence: Record<string, unknown> = {};
    evidenceRepository.create.mockImplementation(
      (input: Record<string, unknown>) => {
        capturedEvidence = input;
        return input;
      },
    );

    await service.uploadRiskEvidence(
      'apr-1',
      'risk-1',
      makeFile(),
      {},
      'user-1',
    );

    const flags = capturedEvidence.integrity_flags as Record<string, boolean>;
    expect(flags.gps).toBe(false);
    expect(flags.ip).toBe(false);
    expect(flags.device).toBe(false);
    expect(flags.exif).toBe(false);
  });

  it('uploadRiskEvidence parseia captured_at como Date válido', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });

    let capturedEvidence: Record<string, unknown> = {};
    evidenceRepository.create.mockImplementation(
      (input: Record<string, unknown>) => {
        capturedEvidence = input;
        return input;
      },
    );

    await service.uploadRiskEvidence(
      'apr-1',
      'risk-1',
      makeFile(),
      {
        captured_at: '2026-03-14T10:00:00.000Z',
      },
      'user-1',
    );

    expect(capturedEvidence.captured_at).toBeInstanceOf(Date);
  });

  it('uploadRiskEvidence define captured_at como null para data inválida', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    riskItemRepository.findOne.mockResolvedValue({
      id: 'risk-1',
      apr_id: 'apr-1',
    });

    let capturedEvidence: Record<string, unknown> = {};
    evidenceRepository.create.mockImplementation(
      (input: Record<string, unknown>) => {
        capturedEvidence = input;
        return input;
      },
    );

    await service.uploadRiskEvidence(
      'apr-1',
      'risk-1',
      makeFile(),
      {
        captured_at: 'nao-e-data',
      },
      'user-1',
    );

    expect(capturedEvidence.captured_at).toBeNull();
  });

  // ─── uploadRiskEvidence — site scope ──────────────────────────────────────

  it('uploadRiskEvidence filtra por site quando siteScope é "single"', async () => {
    (tenantService.getContext as jest.Mock).mockReturnValue({
      siteScope: 'single',
      siteId: 'site-99',
      companyId: 'company-1',
    });
    aprRepository.findOne.mockResolvedValue(null);

    await expect(
      service.uploadRiskEvidence('apr-1', 'risk-1', makeFile(), {}, 'user-1'),
    ).rejects.toThrow(NotFoundException);

    expect(aprRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        where: expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          site_id: expect.objectContaining({
            _type: 'in',
            _value: ['site-99'],
          }),
        }),
      }),
    );
  });

  // ─── verifyEvidenceByHashPublic ───────────────────────────────────────────

  it('verifyEvidenceByHashPublic retorna verified=true para hash original', async () => {
    const hash = 'a'.repeat(64);
    aprRepository.manager.query.mockResolvedValue([{ matched_in: 'original' }]);

    const result = await service.verifyEvidenceByHashPublic(hash);
    expect(result).toEqual({ verified: true, matchedIn: 'original' });
  });

  it("verifyEvidenceByHashPublic retorna matchedIn=watermarked para hash de marca d'água", async () => {
    const watermarkedHash = 'b'.repeat(64);
    aprRepository.manager.query.mockResolvedValue([
      { matched_in: 'watermarked' },
    ]);

    const result = await service.verifyEvidenceByHashPublic(watermarkedHash);
    expect(result).toEqual({ verified: true, matchedIn: 'watermarked' });
  });

  it('verifyEvidenceByHashPublic retorna verified=false para hash não encontrado', async () => {
    aprRepository.manager.query.mockResolvedValue([]);

    const result = await service.verifyEvidenceByHashPublic('c'.repeat(64));
    expect(result.verified).toBe(false);
    expect(result.message).toContain('não localizado');
  });

  it('verifyEvidenceByHashPublic expõe somente o resultado público mínimo', async () => {
    aprRepository.manager.query.mockResolvedValue([
      {
        matched_in: 'original',
        apr_id: 'apr-private',
        company_id: 'tenant-private',
        file_key: 'documents/private/object.pdf',
      },
    ]);

    const result = await service.verifyEvidenceByHashPublic('d'.repeat(64));

    expect(result).toEqual({ verified: true, matchedIn: 'original' });
    expect(Object.keys(result)).toEqual(['verified', 'matchedIn']);
  });

  it('verifyEvidenceByHashPublic rejeita hash com formato inválido', async () => {
    const result = await service.verifyEvidenceByHashPublic('hash-invalido');
    expect(result.verified).toBe(false);
    expect(result.message).toContain('inválido');
  });

  it('verifyEvidenceByHashPublic normaliza hash para minúsculas', async () => {
    const hash = 'A'.repeat(64);
    aprRepository.manager.query.mockResolvedValue([{ matched_in: 'original' }]);

    const result = await service.verifyEvidenceByHashPublic(hash);
    expect(result.verified).toBe(true);
    expect(aprRepository.manager.query).toHaveBeenCalledWith(
      'SELECT matched_in FROM public.verify_apr_evidence_by_hash_public($1)',
      [hash.toLowerCase()],
    );
  });

  it('verifyEvidenceByHashPublic rejeita hash vazio', async () => {
    const result = await service.verifyEvidenceByHashPublic('');
    expect(result.verified).toBe(false);
    expect(aprRepository.manager.query).not.toHaveBeenCalled();
  });

  it('verifyEvidenceByHashPublic falha sem divulgar erro do banco', async () => {
    aprRepository.manager.query.mockRejectedValue(
      new Error(
        'permission denied for function public.verify_apr_evidence_by_hash_public',
      ),
    );

    const verification = service.verifyEvidenceByHashPublic('e'.repeat(64));

    await expect(verification).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(verification).rejects.toThrow(
      'Verificação pública de evidência temporariamente indisponível.',
    );
  });

  // ─── listAprEvidences ────────────────────────────────────────────────────

  it('listAprEvidences retorna evidências com URLs assinadas', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());

    const mockEvidenceRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'evidence-1',
          apr_id: 'apr-1',
          apr_risk_item_id: 'risk-1',
          uploaded_by_id: 'user-1',
          uploaded_by: { nome: 'Carlos' },
          file_key: 'documents/company-1/apr-evidences/apr-1/evidence-1.jpg',
          original_name: 'evidence-1.jpg',
          mime_type: 'image/jpeg',
          file_size_bytes: 1024,
          hash_sha256: 'hash-1',
          watermarked_file_key: null,
          watermarked_hash_sha256: null,
          watermark_text: null,
          captured_at: new Date('2026-03-16T10:00:00.000Z'),
          uploaded_at: new Date('2026-03-16T10:05:00.000Z'),
          latitude: '-23.5505',
          longitude: '-46.6333',
          accuracy_m: '5.4',
          device_id: 'device-1',
          ip_address: '127.0.0.1',
          exif_datetime: null,
          integrity_flags: { gps: true },
          apr_risk_item: { ordem: 3 },
        },
      ]),
    };
    aprRepository.manager.getRepository.mockReturnValue(mockEvidenceRepo);

    const result = await service.listAprEvidences('apr-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'evidence-1',
      uploaded_by_name: 'Carlos',
      risk_item_ordem: 3,
      latitude: -23.5505,
      longitude: -46.6333,
      accuracy_m: 5.4,
    });
    expect(documentStorageService.getSignedUrl).toHaveBeenCalledTimes(1);
    expect(result[0]?.url).toContain('signed.example');
  });

  it('listAprEvidences silencia falha de URL assinada e retorna url=undefined', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    (documentStorageService.getSignedUrl as jest.Mock).mockRejectedValue(
      new Error('S3 unavailable'),
    );

    const mockEvidenceRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'evidence-2',
          apr_id: 'apr-1',
          apr_risk_item_id: 'risk-1',
          uploaded_by_id: null,
          uploaded_by: null,
          file_key: 'documents/company-1/apr-evidences/apr-1/ev.jpg',
          original_name: 'ev.jpg',
          mime_type: 'image/jpeg',
          file_size_bytes: 512,
          hash_sha256: 'hash-2',
          watermarked_file_key: null,
          watermarked_hash_sha256: null,
          watermark_text: null,
          captured_at: null,
          uploaded_at: null,
          latitude: null,
          longitude: null,
          accuracy_m: null,
          device_id: null,
          ip_address: null,
          exif_datetime: null,
          integrity_flags: null,
          apr_risk_item: null,
        },
      ]),
    };
    aprRepository.manager.getRepository.mockReturnValue(mockEvidenceRepo);

    const result = await service.listAprEvidences('apr-1');
    expect(result[0]?.url).toBeUndefined();
  });

  it("listAprEvidences gera URLs assinadas separadas para original e marca d'água", async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());

    const mockEvidenceRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'evidence-3',
          apr_id: 'apr-1',
          apr_risk_item_id: 'risk-1',
          uploaded_by_id: null,
          uploaded_by: null,
          file_key: 'documents/original.jpg',
          original_name: 'original.jpg',
          mime_type: 'image/jpeg',
          file_size_bytes: 2048,
          hash_sha256: 'orig-hash',
          watermarked_file_key: 'documents/watermarked.jpg',
          watermarked_hash_sha256: 'wm-hash',
          watermark_text: 'APR-001',
          captured_at: null,
          uploaded_at: null,
          latitude: null,
          longitude: null,
          accuracy_m: null,
          device_id: null,
          ip_address: null,
          exif_datetime: null,
          integrity_flags: null,
          apr_risk_item: null,
        },
      ]),
    };
    aprRepository.manager.getRepository.mockReturnValue(mockEvidenceRepo);

    const result = await service.listAprEvidences('apr-1');

    expect(documentStorageService.getSignedUrl).toHaveBeenCalledTimes(2);
    expect(result[0]?.watermarked_url).toBeDefined();
  });

  it('listAprEvidences lança NotFoundException quando APR não existe', async () => {
    aprRepository.findOne.mockResolvedValue(null);

    await expect(service.listAprEvidences('apr-inexistente')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('listAprEvidences retorna array vazio quando APR não tem evidências', async () => {
    aprRepository.findOne.mockResolvedValue(makeApr());
    aprRepository.manager.getRepository.mockReturnValue({
      find: jest.fn().mockResolvedValue([]),
    });

    const result = await service.listAprEvidences('apr-1');
    expect(result).toEqual([]);
    expect(documentStorageService.getSignedUrl).not.toHaveBeenCalled();
  });
});
