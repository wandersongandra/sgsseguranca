import { DeepPartial, IsNull, Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { PhotographicReportsService } from './photographic-reports.service';
import {
  PhotographicReport,
  PhotographicReportStatus,
} from './entities/photographic-report.entity';
import { PhotographicReportDay } from './entities/photographic-report-day.entity';
import { PhotographicReportImage } from './entities/photographic-report-image.entity';
import { PhotographicReportExport } from './entities/photographic-report-export.entity';
import { CreatePhotographicReportDto } from './dto/create-photographic-report.dto';
import { RequestContext } from '../../shared/middleware/request-context.middleware';

type ReportRepoMock = Pick<
  Repository<PhotographicReport>,
  'create' | 'save' | 'delete' | 'softDelete' | 'findOne' | 'createQueryBuilder'
>;
type DayRepoMock = Pick<Repository<PhotographicReportDay>, 'create' | 'save'>;
type ImageRepoMock = Pick<Repository<PhotographicReportImage>, 'save'>;
type ExportRepoMock = Pick<Repository<PhotographicReportExport>, 'save'>;

describe('PhotographicReportsService', () => {
  const reportRepository: jest.Mocked<ReportRepoMock> = {
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const dayRepository: jest.Mocked<DayRepoMock> = {
    create: jest.fn(),
    save: jest.fn(),
  };
  const imageRepository: jest.Mocked<ImageRepoMock> = {
    save: jest.fn(),
  };
  const exportRepository: jest.Mocked<ExportRepoMock> = {
    save: jest.fn(),
  };
  const tenantService = {
    getTenantId: jest.fn(() => 'company-1'),
  };
  const documentStorageService = {
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const documentGovernanceService = {
    removeFinalDocumentReference: jest.fn().mockResolvedValue(undefined),
  };
  const documentRegistryService = {
    findByDocument: jest.fn(),
  };
  const pdfService = {
    generateFromHtml: jest.fn(),
  };
  const aiAnalysisService = {
    analyzePhotographicReportImage: jest.fn(),
    summarizePhotographicReport: jest.fn(),
  };
  const fileInspectionService = {
    inspect: jest.fn(),
  };

  let service: PhotographicReportsService;
  let reportQueryBuilder: {
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    loadRelationCountAndMap: jest.Mock;
    getManyAndCount: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    reportQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      loadRelationCountAndMap: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    reportRepository.createQueryBuilder.mockReturnValue(
      reportQueryBuilder as never,
    );
    service = new PhotographicReportsService(
      reportRepository as unknown as Repository<PhotographicReport>,
      dayRepository as unknown as Repository<PhotographicReportDay>,
      imageRepository as unknown as Repository<PhotographicReportImage>,
      exportRepository as unknown as Repository<PhotographicReportExport>,
      tenantService as never,
      documentStorageService as never,
      documentGovernanceService as never,
      documentRegistryService as never,
      pdfService as never,
      aiAnalysisService as never,
      fileInspectionService as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { sendStoredDocument: jest.fn().mockResolvedValue(undefined) } as never,
      { add: jest.fn().mockResolvedValue(undefined) } as never,
    );
  });

  it('remove() apaga imagens do storage e soft-deleta relatório sem exportação', async () => {
    const report = {
      id: 'report-1',
      company_id: 'company-1',
      status: PhotographicReportStatus.RASCUNHO,
      deleted_at: null,
      images: [
        { image_url: 'companies/company-1/report-1/images/a.jpg' },
        { image_url: 'companies/company-1/report-1/images/a.jpg' },
        { image_url: 'companies/company-1/report-1/images/b.jpg' },
      ],
      exports: [],
    } as unknown as PhotographicReport;

    reportRepository.findOne.mockResolvedValue(report);
    reportRepository.softDelete.mockResolvedValue({
      affected: 1,
      raw: [],
      generatedMaps: [],
    });

    await service.remove('report-1');

    expect(reportRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'report-1', company_id: 'company-1', deleted_at: IsNull() },
      relations: {
        days: true,
        images: { reportDay: true },
        exports: true,
      },
    });
    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'companies/company-1/report-1/images/a.jpg',
    );
    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'companies/company-1/report-1/images/b.jpg',
    );
    expect(
      documentGovernanceService.removeFinalDocumentReference,
    ).toHaveBeenCalled();
    expect(reportRepository.softDelete).toHaveBeenCalledWith('report-1');
  });

  it('bloqueia remove() quando o relatório já tem exportação final', async () => {
    const report = {
      id: 'report-1',
      company_id: 'company-1',
      status: PhotographicReportStatus.EXPORTADO,
      deleted_at: null,
      images: [],
      exports: [{ file_url: 'companies/company-1/report-1/exports/r1.pdf' }],
    } as unknown as PhotographicReport;

    reportRepository.findOne.mockResolvedValue(report);

    await expect(service.remove('report-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
    expect(reportRepository.softDelete).not.toHaveBeenCalled();
  });

  it('update() bloqueia transição direta de status fora dos fluxos dedicados', async () => {
    reportRepository.findOne.mockResolvedValue({
      id: 'report-1',
      status: PhotographicReportStatus.RASCUNHO,
      company_id: 'company-1',
      deleted_at: null,
      days: [],
      images: [],
      exports: [],
    } as unknown as PhotographicReport);

    await expect(
      service.update('report-1', {
        status: PhotographicReportStatus.FINALIZADO,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(reportRepository.save).not.toHaveBeenCalled();
  });

  it('create() usa apenas o usuário autenticado como created_by', async () => {
    const reportDraft = {
      id: 'report-1',
      company_id: 'company-1',
      start_date: '2026-05-16',
      deleted_at: null,
      created_at: new Date('2026-05-16T10:00:00.000Z'),
      updated_at: new Date('2026-05-16T10:00:00.000Z'),
      days: [],
      images: [],
      exports: [],
      status: PhotographicReportStatus.RASCUNHO,
    } as unknown as PhotographicReport;

    reportRepository.create.mockImplementation(
      (input: DeepPartial<PhotographicReport>) =>
        ({ ...reportDraft, ...input }) as PhotographicReport,
    );
    reportRepository.save.mockResolvedValue(reportDraft);
    reportRepository.findOne.mockResolvedValue(reportDraft);
    dayRepository.create.mockImplementation(
      (input: DeepPartial<PhotographicReportDay>) =>
        input as PhotographicReportDay,
    );
    dayRepository.save.mockResolvedValue({
      id: 'day-1',
    } as unknown as PhotographicReportDay);

    jest.spyOn(RequestContext, 'getUserId').mockReturnValue('auth-user-1');

    const forgedPayload = {
      client_name: 'Cliente X',
      project_name: 'Obra Y',
      activity_type: 'Inspecao visual',
      start_date: '2026-05-16',
      start_time: '08:00',
      end_time: '17:00',
      responsible_name: 'TST',
      contractor_company: 'Prestadora Z',
      created_by: 'forged-user',
    } as unknown as CreatePhotographicReportDto;

    await service.create(forgedPayload);

    const payload = reportRepository.create.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload?.created_by).toBe('auth-user-1');
    expect(payload?.created_by).not.toBe('forged-user');
  });

  it('findPaginated rejeita search inválido em vez de estourar 500', async () => {
    await expect(
      service.findPaginated({
        page: 1,
        limit: 10,
        search: ['forged'] as unknown as string,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(reportQueryBuilder.getManyAndCount).not.toHaveBeenCalled();
  });
});
