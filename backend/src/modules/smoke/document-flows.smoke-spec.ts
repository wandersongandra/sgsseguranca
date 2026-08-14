import 'reflect-metadata';

import { AprsController } from '../aprs/aprs.controller';
import { AuditsController } from '../audits/audits.controller';
import { CatsController } from '../cats/cats.controller';
import { ChecklistsController } from '../checklists/checklists.controller';
import { DdsController } from '../dds/dds.controller';
import { DossiersController } from '../dossiers/dossiers.controller';
import { NonConformitiesController } from '../nonconformities/nonconformities.controller';
import { PtsController } from '../pts/pts.controller';
import { RdosController } from '../rdos/rdos.controller';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = 'company-1';
const fileInspectionService = { inspect: jest.fn() };

const requestWithUser = {
  user: {
    id: USER_ID,
    userId: USER_ID,
    sub: USER_ID,
  },
  ip: '127.0.0.1',
  socket: {
    remoteAddress: '127.0.0.1',
  },
};

const readyAccess = {
  entityId: DOCUMENT_ID,
  hasFinalPdf: true,
  availability: 'ready',
  url: 'https://storage.example.test/final.pdf',
  message: null,
  fileKey: 'documents/company-1/doc/final.pdf',
  folderPath: 'documents/company-1/doc',
  originalName: 'final.pdf',
};

const notEmittedAccess = {
  entityId: DOCUMENT_ID,
  hasFinalPdf: false,
  availability: 'not_emitted',
  url: null,
  message: 'PDF final ainda não emitido.',
  fileKey: null,
  folderPath: null,
  originalName: null,
};

const degradedAccess = {
  entityId: DOCUMENT_ID,
  hasFinalPdf: true,
  availability: 'registered_without_signed_url',
  url: null,
  message: 'PDF final registrado, mas a URL segura não está disponível.',
  fileKey: 'documents/company-1/doc/final.pdf',
  folderPath: 'documents/company-1/doc',
  originalName: 'final.pdf',
};

