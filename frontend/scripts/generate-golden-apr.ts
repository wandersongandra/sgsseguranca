import { mkdir, writeFile } from "node:fs/promises";
import { generateAprPdf } from "../src/lib/pdf/aprGenerator";

const goldenApr = {
  id: "golden-apr-demo-2026",
  numero: "APR-DEMO-2026-0042",
  titulo: "Instalação de estrutura metálica em altura",
  descricao:
    "Montagem de estrutura metálica com plataforma elevatória e movimentação de cargas na área de expansão do Complexo Industrial Alfa.",
  status: "Aprovada",
  versao: 2,
  data_inicio: "2026-08-13",
  data_fim: "2026-08-20",
  company_id: "company-demo-sgs",
  site_id: "site-demo-alfa",
  elaborador_id: "user-demo-tst",
  company: {
    id: "company-demo-sgs",
    razao_social: "Empresa Demonstrativa SGS",
    cnpj: "00.000.000/0000-00",
    logo_url: null,
  },
  site: { id: "site-demo-alfa", nome: "Complexo Industrial Alfa" },
  elaborador: { id: "user-demo-tst", nome: "Técnico de Segurança de Teste", funcao: "TST" },
  responsavel_tecnico_nome: "Engenharia de Segurança Demonstrativa",
  responsavel_tecnico_registro: "REG-TESTE-0001",
  frente_trabalho: "Área de expansão - setor B",
  area_risco: "Montagem, içamento e trabalho em altura",
  turno: "Diurno",
  local_execucao_detalhado: "Plataforma de montagem da expansão industrial",
  participants: [
    { id: "participant-1", nome: "Operador de plataforma (teste)", funcao: "Operador" },
    { id: "participant-2", nome: "Montador líder (teste)", funcao: "Montador" },
    { id: "participant-3", nome: "Sinaleiro (teste)", funcao: "Sinaleiro" },
  ],
  approval_steps: [
    {
      id: "approval-1",
      apr_id: "golden-apr-demo-2026",
      level_order: 1,
      title: "Revisão do TST",
      approver_role: "TST",
      status: "approved",
      decision_reason: "Controles críticos conferidos em ambiente de teste.",
    },
    {
      id: "approval-2",
      apr_id: "golden-apr-demo-2026",
      level_order: 2,
      title: "Aprovação da supervisão",
      approver_role: "SUPERVISOR",
      status: "approved",
      decision_reason: "Plano de içamento e isolamento validados.",
    },
  ],
  itens_risco: [
    {
      atividade_processo: "Montagem de treliças e vigas",
      agente_ambiental: "Físico / acidente",
      condicao_perigosa: "Trabalho em altura acima de 6 metros",
      fontes_circunstancias: "Acesso por plataforma elevatória e bordas expostas",
      possiveis_lesoes: "Queda com potencial de lesão grave ou fatal",
      probabilidade: "3",
      severidade: "5",
      score_risco: "15",
      categoria_risco: "Alto",
      medidas_prevencao: "Inspeção da plataforma, linha de vida, cinto paraquedista, isolamento da área e autorização de trabalho.",
      epi: "Capacete com jugular; cinto paraquedista; talabarte; óculos; luvas; calçado de segurança.",
      epc: "Guarda-corpo; linha de vida; isolamento e sinalização.",
      responsavel: "Montador líder",
      prazo: "2026-08-13",
      status_acao: "Implementado",
    },
    {
      atividade_processo: "Movimentação de cargas",
      agente_ambiental: "Mecânico",
      condicao_perigosa: "Carga suspensa durante içamento de componentes",
      fontes_circunstancias: "Guindaste, acessórios de içamento e circulação de equipe",
      possiveis_lesoes: "Esmagamento, prensamento e impacto",
      probabilidade: "2",
      severidade: "5",
      score_risco: "10",
      categoria_risco: "Substancial",
      medidas_prevencao: "Plano de içamento, sinaleiro dedicado, inspeção de acessórios, rota isolada e comunicação padronizada.",
      epi: "Capacete; colete refletivo; luvas; calçado de segurança.",
      epc: "Barreiras; cones; área de exclusão.",
      responsavel: "Sinaleiro",
      prazo: "2026-08-13",
      status_acao: "Implementado",
    },
    {
      atividade_processo: "Fixação e acabamento",
      agente_ambiental: "Físico / ergonômico",
      condicao_perigosa: "Uso de ferramentas elétricas e postura prolongada",
      fontes_circunstancias: "Furadeira, esmerilhadeira e trabalho manual repetitivo",
      possiveis_lesoes: "Cortes, ruído, vibração e fadiga musculoesquelética",
      probabilidade: "2",
      severidade: "3",
      score_risco: "6",
      categoria_risco: "Médio",
      medidas_prevencao: "Ferramentas inspecionadas, proteção do disco, pausas operacionais, revezamento e controle de ruído.",
      epi: "Óculos; protetor facial; protetor auricular; luvas anticorte.",
      epc: "Biombo de proteção e sinalização da frente de serviço.",
      responsavel: "Encarregado de montagem",
      prazo: "2026-08-14",
      status_acao: "Implementado",
    },
  ],
} as never;

async function main() {
// A fixture de demonstração registra o estado da assinatura sem simular uma
// assinatura manuscrita ou carregar material biométrico no artefato.
const syntheticSignature = "";

const goldenSignatures = [
  {
    id: "signature-demo-1",
    document_id: "golden-apr-demo-2026",
    document_type: "APR",
    signature_data: syntheticSignature,
    type: "digital",
    user_id: "participant-1",
    user: { nome: "Operador de plataforma (teste)", funcao: "Operador" },
    signed_at: "2026-08-13T14:42:00.000Z",
    created_at: "2026-08-13T14:42:00.000Z",
  },
  {
    id: "signature-demo-2",
    document_id: "golden-apr-demo-2026",
    document_type: "APR",
    signature_data: syntheticSignature,
    type: "digital",
    user_id: "participant-2",
    user: { nome: "Montador líder (teste)", funcao: "Montador" },
    signed_at: "2026-08-13T14:47:00.000Z",
    created_at: "2026-08-13T14:47:00.000Z",
  },
  {
    id: "signature-demo-3",
    document_id: "golden-apr-demo-2026",
    document_type: "APR",
    signature_data: syntheticSignature,
    type: "digital",
    user_id: "participant-3",
    user: { nome: "Sinaleiro (teste)", funcao: "Sinaleiro" },
    signed_at: "2026-08-13T14:51:00.000Z",
    created_at: "2026-08-13T14:51:00.000Z",
  },
] as never;

const result = await generateAprPdf(goldenApr, goldenSignatures, {
    save: false,
    output: "base64",
  });

  if (!result || !("base64" in result)) {
    throw new Error("A geração da Golden APR não retornou bytes PDF.");
  }

  const outputPath = "../output/pdf/golden-apr.pdf";
  await mkdir("../output/pdf", { recursive: true });
  await writeFile(outputPath, Buffer.from(result.base64, "base64"));
  console.log(`Golden APR PDF gerado em ${outputPath}`);
}

void main();
