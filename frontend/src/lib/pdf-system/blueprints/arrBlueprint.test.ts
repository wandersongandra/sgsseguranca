import { drawArrBlueprint } from './arrBlueprint';

const drawDocumentIdentityRail = jest.fn();
const drawExecutiveSummaryStrip = jest.fn();
const drawGovernanceClosingBlock = jest.fn().mockResolvedValue(undefined);
const drawMetadataGrid = jest.fn();
const drawNarrativeSection = jest.fn();
const drawParticipantTable = jest.fn();

jest.mock('../components', () => ({
  drawDocumentIdentityRail: (...args: unknown[]) => drawDocumentIdentityRail(...args),
  drawExecutiveSummaryStrip: (...args: unknown[]) => drawExecutiveSummaryStrip(...args),
  drawGovernanceClosingBlock: (...args: unknown[]) => drawGovernanceClosingBlock(...args),
  drawMetadataGrid: (...args: unknown[]) => drawMetadataGrid(...args),
  drawNarrativeSection: (...args: unknown[]) => drawNarrativeSection(...args),
}));

jest.mock('../tables', () => ({
  drawParticipantTable: (...args: unknown[]) => drawParticipantTable(...args),
}));

describe('drawArrBlueprint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('inclui rastreabilidade do PDF final quando os metadados governados existem', async () => {
    await drawArrBlueprint(
      {} as never,
      jest.fn() as never,
      {
        id: 'arr-1',
        titulo: 'ARR final',
        data: '2026-04-19',
        status: 'tratada',
        company_id: 'company-1',
        site_id: 'site-1',
        responsavel_id: 'user-1',
        atividade_principal: 'Içamento',
        condicao_observada: 'Carga sem isolamento',
        risco_identificado: 'Queda de material',
        nivel_risco: 'alto',
        probabilidade: 'alta',
        severidade: 'grave',
        controles_imediatos: 'Isolar área e suspender atividade',
        participants: [{ id: 'user-1', nome: 'Joao', funcao: 'Rigger' }],
        final_pdf_hash_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pdf_generated_at: '2026-04-19T12:00:00.000Z',
        emitted_by: { nome: 'Tecnico SST' },
      } as never,
      'ARR-2026-ARR1',
      'https://example.com/validar/ARR-2026-ARR1?module=arr',
    );

    expect(drawMetadataGrid).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Rastreabilidade do PDF final',
      }),
    );
    expect(drawMetadataGrid).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Contexto documental',
        fields: expect.arrayContaining([{ label: 'Data do documento', value: '19/04/2026' }]),
      }),
    );
    expect(drawGovernanceClosingBlock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    );
    expect(drawParticipantTable).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'Participantes (1)',
      [
        expect.objectContaining({
          name: 'Joao',
          role: 'Rigger',
        }),
      ],
    );
  });
});