describe('Document flows smoke', () => {
  it('APR: consulta o documento e resolve o contrato de PDF final', async () => {
    const aprsService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        numero: 'APR-001',
        titulo: 'APR teste',
      }),
      getPdfAccess: jest.fn().mockResolvedValue(notEmittedAccess),
    };
    const pdfRateLimitService = {
      checkDownloadLimit: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new AprsController(
      aprsService as never,
      pdfRateLimitService as never,
      {} as never,
      {} as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(
      DOCUMENT_ID,
      requestWithUser as never,
    );

    expect(document).toMatchObject({ id: DOCUMENT_ID, numero: 'APR-001' });
    expect(access).toEqual(notEmittedAccess);
    expect(aprsService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(aprsService.getPdfAccess).toHaveBeenCalledWith(DOCUMENT_ID);
  });

  it('PT: consulta o documento e resolve o contrato de PDF final', async () => {
    const ptsService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        numero: 'PT-001',
        titulo: 'PT teste',
      }),
      getPdfAccess: jest.fn().mockResolvedValue(readyAccess),
    };
    const pdfRateLimitService = {
      checkDownloadLimit: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new PtsController(
      ptsService as never,
      pdfRateLimitService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(
      DOCUMENT_ID,
      requestWithUser as never,
    );

    expect(document).toMatchObject({ id: DOCUMENT_ID, numero: 'PT-001' });
    expect(access).toEqual(readyAccess);
    expect(ptsService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(ptsService.getPdfAccess).toHaveBeenCalledWith(DOCUMENT_ID);
  });

  it('DDS: consulta o documento e resolve o contrato de PDF final', async () => {
    const ddsService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        tema: 'DDS teste',
      }),
      getPdfAccess: jest.fn().mockResolvedValue(readyAccess),
    };
    const pdfRateLimitService = {
      checkDownloadLimit: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new DdsController(
      ddsService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      pdfRateLimitService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(
      DOCUMENT_ID,
      requestWithUser as never,
    );

    expect(document).toMatchObject({ id: DOCUMENT_ID, tema: 'DDS teste' });
    expect(access).toEqual(readyAccess);
    expect(ddsService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(ddsService.getPdfAccess).toHaveBeenCalledWith(DOCUMENT_ID);
  });

  it('Checklist: consulta o documento e resolve o contrato de PDF final', async () => {
    const checklistsService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        nome: 'Checklist teste',
      }),
      getPdfAccess: jest.fn().mockResolvedValue(notEmittedAccess),
    };
    const controller = new ChecklistsController(
      checklistsService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(DOCUMENT_ID);

    expect(document).toMatchObject({
      id: DOCUMENT_ID,
      nome: 'Checklist teste',
    });
    expect(access).toEqual(notEmittedAccess);
    expect(checklistsService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(checklistsService.getPdfAccess).toHaveBeenCalledWith(DOCUMENT_ID);
  });

  it('Não Conformidade: consulta o documento e resolve o contrato de PDF final', async () => {
    const nonConformitiesService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        codigo_nc: 'NC-001',
      }),
      getPdfAccess: jest.fn().mockResolvedValue(notEmittedAccess),
    };
    const nonConformitiesPdfService = {
      generateFinalPdf: jest.fn(),
    };
    const controller = new NonConformitiesController(
      nonConformitiesService as never,
      nonConformitiesPdfService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdf(DOCUMENT_ID);

    expect(document).toMatchObject({ id: DOCUMENT_ID, codigo_nc: 'NC-001' });
    expect(access).toEqual(notEmittedAccess);
    expect(nonConformitiesService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(nonConformitiesService.getPdfAccess).toHaveBeenCalledWith(
      DOCUMENT_ID,
    );
  });

  it('RDO: consulta o documento e resolve o contrato de PDF final', async () => {
    const rdosService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        numero: 'RDO-202603-001',
      }),
      getPdfAccess: jest.fn().mockResolvedValue(readyAccess),
    };
    const pdfRateLimitService = {
      checkDownloadLimit: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new RdosController(
      rdosService as never,
      pdfRateLimitService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(
      DOCUMENT_ID,
      requestWithUser as never,
    );

    expect(document).toMatchObject({
      id: DOCUMENT_ID,
      numero: 'RDO-202603-001',
    });
    expect(access).toEqual(readyAccess);
    expect(rdosService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(rdosService.getPdfAccess).toHaveBeenCalledWith(DOCUMENT_ID);
  });

  it('Auditoria: consulta o documento no tenant atual e resolve modo degradado explícito', async () => {
    const auditsService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        titulo: 'Auditoria teste',
      }),
      getPdfAccess: jest.fn().mockResolvedValue(degradedAccess),
    };
    const tenantService = {
      getTenantId: jest.fn().mockReturnValue(COMPANY_ID),
    };
    const controller = new AuditsController(
      auditsService as never,
      tenantService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(DOCUMENT_ID);

    expect(document).toMatchObject({
      id: DOCUMENT_ID,
      titulo: 'Auditoria teste',
    });
    expect(access).toEqual(degradedAccess);
    expect(auditsService.findOne).toHaveBeenCalledWith(DOCUMENT_ID, COMPANY_ID);
    expect(auditsService.getPdfAccess).toHaveBeenCalledWith(
      DOCUMENT_ID,
      COMPANY_ID,
    );
  });

  it('CAT: consulta o documento e resolve o contrato de PDF final', async () => {
    const catsService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        numero: 'CAT-20260320-0001',
      }),
      getPdfAccess: jest.fn().mockResolvedValue(readyAccess),
    };
    const controller = new CatsController(
      catsService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(
      DOCUMENT_ID,
      requestWithUser as never,
    );

    expect(document).toMatchObject({
      id: DOCUMENT_ID,
      numero: 'CAT-20260320-0001',
    });
    expect(access).toEqual(readyAccess);
    expect(catsService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(catsService.getPdfAccess).toHaveBeenCalledWith(DOCUMENT_ID, USER_ID);
  });

  it('Dossiê: consulta contexto do colaborador e resolve o contrato de PDF final', async () => {
    const dossiersService = {
      getEmployeeDossierContext: jest.fn().mockResolvedValue({
        kind: 'employee',
        employee: {
          id: USER_ID,
          nome: 'Colaborador teste',
        },
        documents: [
          {
            type: 'APR',
            reference: 'APR-001',
          },
        ],
      }),
      getEmployeePdfAccess: jest.fn().mockResolvedValue(readyAccess),
    };
    const controller = new DossiersController(
      dossiersService as never,
      fileInspectionService as never,
    );

    const context = await controller.getEmployeeContext(USER_ID);
    const access = await controller.getEmployeePdfAccess(
      USER_ID,
      requestWithUser as never,
    );

    expect(context).toMatchObject({
      kind: 'employee',
      employee: { id: USER_ID },
    });
    expect(access).toEqual(readyAccess);
    expect(dossiersService.getEmployeeDossierContext).toHaveBeenCalledWith(
      USER_ID,
    );
    expect(dossiersService.getEmployeePdfAccess).toHaveBeenCalledWith(
      USER_ID,
      USER_ID,
    );
  });
});
