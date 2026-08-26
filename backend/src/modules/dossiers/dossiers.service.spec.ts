import JSZip from 'jszip';
import { DossiersService } from './dossiers.service';
import type {
  StorageObjectOwner,
  StorageObjectReference,
} from '../../shared/storage/storage-object-reference';

describe('DossiersService bundle resilience', () => {
  it('builds the dossier bundle even when one governed artifact is unavailable', async () => {
    const storageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: StorageObjectOwner,
          purpose: string,
        ): StorageObjectReference => ({
          tenantId: 'company-1',
          key,
          owner,
          purpose,
        }),
      ),
      downloadFileBuffer: jest
        .fn()
        .mockResolvedValueOnce(Buffer.from('pdf-1'))
        .mockRejectedValueOnce(new Error('Arquivo não encontrado no storage')),
    };

    const service = new DossiersService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      storageService as never,
      {} as never,
      {} as never,
    );

    type BuildDossierBundleArchive = (input: {
      filenameBase: string;
      dossierCode: string;
      generatedAt: string;
      context: {
        kind: 'employee';
        id: string;
        code: string;
        companyId: string;
        companyName: string | null;
        generatedAt: string;
        summary: {
          trainings: number;
          assignments: number;
          pts: number;
          cats: number;
          attachments: number;
          officialDocuments: number;
          pendingOfficialDocuments: number;
          supportingAttachments: number;
        };
        truncation: {
          limit: number;
          truncated: boolean;
          datasets: {
            trainings: boolean;
            assignments: boolean;
            pts: boolean;
            cats: boolean;
            workers: boolean;
          };
        };
        inclusionPolicy: {
          officialDocuments: string;
          pendingOfficialDocuments: string;
          supportingAttachments: string;
          zipBundle: string;
          notes: string[];
        };
        subject: {
          id: string;
          nome: string;
          funcao: string | null;
          status: boolean;
          profileName: string | null;
          siteName: string | null;
          cpf: string | null;
          updatedAt: string | null;
        };
        trainings: [];
        assignments: [];
        pts: [];
        cats: [];
        attachmentLines: [];
        governedDocumentLines: [];
        pendingGovernedDocumentLines: [];
      };
      officialArtifacts: Array<{
        modulo: 'pt' | 'cat';
        modulo_label: string;
        entityId: string;
        referencia: string;
        codigo_documento: string | null;
        arquivo: string;
        disponibilidade: 'ready' | 'registered_without_signed_url';
        emitido_em: string | null;
        fileKey: string;
        fileHash: string | null;
      }>;
    }) => Promise<{ filename: string; buffer: Buffer }>;

    const serviceWithBundle = service as unknown as {
      buildDossierBundleArchive: BuildDossierBundleArchive;
    };

    const result = await serviceWithBundle.buildDossierBundleArchive({
      filenameBase: 'Dossiê Teste',
      dossierCode: 'DOS-EMP-2026-ABCDEFGHIJKL',
      generatedAt: '2026-03-23T10:00:00.000Z',
      context: {
        kind: 'employee',
        id: 'user-1',
        code: 'DOS-EMP-2026-ABCDEFGHIJKL',
        companyId: 'company-1',
        companyName: 'Empresa Demo',
        generatedAt: '2026-03-23T10:00:00.000Z',
        summary: {
          trainings: 0,
          assignments: 0,
          pts: 0,
          cats: 0,
          attachments: 0,
          officialDocuments: 2,
          pendingOfficialDocuments: 0,
          supportingAttachments: 0,
        },
        truncation: {
          limit: 500,
          truncated: false,
          datasets: {
            trainings: false,
            assignments: false,
            pts: false,
            cats: false,
            workers: false,
          },
        },
        inclusionPolicy: {
          officialDocuments: 'Somente documentos oficiais válidos.',
          pendingOfficialDocuments: 'Pendências ficam explícitas.',
          supportingAttachments: 'Anexos ficam separados.',
          zipBundle: 'ZIP com artefatos oficiais disponíveis.',
          notes: [],
        },
        subject: {
          id: 'user-1',
          nome: 'João Demo',
          funcao: null,
          status: true,
          profileName: null,
          siteName: null,
          cpf: null,
          updatedAt: null,
        },
        trainings: [],
        assignments: [],
        pts: [],
        cats: [],
        attachmentLines: [],
        governedDocumentLines: [],
        pendingGovernedDocumentLines: [],
      },
      officialArtifacts: [
        {
          modulo: 'pt',
          modulo_label: 'PT',
          entityId: 'pt-1',
          referencia: 'PT-001',
          codigo_documento: 'PT-001',
          arquivo: 'pt-001.pdf',
          disponibilidade: 'ready',
          emitido_em: '2026-03-22T10:00:00.000Z',
          fileKey: 'documents/company-1/pt/pt-1/pt-001.pdf',
          fileHash: 'hash-1',
        },
        {
          modulo: 'cat',
          modulo_label: 'CAT',
          entityId: 'cat-1',
          referencia: 'CAT-001',
          codigo_documento: 'CAT-001',
          arquivo: 'cat-001.pdf',
          disponibilidade: 'ready',
          emitido_em: '2026-03-21T10:00:00.000Z',
          fileKey: 'documents/company-1/cat/cat-1/cat-001.pdf',
          fileHash: 'hash-2',
        },
      ],
    });

    const zip = await JSZip.loadAsync(result.buffer);
    const manifest = JSON.parse(
      await zip.file('manifest.json')!.async('string'),
    ) as {
      bundleStatus: {
        requestedOfficialDocuments: number;
        includedOfficialDocuments: number;
        missingOfficialDocuments: number;
        degraded: boolean;
      };
      missingOfficialDocuments: Array<{
        documentCode: string | null;
        reason: string;
      }>;
    };

    expect(manifest.bundleStatus).toEqual({
      requestedOfficialDocuments: 2,
      includedOfficialDocuments: 1,
      missingOfficialDocuments: 1,
      degraded: true,
    });
    expect(manifest.missingOfficialDocuments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentCode: 'CAT-001',
          reason: 'Arquivo não encontrado no storage',
        }),
      ]),
    );
    expect(
      await zip.file('documentos-oficiais/01_pt-001.pdf')!.async('string'),
    ).toBe('pdf-1');
    expect(zip.file('falhas-documentos-oficiais.json')).not.toBeNull();
  });
});
