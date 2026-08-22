import { Repository } from 'typeorm';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { AuditService } from '../audit-trail/audit.service';
import { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { PdfService } from '../../shared/services/pdf.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { Epi } from '../epis/entities/epi.entity';
import { User } from '../users/entities/user.entity';
import { EpiAssignment } from './entities/epi-assignment.entity';
import { EpiAssignmentsService } from './epi-assignments.service';

describe('EpiAssignmentsService governed PDF', () => {
  it('gera o snapshot no backend, escapa HTML e não incorpora assinatura bruta', async () => {
    const assignment: EpiAssignment = {
      id: '11111111-1111-4111-8111-111111111111',
      company_id: 'company-1',
      epi_id: 'epi-1',
      user_id: 'user-1',
      site_id: 'site-1',
      ca: 'CA-123',
      validade_ca: new Date('2027-01-01'),
      quantidade: 2,
      status: 'entregue',
      entregue_em: new Date('2026-08-16T12:00:00.000Z'),
      observacoes: '<script>alert(1)</script>',
      assinatura_entrega: {
        signer_name: 'Colaborador',
        signature_data: '<img src="https://attacker.invalid/collect">',
        signature_type: 'digital',
        signature_hash: 'signature-hash',
        timestamp_token: 'timestamp-token',
        timestamp_issued_at: '2026-08-16T12:00:00.000Z',
        timestamp_authority: 'internal-timestamp-authority',
      },
      company: {} as never,
      epi: { id: 'epi-1', nome: 'Capacete <Seguro>' } as Epi,
      user: { id: 'user-1', nome: 'Pessoa <Teste>' } as User,
      site: { id: 'site-1', nome: 'Obra A' } as never,
      created_at: new Date('2026-08-16T12:00:00.000Z'),
      updated_at: new Date('2026-08-16T12:00:00.000Z'),
    };
    const pdfService = {
      generateFromHtml: jest.fn().mockImplementation((html: string) => {
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).toContain('signature-hash');
        expect(html).not.toContain(
          assignment.assinatura_entrega.signature_data,
        );
        expect(html).not.toContain('<script>alert(1)</script>');
        return Buffer.from('%PDF-1.7 synthetic');
      }),
    } as unknown as PdfService;
    const uploadFileMock = jest.fn().mockResolvedValue(undefined);
    const storage = {
      generateDocumentKey: jest
        .fn()
        .mockReturnValue(
          'documents/company-1/epi/sites/site-1/11111111-1111-4111-8111-111111111111/file.pdf',
        ),
      uploadFile: uploadFileMock,
      deleteFile: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://storage.invalid/signed'),
    } as unknown as DocumentStorageService;
    const registerFinalDocumentMock = jest
      .fn()
      .mockResolvedValue({ hash: 'pdf-hash', registryEntry: {} });
    const governance = {
      registerFinalDocument: registerFinalDocumentMock,
    } as unknown as DocumentGovernanceService;
    const service = new EpiAssignmentsService(
      {} as Repository<EpiAssignment>,
      {} as Repository<Epi>,
      {} as never, // sitesRepository — not needed for PDF tests
      {} as Repository<User>,
      {} as TenantService,
      {} as SignatureTimestampService,
      {} as AuditService,
      storage,
      pdfService,
      governance,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue(assignment);
    jest.spyOn(service, 'getPdfAccess').mockResolvedValue({
      entityId: assignment.id,
      hasFinalPdf: true,
      availability: 'ready',
      message: 'PDF final governado disponível para acesso.',
      degraded: false,
      fileKey:
        'documents/company-1/epi/sites/site-1/11111111-1111-4111-8111-111111111111/file.pdf',
      folderPath: 'documents/company-1/epi/sites/site-1',
      originalName: 'EPI_ficha.pdf',
      url: 'https://storage.invalid/signed',
    });

    const result = await service.generateFinalPdf(assignment.id, 'actor-1');

    expect(result).toMatchObject({
      generated: true,
      hasFinalPdf: true,
      availability: 'ready',
      url: 'https://storage.invalid/signed',
    });
    expect(uploadFileMock).toHaveBeenCalledWith(
      expect.stringContaining('documents/company-1/epi/sites/site-1/'),
      expect.any(Buffer),
      'application/pdf',
    );
    expect(registerFinalDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        module: 'epi',
        entityId: assignment.id,
        createdBy: 'actor-1',
      }),
    );
  });
});
