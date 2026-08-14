import type { Did } from '@/services/didsService';
import {
  getDidStatusLabel,
  getDidTurnoLabel,
} from '../../../../app/dashboard/dids/didMeta';
import type { AutoTableFn, PdfContext } from '../core/types';
import { formatDate, formatDateTime, sanitize } from '../core/format';
import {
  drawDocumentIdentityRail,
  drawExecutiveSummaryStrip,
  drawGovernanceClosingBlock,
  drawMetadataGrid,
  drawNarrativeSection,
} from '../components';
import { drawParticipantTable } from '../tables';

type DidParticipantLike = { nome?: string; funcao?: string };

function resolveDidText(
  value?: string | number | null,
  fallback = 'Não informado',
) {
  const normalized = sanitize(value);
  return normalized === '-' ? fallback : normalized;
}

function buildStatusTone(status: string) {
  if (status === 'executado') return 'success' as const;
  if (status === 'alinhado') return 'info' as const;
  if (status === 'rascunho') return 'warning' as const;
  return 'default' as const;
}

function buildCriticality(did: Did) {
  if (did.status === 'arquivado') return 'Encerrado';
  if (did.status === 'executado') return 'Controlado';
  if (did.status === 'alinhado') return 'Atenção ativa';
  return 'Em preparação';
}

export async function drawDidBlueprint(
  ctx: PdfContext,
  autoTable: AutoTableFn,
  did: Did,
  code: string,
  validationUrl: string,
) {
  const participantCount = did.participants?.length ?? 0;
  const mainActivity = resolveDidText(did.atividade_principal);
  const shiftLabel = resolveDidText(getDidTurnoLabel(did.turno), 'A definir');
  const responsibleName = resolveDidText(did.responsavel?.nome);
  const siteName = resolveDidText(did.site?.nome || did.site_id);
  const frontName = resolveDidText(did.frente_trabalho);

  drawDocumentIdentityRail(ctx, {
    documentType: 'DID',
    criticality: buildCriticality(did),
    documentClass: 'Operacional',
  });

  drawExecutiveSummaryStrip(ctx, {
    title: 'Leitura rápida do turno',
    summary:
      'Documento operacional para leitura rápida do alinhamento diário, com foco em atividade, responsável, equipe e barreiras críticas antes do início do turno.',
    metrics: [
      {
        label: 'Atividade principal',
        value: mainActivity,
        tone: 'info',
      },
      {
        label: 'Turno',
        value: shiftLabel,
        tone: 'default',
      },
      {
        label: 'Status',
        value: sanitize(getDidStatusLabel(did.status)),
        tone: buildStatusTone(did.status),
      },
      {
        label: 'Participantes',
        value: participantCount,
        tone: participantCount > 0 ? 'success' : 'warning',
      },
      {
        label: 'Responsável',
        value: responsibleName,
        tone: 'success',
      },
      {
        label: 'Frente de trabalho',
        value: frontName,
        tone: did.frente_trabalho ? 'default' : 'warning',
      },
    ],
  });

  drawMetadataGrid(ctx, {
    title: 'Contexto do turno',
    columns: 2,
    fields: [
      { label: 'Título do DID', value: did.titulo },
      {
        label: 'Empresa',
        value: resolveDidText(did.company?.razao_social || did.company_id),
      },
      { label: 'Data do alinhamento', value: formatDate(did.data) },
      { label: 'Turno previsto', value: shiftLabel },
      { label: 'Site / Obra', value: siteName },
      { label: 'Frente de trabalho', value: frontName },
      { label: 'Responsável pelo alinhamento', value: responsibleName },
      { label: 'Participantes previstos', value: participantCount },
      { label: 'Criado em', value: formatDateTime(did.created_at) },
      { label: 'Última atualização', value: formatDateTime(did.updated_at) },
    ],
  });

  drawNarrativeSection(ctx, {
    title: 'Descrição e objetivo do alinhamento',
    content: did.descricao,
  });

  drawNarrativeSection(ctx, {
    title: 'Atividade principal do turno',
    content: did.atividade_principal,
  });

  drawNarrativeSection(ctx, {
    title: 'Atividades planejadas',
    content: did.atividades_planejadas,
  });

  drawNarrativeSection(ctx, {
    title: 'Riscos operacionais prioritários',
    content: did.riscos_operacionais,
  });

  drawNarrativeSection(ctx, {
    title: 'Barreiras e controles definidos',
    content: did.controles_planejados,
  });

  drawNarrativeSection(ctx, {
    title: 'EPIs / EPCs aplicáveis',
    content: did.epi_epc_aplicaveis,
  });

  drawNarrativeSection(ctx, {
    title: 'Observações e recados finais',
    content: did.observacoes,
  });

  drawParticipantTable(
    ctx,
    autoTable,
    `Participantes (${participantCount})`,
    (did.participants || []).map((participant: DidParticipantLike) => ({
      name: participant.nome,
      role: participant.funcao,
    })),
  );

  await drawGovernanceClosingBlock(ctx, {
    signatures: [],
    code,
    url: validationUrl,
    title: 'Governança e autenticidade',
    subtitle: 'Valide o documento pelo QR Code ou pelo código público.',
  });
}
