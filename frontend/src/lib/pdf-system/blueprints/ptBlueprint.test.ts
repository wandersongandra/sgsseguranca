import { drawPtBlueprint } from "./ptBlueprint";

const drawDocumentIdentityRail = jest.fn();
const drawExecutiveSummaryStrip = jest.fn();
const drawGovernanceClosingBlock = jest.fn().mockResolvedValue(undefined);
const drawMetadataGrid = jest.fn();
const drawNarrativeSection = jest.fn();
const drawChecklistTable = jest.fn();
const drawParticipantTable = jest.fn();
const drawEvidenceGallery = jest.fn().mockResolvedValue(undefined);
const drawSemanticTable = jest.fn();

jest.mock("../components", () => ({
  drawDocumentIdentityRail: (...args: unknown[]) =>
    drawDocumentIdentityRail(...args),
  drawExecutiveSummaryStrip: (...args: unknown[]) =>
    drawExecutiveSummaryStrip(...args),
  drawGovernanceClosingBlock: (...args: unknown[]) =>
    drawGovernanceClosingBlock(...args),
  drawMetadataGrid: (...args: unknown[]) => drawMetadataGrid(...args),
  drawNarrativeSection: (...args: unknown[]) => drawNarrativeSection(...args),
  drawEvidenceGallery: (...args: unknown[]) => drawEvidenceGallery(...args),
  drawSemanticTable: (...args: unknown[]) => drawSemanticTable(...args),
}));

jest.mock("../tables", () => ({
  drawChecklistTable: (...args: unknown[]) => drawChecklistTable(...args),
  drawParticipantTable: (...args: unknown[]) => drawParticipantTable(...args),
}));

