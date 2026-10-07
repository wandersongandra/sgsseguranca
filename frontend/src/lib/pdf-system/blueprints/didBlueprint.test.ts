import { drawDidBlueprint } from './didBlueprint';

const drawDocumentIdentityRail = jest.fn();
const drawExecutiveSummaryStrip = jest.fn();
const drawGovernanceClosingBlock = jest.fn().mockResolvedValue(undefined);
const drawMetadataGrid = jest.fn();
const drawNarrativeSection = jest.fn();
const drawParticipantTable = jest.fn();

jest.mock('../components', () => ({
  drawDocumentIdentityRail: (...args: unknown[]) =>
    drawDocumentIdentityRail(...args),
  drawExecutiveSummaryStrip: (...args: unknown[]) =>
    drawExecutiveSummaryStrip(...args),
  drawGovernanceClosingBlock: (...args: unknown[]) =>
    drawGovernanceClosingBlock(...args),
  drawMetadataGrid: (...args: unknown[]) => drawMetadataGrid(...args),
  drawNarrativeSection: (...args: unknown[]) => drawNarrativeSection(...args),
}));

jest.mock('../tables', () => ({
  drawParticipantTable: (...args: unknown[]) => drawParticipantTable(...args),
}));

describe('drawDidBlueprint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('organiza o PDF do DID com leitura rapida, contexto do turno e participantes', async () => {
    await drawDidBlueprint(
      {} as never,
      jest.fn() as never,
      {
        id: 'did-1',
        titulo: 'DID turno manhã',
        descricao: 'Alinhamento inicial da frente de montagem.',
        data: '2026-07-03',
        turno: 'manha',
        frente_trabalho: 'Galpão 02',
        atividade_principal: 'Montagem de estrutura metálica',
        atividades_planejadas: 'Conferir pontos de içamento e iniciar montagem.',
        riscos_operacionais: 'Carga suspensa e circulação de veículos.',
        controles_planejados: 'Isolar área, reforçar spotter e checklist.',
        epi_epc_aplicaveis: 'Capacete, luva, óculos e cones.',
        observacoes: 'Reforçar comunicação por rádio.',
        company_id: 'company-1',
        site_id: 'site-1',
        responsavel_id: 'user-1',
        status: 'executado',
        created_at: '2026-07-03T07:00:00.000Z',
        updated_at: '2026-07-03T07:20:00.000Z',
        company: { razao_social: 'Empresa Teste' },
        site: { nome: 'Obra Norte' },
        responsavel: { nome: 'Maria Técnica' },
        participants: [
          { id: 'user-1', nome: 'João', funcao: 'Montador' },
          { id: 'user-2', nome: 'Ana', funcao: 'Sinaleira' },
        ],
      } as never,
      'DID-2026-DID1',
      'https://example.com/validar/DID-2026-DID1?module=did',
    );

    expect(drawDocumentIdentityRail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        documentType: 'DID',
        criticality: 'Controlado',
      }),
    );

    expect(drawExecutiveSummaryStrip).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Leitura rápida do turno',
        metrics: expect.arrayContaining([
          expect.objectContaining({
            label: 'Frente de trabalho',
            value: 'Galpão 02',
          }),
          expect.objectContaining({
            label: 'Responsável',
            value: 'Maria Técnica',
          }),
        ]),
      }),
    );

    expect(drawMetadataGrid).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Contexto do turno',
      }),
    );

    expect(drawNarrativeSection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Atividade principal do turno',
        content: 'Montagem de estrutura metálica',
      }),
    );

    expect(drawParticipantTable).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'Participantes (2)',
      [
        expect.objectContaining({
          name: 'João',
          role: 'Montador',
        }),
        expect.objectContaining({
          name: 'Ana',
          role: 'Sinaleira',
        }),
      ],
    );

    expect(drawGovernanceClosingBlock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Validação do documento',
      }),
    );
  });
});
