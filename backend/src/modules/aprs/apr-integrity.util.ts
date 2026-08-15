import { Apr } from './entities/apr.entity';
import { AprRiskEvidence } from './entities/apr-risk-evidence.entity';
import {
  canonicalizeSignaturePayload,
  hashCanonicalSignaturePayload,
} from '../signatures/signature-proof.util';

export const APR_CONTENT_HASH_ALGORITHM = 'SHA-256';
export const APR_CONTENT_CANONICALIZATION_VERSION = 1;
export const APR_CONTENT_INTEGRITY_SCHEME = 'CONTENT_HASH_V1';

type NamedRelation = {
  id: string;
  nome?: string | null;
  funcao?: string | null;
  categoria?: string | null;
  descricao?: string | null;
  medidas_controle?: string | null;
  ca?: string | null;
  numero_serie?: string | null;
  placa?: string | null;
};

export type AprSignableInput = Pick<
  Apr,
  | 'id'
  | 'company_id'
  | 'site_id'
  | 'elaborador_id'
  | 'auditado_por_id'
  | 'numero'
  | 'titulo'
  | 'descricao'
  | 'tipo_atividade'
  | 'frente_trabalho'
  | 'area_risco'
  | 'turno'
  | 'local_execucao_detalhado'
  | 'responsavel_tecnico_nome'
  | 'responsavel_tecnico_registro'
  | 'data_inicio'
  | 'data_fim'
  | 'status'
  | 'is_modelo'
  | 'is_modelo_padrao'
  | 'probability'
  | 'severity'
  | 'exposure'
  | 'initial_risk'
  | 'residual_risk'
  | 'evidence_photo'
  | 'evidence_document'
  | 'control_description'
  | 'control_evidence'
  | 'versao'
  | 'parent_apr_id'
  | 'data_auditoria'
  | 'resultado_auditoria'
  | 'notas_auditoria'
> & {
  company?: NamedRelation | null;
  site?: NamedRelation | null;
  elaborador?: NamedRelation | null;
  auditado_por?: NamedRelation | null;
  activities?: NamedRelation[];
  risks?: NamedRelation[];
  epis?: NamedRelation[];
  tools?: NamedRelation[];
  machines?: NamedRelation[];
  participants?: NamedRelation[];
  risk_items?: object[];
  evidences?: AprRiskEvidence[];
};

export type AprSignableContentV1 = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value.normalize('NFC') : null;
}

function dateOnly(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

function dateTime(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

function relationSummary(relation: NamedRelation | null | undefined) {
  if (!relation) return null;
  return {
    id: relation.id,
    nome: text(relation.nome),
    funcao: text(relation.funcao),
    categoria: text(relation.categoria),
    descricao: text(relation.descricao),
    medidas_controle: text(relation.medidas_controle),
    ca: text(relation.ca),
    numero_serie: text(relation.numero_serie),
    placa: text(relation.placa),
  };
}

function sortedRelations(relations?: NamedRelation[]) {
  return (relations || [])
    .map((relation) => relationSummary(relation))
    .sort((left, right) => String(left?.id).localeCompare(String(right?.id)));
}

export function buildAprSignableContentV1(
  apr: AprSignableInput,
): AprSignableContentV1 {
  const riskItems = (apr.risk_items || [])
    .map((item) => {
      const record = item as Record<string, unknown>;
      const id = record.id;
      return {
        id: typeof id === 'string' || typeof id === 'number' ? String(id) : '',
        ordem: Number(record.ordem || 0),
        atividade: text(record.atividade),
        etapa: text(record.etapa),
        agente_ambiental: text(record.agente_ambiental),
        condicao_perigosa: text(record.condicao_perigosa),
        fonte_circunstancia: text(record.fonte_circunstancia),
        lesao: text(record.lesao),
        probabilidade: record.probabilidade ?? null,
        severidade: record.severidade ?? null,
        score_risco: record.score_risco ?? null,
        categoria_risco: text(record.categoria_risco),
        prioridade: text(record.prioridade),
        medidas_prevencao: text(record.medidas_prevencao),
        epc: text(record.epc),
        epi: text(record.epi),
        permissao_trabalho: text(record.permissao_trabalho),
        normas_relacionadas: text(record.normas_relacionadas),
        hierarquia_controle: text(record.hierarquia_controle),
        residual_probabilidade: record.residual_probabilidade ?? null,
        residual_severidade: record.residual_severidade ?? null,
        residual_score: record.residual_score ?? null,
        residual_categoria: text(record.residual_categoria),
        responsavel: text(record.responsavel),
        prazo: dateOnly(record.prazo),
        status_acao: text(record.status_acao),
      };
    })
    .sort(
      (left, right) =>
        left.ordem - right.ordem || left.id.localeCompare(right.id),
    );

  const evidences = (apr.evidences || [])
    .map((evidence) => ({
      id: evidence.id,
      risk_item_id: evidence.apr_risk_item_id,
      original_name: text(evidence.original_name),
      hash_sha256: evidence.hash_sha256 || null,
      watermarked_hash_sha256: evidence.watermarked_hash_sha256 || null,
      captured_at: dateTime(evidence.captured_at),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return canonicalizeSignaturePayload({
    canonicalization_version: APR_CONTENT_CANONICALIZATION_VERSION,
    document: {
      id: apr.id,
      version: apr.versao,
      parent_id: apr.parent_apr_id,
      company_id: apr.company_id,
      company: relationSummary(apr.company),
      site_id: apr.site_id,
      site: relationSummary(apr.site),
      numero: text(apr.numero),
      titulo: text(apr.titulo),
      descricao: text(apr.descricao),
      tipo_atividade: text(apr.tipo_atividade),
      frente_trabalho: text(apr.frente_trabalho),
      area_risco: text(apr.area_risco),
      turno: text(apr.turno),
      local_execucao_detalhado: text(apr.local_execucao_detalhado),
      responsavel_tecnico_nome: text(apr.responsavel_tecnico_nome),
      responsavel_tecnico_registro: text(apr.responsavel_tecnico_registro),
      data_inicio: dateOnly(apr.data_inicio),
      data_fim: dateOnly(apr.data_fim),
      status: text(apr.status),
      is_modelo: apr.is_modelo,
      is_modelo_padrao: apr.is_modelo_padrao,
      probability: apr.probability ?? null,
      severity: apr.severity ?? null,
      exposure: apr.exposure ?? null,
      initial_risk: apr.initial_risk ?? null,
      residual_risk: text(apr.residual_risk),
      evidence_photo: text(apr.evidence_photo),
      evidence_document: text(apr.evidence_document),
      control_description: text(apr.control_description),
      control_evidence: apr.control_evidence,
      data_auditoria: dateTime(apr.data_auditoria),
      resultado_auditoria: text(apr.resultado_auditoria),
      notas_auditoria: text(apr.notas_auditoria),
      elaborador: {
        id: apr.elaborador_id,
        ...relationSummary(apr.elaborador),
      },
      auditado_por: apr.auditado_por_id
        ? { id: apr.auditado_por_id, ...relationSummary(apr.auditado_por) }
        : null,
      activities: sortedRelations(apr.activities),
      risks: sortedRelations(apr.risks),
      epis: sortedRelations(apr.epis),
      tools: sortedRelations(apr.tools),
      machines: sortedRelations(apr.machines),
      participants: sortedRelations(apr.participants),
      risk_items: riskItems,
      evidences,
    },
  }) as AprSignableContentV1;
}

export function hashAprSignableContentV1(apr: AprSignableInput): string {
  return hashCanonicalSignaturePayload(buildAprSignableContentV1(apr));
}
