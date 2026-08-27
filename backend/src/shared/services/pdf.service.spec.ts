import { createHash } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DocumentRegistryEntry } from '../../modules/document-registry/entities/document-registry.entity';
import { PdfIntegrityRecord } from '../entities/pdf-integrity-record.entity';
import { PdfService } from './pdf.service';
import { PuppeteerPoolService } from './puppeteer-pool.service';
import { PdfValidatorService } from './pdf-validator.service';

describe('PdfService', () => {
  let service: PdfService;
  let integrityRepository: {
    upsert: jest.MockedFunction<Repository<PdfIntegrityRecord>['upsert']>;
    findOne: jest.MockedFunction<Repository<PdfIntegrityRecord>['findOne']>;
  };
  let registryRepository: {
    findOne: jest.MockedFunction<Repository<DocumentRegistryEntry>['findOne']>;
  };
  let puppeteerPool: Partial<PuppeteerPoolService>;
  let pdfValidator: Partial<PdfValidatorService>;

  beforeEach(() => {
    integrityRepository = {
      upsert: jest.fn(),
      findOne: jest.fn(),
    };
    registryRepository = {
      findOne: jest.fn(),
    };
    puppeteerPool = {};
    pdfValidator = {
      validateHtmlContent: jest.fn(),
      validatePdfBuffer: jest.fn(),
    };

    service = new PdfService(
      integrityRepository as unknown as Repository<PdfIntegrityRecord>,
      registryRepository as unknown as Repository<DocumentRegistryEntry>,
      puppeteerPool as PuppeteerPoolService,
      pdfValidator as PdfValidatorService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('persiste hash real ao assinar PDF', async () => {
    const buffer = Buffer.from('pdf-binary-content');
    const expectedHash = createHash('sha256').update(buffer).digest('hex');

    await expect(
      service.signAndSave(buffer, {
        originalName: 'laudo.pdf',
        signedByUserId: 'user-1',
        companyId: 'company-1',
      }),
    ).resolves.toBe(expectedHash);

    expect(integrityRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: expectedHash,
        original_name: 'laudo.pdf',
        signed_by_user_id: 'user-1',
        company_id: 'company-1',
      }),
      ['hash'],
    );
  });

  it('registra o autor operacional quando a integridade vem da esteira documental', async () => {
    const buffer = Buffer.from('pdf-governed-content');
    const expectedHash = createHash('sha256').update(buffer).digest('hex');

    await expect(
      service.registerBufferIntegrity(buffer, {
        originalName: 'checklist-final.pdf',
        recordedByUserId: 'user-2',
        companyId: 'company-9',
      }),
    ).resolves.toBe(expectedHash);

    expect(integrityRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: expectedHash,
        original_name: 'checklist-final.pdf',
        signed_by_user_id: 'user-2',
        company_id: 'company-9',
      }),
      ['hash'],
    );
  });

  it('retorna invalid=false quando hash nao existe', async () => {
    integrityRepository.findOne.mockResolvedValue(null);

    await expect(service.verify('missing-hash')).resolves.toEqual({
      hash: 'missing-hash',
      valid: false,
    });
  });

  it('enriquece verify com contexto governado quando o registry existe', async () => {
    integrityRepository.findOne.mockResolvedValue({
      original_name: 'relatorio.pdf',
      created_at: new Date('2026-03-14T16:00:00.000Z'),
      company_id: 'company-1',
    } as PdfIntegrityRecord);
    registryRepository.findOne.mockResolvedValue({
      module: 'checklist',
      entity_id: 'checklist-1',
      document_type: 'pdf',
      document_code: 'CHECKLIST-2026-11-ABCD1234',
      file_key: 'documents/company-1/checklists/doc.pdf',
      original_name: 'checklist.pdf',
    } as DocumentRegistryEntry);

    await expect(service.verify('known-hash')).resolves.toEqual({
      hash: 'known-hash',
      valid: true,
      originalName: 'relatorio.pdf',
      signedAt: '2026-03-14T16:00:00.000Z',
      document: {
        module: 'checklist',
        entityId: 'checklist-1',
        documentType: 'pdf',
        documentCode: 'CHECKLIST-2026-11-ABCD1234',
        fileKey: 'documents/company-1/checklists/doc.pdf',
        originalName: 'checklist.pdf',
      },
    });

    expect(registryRepository.findOne).toHaveBeenCalledWith({
      where: { file_hash: 'known-hash', company_id: 'company-1' },
      order: { updated_at: 'DESC' },
    });
  });

  it('filtra a busca por tenant quando o companyId é informado', async () => {
    integrityRepository.findOne.mockResolvedValue(null);

    await expect(
      service.verifyForCompany('known-hash', 'company-1'),
    ).resolves.toEqual({
      hash: 'known-hash',
      valid: false,
    });

    expect(integrityRepository.findOne).toHaveBeenCalledWith({
      where: { hash: 'known-hash', company_id: 'company-1' },
    });
  });

  it('mantem contrato compatível quando o hash existe sem registry relacionado', async () => {
    integrityRepository.findOne.mockResolvedValue({
      original_name: null,
      created_at: new Date('2026-03-14T16:00:00.000Z'),
      company_id: 'company-1',
    } as PdfIntegrityRecord);
    registryRepository.findOne.mockResolvedValue(null);

    await expect(service.verify('known-hash')).resolves.toEqual({
      hash: 'known-hash',
      valid: true,
      originalName: null,
      signedAt: '2026-03-14T16:00:00.000Z',
      document: undefined,
    });
  });

  it('traduz indisponibilidade do navegador de PDF em ServiceUnavailableException', async () => {
    puppeteerPool.getPage = jest
      .fn()
      .mockRejectedValue(new Error('browser launch failed'));

    await expect(
      service.generateFromHtml('<html><body>Teste</body></html>'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('traduz falha de renderização em ServiceUnavailableException', async () => {
    const releasePage = jest.fn().mockResolvedValue(undefined);
    const page = {
      setJavaScriptEnabled: jest.fn().mockResolvedValue(undefined),
      setRequestInterception: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockRejectedValue(new Error('page crashed')),
    };
    puppeteerPool.getPage = jest.fn().mockResolvedValue(page);
    puppeteerPool.releasePage = releasePage;

    await expect(
      service.generateFromHtml('<html><body>Teste</body></html>'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(releasePage).toHaveBeenCalledWith(page);
  });

  it('fecha a página quando o sinal aborta durante o render', async () => {
    const releasePage = jest.fn().mockResolvedValue(undefined);
    let releaseContent!: () => void;
    const page = {
      setJavaScriptEnabled: jest.fn().mockResolvedValue(undefined),
      setRequestInterception: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      setContent: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseContent = resolve;
          }),
      ),
      pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
      close: jest.fn().mockResolvedValue(true),
    };
    puppeteerPool.getPage = jest.fn().mockResolvedValue(page);
    puppeteerPool.releasePage = releasePage;
    const controller = new AbortController();

    const generation = service.generateFromHtml(
      '<html><body>Teste</body></html>',
      undefined,
      controller.signal,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }

    expect(page.setContent).toHaveBeenCalled();
    controller.abort();
    expect(page.close).toHaveBeenCalledTimes(1);

    releaseContent();
    await expect(generation).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(releasePage).toHaveBeenCalledWith(page);
  });

  it('permite configurar orientação retrato com preferencia pelo tamanho CSS', async () => {
    const releasePage = jest.fn().mockResolvedValue(undefined);
    const page = {
      setJavaScriptEnabled: jest.fn().mockResolvedValue(undefined),
      setRequestInterception: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
    };
    puppeteerPool.getPage = jest.fn().mockResolvedValue(page);
    puppeteerPool.releasePage = releasePage;

    await expect(
      service.generateFromHtml('<html><body>Teste</body></html>', {
        format: 'A4',
        landscape: false,
        preferCssPageSize: true,
      }),
    ).resolves.toBeInstanceOf(Buffer);

    expect(page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'A4',
        landscape: false,
        preferCSSPageSize: true,
        printBackground: true,
      }),
    );
    expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false);
    expect(releasePage).toHaveBeenCalledWith(page);
  });

  it('encaminha templates de header e footer quando displayHeaderFooter estiver ativo', async () => {
    const releasePage = jest.fn().mockResolvedValue(undefined);
    const page = {
      setJavaScriptEnabled: jest.fn().mockResolvedValue(undefined),
      setRequestInterception: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
    };
    puppeteerPool.getPage = jest.fn().mockResolvedValue(page);
    puppeteerPool.releasePage = releasePage;

    await expect(
      service.generateFromHtml('<html><body>Teste</body></html>', {
        displayHeaderFooter: true,
        headerTemplate: '<div>header</div>',
        footerTemplate: '<div>footer</div>',
        margin: {
          top: '0mm',
          right: '0mm',
          bottom: '8mm',
          left: '0mm',
        },
      }),
    ).resolves.toBeInstanceOf(Buffer);

    expect(page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        displayHeaderFooter: true,
        headerTemplate: '<div>header</div>',
        footerTemplate: '<div>footer</div>',
        margin: {
          top: '0mm',
          right: '0mm',
          bottom: '8mm',
          left: '0mm',
        },
      }),
    );
    expect(releasePage).toHaveBeenCalledWith(page);
  });

  it('bloqueia data URLs que não sejam imagens permitidas ou excedam o limite', async () => {
    const releasePage = jest.fn().mockResolvedValue(undefined);
    let requestHandler:
      | ((request: {
          url: () => string;
          continue: jest.Mock;
          abort: jest.Mock;
        }) => void)
      | undefined;
    const page = {
      setJavaScriptEnabled: jest.fn().mockResolvedValue(undefined),
      setRequestInterception: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, handler: typeof requestHandler) => {
        if (event === 'request') requestHandler = handler;
      }),
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
    };
    puppeteerPool.getPage = jest.fn().mockResolvedValue(page);
    puppeteerPool.releasePage = releasePage;

    await service.generateFromHtml('<html><body>Teste</body></html>');

    const makeRequest = (url: string) => ({
      url: () => url,
      continue: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
    });
    const valid = makeRequest(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    );
    const svg = makeRequest('data:image/svg+xml;base64,PHN2Zy8+');
    const html = makeRequest('data:text/html;base64,PGh0bWw+');
    const oversized = makeRequest(
      `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`,
    );

    requestHandler?.(valid);
    requestHandler?.(svg);
    requestHandler?.(html);
    requestHandler?.(oversized);

    expect(valid.continue).toHaveBeenCalledTimes(1);
    expect(svg.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(html.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(oversized.abort).toHaveBeenCalledWith('blockedbyclient');
  });
});
