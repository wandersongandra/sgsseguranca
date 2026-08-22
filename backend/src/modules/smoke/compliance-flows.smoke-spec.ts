import 'reflect-metadata';

import { ArrsController } from '../arrs/arrs.controller';
import { DidsController } from '../dids/dids.controller';
import { CorrectiveActionsController } from '../corrective-actions/corrective-actions.controller';
import { EpiAssignmentsController } from '../epi-assignments/epi-assignments.controller';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = 'company-1';
const fileInspectionService = { inspect: jest.fn() };

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

describe('Compliance flows smoke', () => {
  it('ARR: consulta o documento e resolve o contrato de PDF final', async () => {
    const arrsService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        numero: 'ARR-001',
        titulo: 'ARR teste',
        company_id: COMPANY_ID,
      }),
      getPdfAccess: jest.fn().mockResolvedValue(notEmittedAccess),
    };
    const controller = new ArrsController(
      arrsService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(DOCUMENT_ID);

    expect(document).toMatchObject({ id: DOCUMENT_ID, numero: 'ARR-001' });
    expect(access.availability).toBe('not_emitted');
    expect(access.hasFinalPdf).toBe(false);
    expect(arrsService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(arrsService.getPdfAccess).toHaveBeenCalledWith(DOCUMENT_ID);
  });

  it('ARR: resolva modo ready (PDF emitido) e retorne URL assinada', async () => {
    const arrsService = {
      findOne: jest.fn().mockResolvedValue({ id: DOCUMENT_ID }),
      getPdfAccess: jest.fn().mockResolvedValue(readyAccess),
    };
    const controller = new ArrsController(
      arrsService as never,
      fileInspectionService as never,
    );

    const access = await controller.getPdfAccess(DOCUMENT_ID);

    expect(access.hasFinalPdf).toBe(true);
    expect(access.url).toContain('storage.example.test');
  });

  it('DID: consulta o documento e resolve o contrato de PDF final', async () => {
    const didsService = {
      findOne: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        titulo: 'DID teste',
        company_id: COMPANY_ID,
      }),
      getPdfAccess: jest.fn().mockResolvedValue(readyAccess),
    };
    const controller = new DidsController(
      didsService as never,
      fileInspectionService as never,
    );

    const document = await controller.findOne(DOCUMENT_ID);
    const access = await controller.getPdfAccess(DOCUMENT_ID);

    expect(document).toMatchObject({ id: DOCUMENT_ID });
    expect(access.hasFinalPdf).toBe(true);
    expect(didsService.findOne).toHaveBeenCalledWith(DOCUMENT_ID);
  });

  it('Ação Corretiva: lista resumo de status', async () => {
    const summary = {
      total: 10,
      open: 3,
      inProgress: 2,
      overdue: 1,
      done: 4,
      complianceRate: 40,
      byPriority: { low: 1, medium: 5, high: 3, critical: 1 },
    };
    const correctiveActionsService = {
      findSummary: jest.fn().mockResolvedValue(summary),
      list: jest.fn().mockResolvedValue([]),
      listPaginated: jest
        .fn()
        .mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    };
    const controller = new CorrectiveActionsController(
      correctiveActionsService as never,
    );

    const result = await controller.findSummary();

    expect(result.total).toBe(10);
    expect(result.complianceRate).toBe(40);
    expect(correctiveActionsService.findSummary).toHaveBeenCalled();
  });

  it('Ação Corretiva: lista paginada retorna objeto de paginação', async () => {
    const page = {
      data: [{ id: DOCUMENT_ID, title: 'Ação 1', status: 'open' }],
      total: 1,
      page: 1,
      limit: 20,
    };
    const correctiveActionsService = {
      findSummary: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
      listPaginated: jest.fn().mockResolvedValue(page),
    };
    const controller = new CorrectiveActionsController(
      correctiveActionsService as never,
    );

    const result = await controller.findAll();

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('EPI Assignment: lista fichas por colaborador com filtros', async () => {
    const assignments = [
      {
        id: 'assign-1',
        epi_id: 'epi-1',
        user_id: 'user-1',
        status: 'entregue',
      },
    ];
    const epiAssignmentsService = {
      findPaginated: jest.fn().mockResolvedValue({
        data: assignments,
        total: 1,
        page: 1,
        limit: 20,
      }),
    };
    const usersService = {
      findPaginated: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        lastPage: 1,
      }),
    };
    const episService = {
      findPaginated: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        lastPage: 1,
      }),
    };
    const controller = new EpiAssignmentsController(
      epiAssignmentsService as never,
      usersService as never,
      episService as never,
    );

    const result = await controller.findAll({
      page: 1,
      limit: 20,
      user_id: 'user-1',
      epi_id: undefined,
      status: undefined,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe('entregue');
    expect(epiAssignmentsService.findPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1' }),
    );
  });

  it('EPI Assignment: encontra uma ficha individual', async () => {
    const mockAssignment = {
      id: 'assign-1',
      epi_id: 'epi-1',
      user_id: 'user-1',
      status: 'entregue',
      company_id: COMPANY_ID,
    };
    const epiAssignmentsService = {
      findOne: jest.fn().mockResolvedValue(mockAssignment),
    };
    const usersService = {
      findPaginated: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        lastPage: 1,
      }),
    };
    const episService = {
      findPaginated: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        lastPage: 1,
      }),
    };
    const controller = new EpiAssignmentsController(
      epiAssignmentsService as never,
      usersService as never,
      episService as never,
    );

    const result = await controller.findOne('assign-1');

    expect(result.id).toBe('assign-1');
    expect(epiAssignmentsService.findOne).toHaveBeenCalledWith('assign-1');
  });
});