describe("drawPtBlueprint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders only the checklist groups enabled for the PT activity flags", async () => {
    await drawPtBlueprint(
      {} as never,
      jest.fn() as never,
      {
        id: "pt-1",
        numero: "PT-001",
        titulo: "Manutenção em altura",
        descricao: "Troca de luminária",
        data_hora_inicio: "2026-03-16T08:00:00.000Z",
        data_hora_fim: "2026-03-16T12:00:00.000Z",
        status: "Pendente",
        company_id: "company-1",
        site_id: "site-1",
        responsavel_id: "user-1",
        executantes: [{ id: "user-1", nome: "João", funcao: "Eletricista" }],
        trabalho_altura: true,
        espaco_confinado: false,
        trabalho_quente: false,
        eletricidade: false,
        escavacao: false,
        trabalho_altura_checklist: [
          { id: "a", pergunta: "Linha de vida", resposta: "Sim" },
        ],
        trabalho_eletrico_checklist: [
          { id: "b", pergunta: "Bloqueio", resposta: "Sim" },
        ],
        trabalho_quente_checklist: [
          { id: "c", pergunta: "Extintor", resposta: "Sim" },
        ],
        trabalho_espaco_confinado_checklist: [
          { id: "d", pergunta: "Atmosfera", resposta: "Sim" },
        ],
        trabalho_escavacao_checklist: [
          { id: "e", pergunta: "Escoramento", resposta: "Sim" },
        ],
        created_at: "2026-03-16T08:00:00.000Z",
        updated_at: "2026-03-16T08:00:00.000Z",
        site: { nome: "Obra Norte" },
        responsavel: { nome: "Responsável" },
      } as never,
      [],
      "PT-2026-001",
      "https://example.com/verify/PT-2026-001",
    );

    expect(drawChecklistTable).toHaveBeenCalledTimes(1);
    expect(drawChecklistTable).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Checklist trabalho em altura",
      expect.anything(),
      expect.anything(),
    );
    expect(drawParticipantTable).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Equipe executante (1)",
      [
        expect.objectContaining({
          name: "João",
          role: "Eletricista",
        }),
      ],
    );
  });

  it("keeps rendering a legacy checklist group with meaningful answers when flags are absent", async () => {
    await drawPtBlueprint(
      {} as never,
      jest.fn() as never,
      {
        id: "pt-legacy",
        numero: "PT-LEG-1",
        titulo: "PT legada",
        descricao: "Documento legado",
        data_hora_inicio: "2026-03-16T08:00:00.000Z",
        data_hora_fim: "2026-03-16T12:00:00.000Z",
        status: "Aprovada",
        company_id: "company-1",
        site_id: "site-1",
        responsavel_id: "user-1",
        executantes: [],
        trabalho_altura: false,
        espaco_confinado: false,
        trabalho_quente: false,
        eletricidade: false,
        escavacao: false,
        trabalho_altura_checklist: [{ id: "a", pergunta: "Linha de vida" }],
        trabalho_eletrico_checklist: [
          { id: "b", pergunta: "Bloqueio", resposta: "Sim" },
        ],
        trabalho_quente_checklist: [{ id: "c", pergunta: "Extintor" }],
        trabalho_espaco_confinado_checklist: [
          { id: "d", pergunta: "Atmosfera" },
        ],
        trabalho_escavacao_checklist: [{ id: "e", pergunta: "Escoramento" }],
        created_at: "2026-03-16T08:00:00.000Z",
        updated_at: "2026-03-16T08:00:00.000Z",
      } as never,
      [],
      "PT-LEG-2026-001",
      "https://example.com/verify/PT-LEG-2026-001",
    );

    expect(drawChecklistTable).toHaveBeenCalledTimes(1);
    expect(drawChecklistTable).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Checklist trabalho elétrico",
      expect.anything(),
      expect.anything(),
    );
  });

  const basePt = {
    id: "pt-nr",
    numero: "PT-NR-1",
    titulo: "PT normativa",
    descricao: "Atividade em espaço confinado",
    data_hora_inicio: "2026-03-16T08:00:00.000Z",
    data_hora_fim: "2026-03-16T12:00:00.000Z",
    status: "Aprovada",
    company_id: "company-1",
    site_id: "site-1",
    responsavel_id: "user-1",
    executantes: [],
    trabalho_altura: false,
    espaco_confinado: true,
    trabalho_quente: false,
    eletricidade: false,
    escavacao: false,
    trabalho_espaco_confinado_checklist: [
      { id: "d", pergunta: "Atmosfera", resposta: "Sim" },
    ],
    created_at: "2026-03-16T08:00:00.000Z",
    updated_at: "2026-03-16T08:00:00.000Z",
  };

  it("renders emergency/rescue grid and medições table when data is present", async () => {
    await drawPtBlueprint(
      {} as never,
      jest.fn() as never,
      {
        ...basePt,
        contato_emergencia: "Brigada (11) 99999-0000",
        plano_resgate: "Equipe própria com tripé",
        vigia_nome: "Pedro Lima",
        epis_obrigatorios: ["Cinto", "Detector"],
        medicoes_atmosfericas: [
          {
            id: "m1",
            hora: "08:30",
            oxigenio: 20.9,
            inflamaveis_lel: 0,
            co: 2,
            h2s: 0,
            instrumento: "MX6",
            responsavel: "Fabio",
          },
        ],
      } as never,
      [],
      "PT-NR-2026-001",
      "https://example.com/verify/PT-NR-2026-001",
    );

    expect(drawMetadataGrid).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Emergência, resgate e EPIs" }),
    );
    expect(drawNarrativeSection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Plano de resgate" }),
    );
    expect(drawSemanticTable).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Medições atmosféricas (NR-33)" }),
    );
  });

  it("skips emergency grid, medições and gallery when data is absent", async () => {
    await drawPtBlueprint(
      {} as never,
      jest.fn() as never,
      { ...basePt, espaco_confinado: false, trabalho_espaco_confinado_checklist: [] } as never,
      [],
      "PT-NR-2026-002",
      "https://example.com/verify/PT-NR-2026-002",
    );

    expect(drawMetadataGrid).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Emergência, resgate e EPIs" }),
    );
    expect(drawSemanticTable).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Medições atmosféricas (NR-33)" }),
    );
    expect(drawEvidenceGallery).not.toHaveBeenCalled();
  });

  it("renders evidence gallery with fase labels and closure block only for Encerrada", async () => {
    const resolveEvidencePhotoDataUrl = jest
      .fn()
      .mockResolvedValue("data:image/png;base64,abc");

    await drawPtBlueprint(
      {} as never,
      jest.fn() as never,
      {
        ...basePt,
        status: "Encerrada",
        fotos_evidencia: [
          {
            ref: "gst:pt-photo:x",
            fase: "antes",
            legenda: "Área isolada",
            uploaded_at: "2026-03-16T07:30:00.000Z",
          },
        ],
        encerrado_por: { nome: "Mariana" },
        data_hora_real_fim: "2026-03-16T11:45:00.000Z",
        condicao_area_encerramento: "Limpa e liberada",
        observacoes_encerramento: "Sem pendências",
      } as never,
      [],
      "PT-NR-2026-003",
      "https://example.com/verify/PT-NR-2026-003",
      { resolveEvidencePhotoDataUrl },
    );

    expect(drawEvidenceGallery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "Evidências fotográficas da área",
        items: [
          expect.objectContaining({
            title: "Antes da atividade",
            description: "Área isolada",
          }),
        ],
      }),
    );
    expect(drawMetadataGrid).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Encerramento e devolução da área" }),
    );
    expect(drawNarrativeSection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Observações de encerramento" }),
    );
  });

  it("does not render closure block when PT is not Encerrada even with closure fields", async () => {
    await drawPtBlueprint(
      {} as never,
      jest.fn() as never,
      {
        ...basePt,
        status: "Aprovada",
        condicao_area_encerramento: "Limpa e liberada",
      } as never,
      [],
      "PT-NR-2026-004",
      "https://example.com/verify/PT-NR-2026-004",
    );

    expect(drawMetadataGrid).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Encerramento e devolução da área" }),
    );
  });

  it("exposes readiness blockers and coerces governance copy in draft mode", async () => {
    await drawPtBlueprint(
      { isDraft: true } as never,
      jest.fn() as never,
      {
        ...basePt,
        numero: "PT-READY-1",
        status: "Pendente",
        executantes: [],
        contato_emergencia: "",
        plano_resgate: "",
        vigia_nome: "",
        medicoes_atmosfericas: [],
        fotos_evidencia: [],
      } as never,
      [],
      "PT-READY-1",
      "https://example.com/verify/PT-READY-1",
    );

    expect(drawSemanticTable).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Bloqueios antes da liberação" }),
    );
    expect(drawGovernanceClosingBlock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        draft: true,
        subtitle:
          "Prévia para revisão. O documento oficial é emitido pelo backend do SGS.",
      }),
    );
  });
});
