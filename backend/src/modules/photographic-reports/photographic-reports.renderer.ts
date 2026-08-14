import {
  PhotographicReportAreaStatus,
  PhotographicReportShift,
  PhotographicReportTone,
} from './entities/photographic-report.entity';
import type {
  PhotographicReportDayResponse,
  PhotographicReportImageResponse,
  PhotographicReportListItemResponse,
  PhotographicReportResponse,
} from './photographic-reports.types';

/**
 * Este renderer é a contraparte HTML/Puppeteer do design system de PDF do
 * frontend (`frontend/src/lib/pdf-system`). Tokens, componentes e estrutura de
 * seções seguem, na medida do possível em HTML, as mesmas definições de:
 *
 *  - tokens/visualTokens.ts        → paleta base, tipografia e espaçamento
 *  - variants/photographicTheme.ts → variante "photographic" (brand #18517C)
 *  - components/DocumentHeader     → faixa de marca full-bleed + caixa de código
 *  - components/DocumentIdentityRail → cartões com pílula de acento
 *  - components/ExecutiveSummaryStrip → faixa de leitura executiva + métricas
 *  - components/MetadataGrid       → cartão com barra de título e grade 2 col.
 *  - components/NarrativeSection   → cartão de texto com acento lateral
 *  - components/EvidenceGallery    → cabeçalho + cartões de evidência
 *  - blueprints/photographicReportBlueprint → ordem das seções e textos
 *
 * Medidas em mm e fontes em pt para mapear 1:1 com o jsPDF do pdf-system.
 */

export type PhotographicReportRenderableImage =
  PhotographicReportImageResponse & {
    data_url: string | null;
    activity_date_label: string;
  };

/** Assinatura já achatada para renderização — sem entidade do TypeORM aqui. */
export type RenderableSignature = {
  signerName: string | null;
  signerRole: string | null;
  type: string | null;
  signedAt: string | null;
  signatureHash: string | null;
  /** Data URI pequeno, ou null quando o payload está no storage. */
  signatureImage: string | null;
};

// ── core/format.ts ────────────────────────────────────────────────────────────

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Equivalente ao sanitize() do pdf-system: normaliza vazio para "-". */
function sanitize(value: string | number | null | undefined): string {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : '-';
}

/**
 * Datas de atividade são date-only (YYYY-MM-DD) e não podem sofrer conversão de
 * fuso: sem timeZone UTC o Date nasce à meia-noite UTC e o locale pt-BR (UTC-3)
 * exibe o dia anterior.
 */
function formatDate(value?: string | null): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function formatRange(
  startDate?: string | null,
  endDate?: string | null,
): string {
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  if (!start && !end) return '-';
  if (start && end && start !== end) return `${start} a ${end}`;
  return start || end || '-';
}

/**
 * Formata CNPJ como 00.000.000/0000-00.
 *
 * Se o valor não tiver 14 dígitos, é devolvido como veio: num documento
 * técnico, exibir o dado cadastrado é mais honesto do que mascarar um
 * cadastro incompleto até ele parecer válido.
 */
function formatCnpj(value?: string | null): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 14) return String(value ?? '').trim();
  return digits.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    '$1.$2.$3/$4-$5',
  );
}

function formatClockRange(
  startTime?: string | null,
  endTime?: string | null,
): string {
  const trim = (v?: string | null) => {
    const t = String(v ?? '').trim();
    return t.length >= 5 ? t.slice(0, 5) : t;
  };
  const start = trim(startTime);
  const end = trim(endTime);
  if (start && end && start !== end) return `${start} às ${end}`;
  return start || end || '-';
}

// ── blueprints/photographicReportBlueprint.ts ─────────────────────────────────

function buildPeriodLabel(report: PhotographicReportListItemResponse): string {
  const range = formatRange(report.start_date, report.end_date);
  const timeRange = formatClockRange(report.start_time, report.end_time);
  if (range === '-' && timeRange === '-') return '-';
  if (range !== '-' && timeRange !== '-') return `${range} • ${timeRange}`;
  return range !== '-' ? range : timeRange;
}

function buildActivityTone(report: PhotographicReportListItemResponse): string {
  const tone = String(report.report_tone || '').toLowerCase();
  const area = String(report.area_status || '').toLowerCase();
  if (tone.includes('prevent')) return 'Preventivo';
  if (tone.includes('téc') || tone.includes('tec')) return 'Técnico';
  if (area.includes('fechada') || area.includes('controlada')) {
    return 'Controlado';
  }
  return 'Operacional';
}

function toneLabel(tone: PhotographicReportTone): string {
  switch (tone) {
    case PhotographicReportTone.TECNICO:
      return 'Técnico';
    case PhotographicReportTone.PREVENTIVO:
      return 'Preventivo';
    default:
      return 'Positivo';
  }
}

/**
 * Contexto de menor interferência externa, na leitura executiva.
 *
 * O blueprint do frontend usa dois conjuntos ligeiramente diferentes: a leitura
 * executiva não considera "Área isolada", a descrição geral considera. A
 * diferença é preservada de propósito — ver `isControlledEnvironment`.
 */
function hasReducedInterference(
  report: PhotographicReportListItemResponse,
): boolean {
  return (
    report.area_status === PhotographicReportAreaStatus.LOJA_FECHADA ||
    report.area_status === PhotographicReportAreaStatus.AREA_CONTROLADA ||
    report.shift === PhotographicReportShift.NOTURNO
  );
}

/** Idem, acrescido de "Área isolada", como na descrição geral do blueprint. */
function isControlledEnvironment(
  report: PhotographicReportListItemResponse,
): boolean {
  return (
    hasReducedInterference(report) ||
    report.area_status === PhotographicReportAreaStatus.AREA_ISOLADA
  );
}

function buildExecutiveSummary(
  report: PhotographicReportListItemResponse,
  totalPhotos: number,
  totalDays: number,
): string {
  const base =
    `Relatório fotográfico de ${sanitize(report.activity_type)}, com ` +
    `${totalPhotos} foto(s) distribuída(s) em ${totalDays} data(s) de registro.`;
  const controlNote = hasReducedInterference(report)
    ? 'O contexto operacional indica ambiente mais controlado, com menor interferência externa e melhores condições para execução segura das atividades.'
    : 'O registro foi conduzido em contexto operacional ativo, com observação visual da frente de serviço e rastreabilidade por imagem.';
  return `${base} ${controlNote}`;
}

function buildReportObjective(
  report: PhotographicReportListItemResponse,
): string {
  return [
    `Registrar de forma fotográfica a atividade de ${sanitize(report.activity_type)} executada para ${sanitize(report.client_name)}.`,
    `Obra: ${sanitize(report.project_name)}.`,
    report.unit_name ? `Unidade: ${sanitize(report.unit_name)}.` : '',
    report.location ? `Local específico: ${sanitize(report.location)}.` : '',
    `Responsável: ${sanitize(report.responsible_name)}.`,
    `Empresa executora: ${sanitize(report.contractor_company)}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

function buildGeneralConditions(
  report: PhotographicReportListItemResponse,
): string {
  const conditions: string[] = [
    `Condição da área: ${sanitize(report.area_status)}. Turno: ${sanitize(report.shift)}.`,
  ];

  if (isControlledEnvironment(report)) {
    conditions.push(
      'Considerando o ambiente com controle operacional ampliado, a atividade apresentou menor interferência externa e favoreceu a execução organizada do trabalho.',
    );
  } else {
    conditions.push(
      'A atividade ocorreu em cenário operacional regular, com acompanhamento visual suficiente para registrar o andamento das frentes de serviço.',
    );
  }

  if (report.general_observations) {
    // O blueprint do frontend concatena "." fixo e produz ".." quando a
    // observação já termina em pontuação; aqui a pontuação final é preservada.
    const observations = sanitize(report.general_observations).replace(
      /[.;:,\s]+$/,
      '',
    );
    conditions.push(`Observações do cadastro: ${observations}.`);
  }

  return conditions.join(' ');
}

function buildConsolidatedAssessment(
  report: PhotographicReportListItemResponse,
  totalPhotos: number,
): string {
  if (report.ai_summary) return sanitize(report.ai_summary);
  const plural =
    totalPhotos > 1 ? 'registros fotográficos' : 'registro fotográfico';
  return `O conjunto apresenta ${plural} organizado(s), com rastreabilidade documental preservada e aderência ao tipo de atividade informado (${sanitize(report.activity_type)}).`;
}

function buildTechnicalOpinion(
  report: PhotographicReportListItemResponse,
): string {
  return [
    `O parecer técnico considera a atividade de ${sanitize(report.activity_type)} com abordagem compatível ao contexto informado pelo usuário.`,
    `A condição da área foi registrada como ${sanitize(report.area_status)}, com tom editorial ${sanitize(toneLabel(report.report_tone))}.`,
    'Os textos gerados e a seleção fotográfica podem ser ajustados manualmente antes da emissão final, mantendo linguagem objetiva e profissional.',
  ].join(' ');
}

function buildFinalConclusion(
  report: PhotographicReportListItemResponse,
): string {
  if (report.final_conclusion) return sanitize(report.final_conclusion);
  return [
    `Conclui-se que o relatório fotográfico da atividade de ${sanitize(report.activity_type)} foi estruturado com organização, rastreabilidade e leitura técnica adequada.`,
    'O material reúne dados da obra, período, responsáveis e evidências visuais para apoiar o acompanhamento operacional e documental.',
  ].join(' ');
}

function buildDaySummary(
  day: PhotographicReportDayResponse | null,
  images: PhotographicReportRenderableImage[],
  report: PhotographicReportListItemResponse,
): string {
  if (day?.day_summary) return sanitize(day.day_summary);
  return `Data com ${images.length} foto(s) vinculada(s) à atividade de ${sanitize(report.activity_type)}, registrada sob condição ${sanitize(report.area_status)}.`;
}

// ── agrupamento por data ──────────────────────────────────────────────────────

type PhotographicReportGroup = {
  day: PhotographicReportDayResponse | null;
  items: PhotographicReportRenderableImage[];
};

function groupImagesByDay(
  days: PhotographicReportDayResponse[],
  images: PhotographicReportRenderableImage[],
): PhotographicReportGroup[] {
  const dayMap = new Map(days.map((d) => [d.id, d]));
  const buckets = new Map<string, PhotographicReportRenderableImage[]>();

  for (const image of images) {
    const key = image.report_day_id || 'unassigned';
    const existing = buckets.get(key) || [];
    existing.push(image);
    buckets.set(key, existing);
  }

  const orderedDayIds = [
    ...days
      .slice()
      .sort((a, b) => a.activity_date.localeCompare(b.activity_date))
      .map((d) => d.id),
    ...(buckets.has('unassigned') ? ['unassigned'] : []),
  ];

  return orderedDayIds
    .map((dayId) => ({
      day: dayId === 'unassigned' ? null : (dayMap.get(dayId) ?? null),
      items: (buckets.get(dayId) || []).sort(
        (a, b) => a.image_order - b.image_order,
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/** Tom semântico da classificação, no vocabulário do pdf-system. */
function classificationTone(value: string | null | undefined): string {
  switch (value) {
    case 'Muito satisfatória':
      return 'success';
    case 'Satisfatória':
      return 'info';
    case 'Ponto de atenção preventivo':
      return 'warning';
    case 'Atenção necessária':
      return 'danger';
    default:
      return 'default';
  }
}

function summarizeClassifications(
  images: PhotographicReportRenderableImage[],
): {
  total: number;
  muitoSatisfatoria: number;
  satisfatoria: number;
  preventiva: number;
  atencao: number;
  naoConformidades: number;
} {
  const summary = {
    total: images.length,
    muitoSatisfatoria: 0,
    satisfatoria: 0,
    preventiva: 0,
    atencao: 0,
    naoConformidades: 0,
  };

  for (const image of images) {
    // Independente da classificação: a marcação de NC é decisão do
    // responsável, não derivada do parecer da IA.
    if (image.is_nonconformity) {
      summary.naoConformidades += 1;
    }

    switch (image.ai_condition_classification) {
      case 'Muito satisfatória':
        summary.muitoSatisfatoria += 1;
        break;
      case 'Satisfatória':
        summary.satisfatoria += 1;
        break;
      case 'Ponto de atenção preventivo':
        summary.preventiva += 1;
        break;
      case 'Atenção necessária':
        summary.atencao += 1;
        break;
      default:
        break;
    }
  }

  return summary;
}

// ── componentes (HTML) ────────────────────────────────────────────────────────

/** components/DocumentIdentityRail.ts — cartões com pílula de acento no topo. */
function renderIdentityRail(
  fields: { label: string; value: string }[],
): string {
  const accents = ['brand', 'info', 'warning', 'success'];
  const cards = fields
    .filter((f) => f.value && f.value.trim() !== '' && f.value !== '-')
    .map(
      (field, index) => `
        <div class="rail-card">
          <div class="pill pill--${accents[index % accents.length]}"></div>
          <div class="ds-label">${escapeHtml(field.label.toUpperCase())}</div>
          <div class="rail-value">${escapeHtml(field.value)}</div>
        </div>
      `,
    )
    .join('');
  return cards ? `<section class="rail">${cards}</section>` : '';
}

/**
 * Escolhe entre 2, 3 e 4 colunas a que produz a última linha mais cheia.
 * Empate resolve pelo menor número de colunas, que dá cards mais largos.
 */
function pickMetricColumns(total: number): 2 | 3 | 4 {
  if (total <= 4) return 2;

  const candidates: Array<2 | 3 | 4> = [4, 3];
  let best: 2 | 3 | 4 = 3;
  let bestRemainder = -1;

  for (const columns of candidates) {
    const remainder = total % columns;
    // Resto 0 significa última linha cheia — o melhor caso possível.
    const score = remainder === 0 ? columns : remainder;
    if (score > bestRemainder) {
      bestRemainder = score;
      best = columns;
    }
  }

  return best;
}

/** components/ExecutiveSummaryStrip.ts */
function renderExecutiveSummary(options: {
  title: string;
  summary: string;
  metrics: { label: string; value: string | number; tone: string }[];
}): string {
  /**
   * Número de colunas escolhido para não deixar card órfão na última linha.
   *
   * O ExecutiveSummaryStrip do pdf-system usa 2 ou 3 colunas, mas ele nunca
   * recebeu 7 métricas: com 3 colunas o resultado é 3+3+1, e o card sozinho na
   * última linha lê como erro de layout. Entre 4 e 3 colunas, escolhe a que
   * deixa a última linha mais cheia.
   */
  const columns = pickMetricColumns(options.metrics.length);
  const metrics = options.metrics
    .map(
      (metric) => `
        <div class="metric-card">
          <div class="pill pill--${escapeHtml(metric.tone)}"></div>
          <div class="ds-label">${escapeHtml(metric.label.toUpperCase())}</div>
          <div class="metric-value">${escapeHtml(metric.value)}</div>
        </div>
      `,
    )
    .join('');

  return `
    <section class="exec-strip">
      <div class="exec-tab"></div>
      <div class="exec-title">${escapeHtml(options.title)}</div>
      <p class="exec-summary">${escapeHtml(options.summary)}</p>
      <div class="metric-grid metric-grid--${columns}">${metrics}</div>
    </section>
  `;
}

/** components/MetadataGrid.ts — grade de 2 colunas com divisores finos. */
function renderMetadataGrid(options: {
  title: string;
  fields: { label: string; value: string }[];
}): string {
  const cells = options.fields
    .map(
      (field) => `
        <div class="meta-cell">
          <div class="ds-label">${escapeHtml(field.label.toUpperCase())}</div>
          <div class="meta-value">${escapeHtml(sanitize(field.value))}</div>
        </div>
      `,
    )
    .join('');

  return `
    <section class="ds-card">
      <div class="ds-card-head">
        <div class="ds-card-accent"></div>
        <div class="ds-card-title">${escapeHtml(options.title)}</div>
      </div>
      <div class="meta-grid">${cells}</div>
    </section>
  `;
}

/** components/NarrativeSection.ts */
function renderNarrative(title: string, content?: string | null): string {
  if (!content || !String(content).trim()) return '';
  return `
    <section class="ds-card">
      <div class="ds-card-head">
        <div class="ds-card-accent"></div>
        <div class="ds-card-title">${escapeHtml(title)}</div>
      </div>
      <div class="narrative">${escapeHtml(content)}</div>
    </section>
  `;
}

/** Formata bytes em KB/MB. O manifesto do APR imprime bytes crus, o que não se lê. */
function formatFileSize(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '—';
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Coordenada arredondada a ~1 km no servidor; a imprecisão é declarada no rodapé. */
function formatGeo(image: PhotographicReportRenderableImage): string {
  if (
    typeof image.latitude !== 'number' ||
    typeof image.longitude !== 'number'
  ) {
    return '—';
  }
  const accuracy =
    typeof image.accuracy_m === 'number'
      ? ` (±${Math.round(image.accuracy_m)} m)`
      : '';
  return `${image.latitude.toFixed(2)}, ${image.longitude.toFixed(2)}${accuracy}`;
}

/**
 * Bloco de credencial do responsável técnico.
 *
 * Fica logo após os dados da obra de propósito: é por este bloco que um
 * relatório técnico de SST é julgado, e enterrá-lo no fim do documento
 * equivaleria a escondê-lo.
 */
function renderTechnicalResponsible(
  report: PhotographicReportResponse,
): string {
  const registration = [
    report.responsible_registration_type,
    report.responsible_registration_state
      ? `-${report.responsible_registration_state}`
      : '',
    report.responsible_registration_number
      ? ` ${report.responsible_registration_number}`
      : '',
  ]
    .filter(Boolean)
    .join('');

  return renderMetadataGrid({
    title: 'Responsável técnico',
    fields: [
      { label: 'Nome', value: report.responsible_name },
      { label: 'Registro profissional', value: registration || '-' },
      { label: 'ART', value: report.art_number || '-' },
      { label: 'Empresa executora', value: report.contractor_company },
    ],
  });
}

/**
 * NRs aplicáveis como chips. Omitido quando vazio — declarar "nenhuma norma
 * aplicável" seria uma afirmação técnica que o sistema não tem base para fazer.
 */
function renderApplicableNrs(nrs?: string[] | null): string {
  if (!nrs || nrs.length === 0) return '';

  const chips = nrs
    .map((nr) => `<span class="chip">${escapeHtml(nr)}</span>`)
    .join('');

  return `
    <section class="ds-card">
      <div class="ds-card-head">
        <div class="ds-card-accent"></div>
        <div class="ds-card-title">Normas regulamentadoras aplicáveis</div>
      </div>
      <div class="section-body">
        <div class="chip-row">${chips}</div>
      </div>
    </section>
  `;
}

/**
 * Resumo de não conformidades.
 *
 * Diferente das demais seções, esta é renderizada MESMO vazia, com um estado
 * explícito. O leitor precisa conseguir distinguir "nenhuma não conformidade
 * encontrada" de "não conformidades não foram avaliadas" — a omissão silenciosa
 * confunde as duas.
 */
function renderNonconformitySummary(
  images: PhotographicReportRenderableImage[],
): string {
  const flagged = images.filter((image) => image.is_nonconformity);

  const body = flagged.length
    ? `<table class="data-table">
         <thead>
           <tr>
             <th style="width:8%">#</th>
             <th style="width:30%">Evidência</th>
             <th>Ação recomendada</th>
             <th style="width:16%">Prazo</th>
             <th style="width:20%">Responsável</th>
           </tr>
         </thead>
         <tbody>
           ${flagged
             .map(
               (image, index) => `
             <tr>
               <td style="text-align:center">${index + 1}</td>
               <td>${escapeHtml(
                 sanitize(image.ai_title) !== '-'
                   ? sanitize(image.ai_title)
                   : sanitize(image.manual_caption),
               )}</td>
               <td>${escapeHtml(sanitize(image.recommended_action))}</td>
               <td>${escapeHtml(formatDate(image.action_deadline) || '—')}</td>
               <td>${escapeHtml(sanitize(image.action_responsible))}</td>
             </tr>
           `,
             )
             .join('')}
         </tbody>
       </table>`
    : `<div class="section-body">
         <div class="ds-label">Nenhuma não conformidade registrada</div>
         <p class="empty-note">
           Nenhuma das evidências deste relatório foi marcada como não
           conformidade pelo responsável pela inspeção.
         </p>
       </div>`;

  return `
    <section class="ds-card">
      <div class="ds-card-head">
        <div class="ds-card-accent ds-card-accent--danger"></div>
        <div class="ds-card-title">Resumo de não conformidades</div>
      </div>
      ${body}
    </section>
  `;
}

/**
 * Manifesto de evidências — adaptado do "Manifesto de evidências" do PDF de APR.
 *
 * A nota de rodapé não é opcional. Um manifesto que exibe hash sem qualificar
 * o que ele prova induz o leitor a concluir que a foto está atrelada à câmera
 * de origem, o que é falso: a imagem é re-encodada no navegador antes do envio.
 * O hash comprova integridade desde o recebimento — afirmação real e útil, mas
 * diferente. Errar essa frase transforma a feature em passivo.
 */
function renderEvidenceManifest(
  images: PhotographicReportRenderableImage[],
): string {
  if (images.length === 0) return '';

  const hasReencoded = images.some(
    (image) =>
      (image.integrity_flags as { client_reencoded?: boolean } | null)
        ?.client_reencoded === true,
  );
  const hasLegacyRows = images.some((image) => !image.hash_sha256);

  const rows = images
    .map(
      (image, index) => `
        <tr>
          <td style="text-align:center">${index + 1}</td>
          <td>${escapeHtml(formatDate(image.activity_date_label) || '—')}</td>
          <td>${escapeHtml(sanitize(image.original_name))}</td>
          <td>${escapeHtml(sanitize(image.mime_type))}</td>
          <td style="text-align:right">${escapeHtml(formatFileSize(image.file_size_bytes))}</td>
          <td>${escapeHtml(
            image.captured_at
              ? formatDateTime(image.captured_at)
              : formatDateTime(image.created_at),
          )}</td>
          <td class="mono">${escapeHtml(
            image.hash_sha256 ? `${image.hash_sha256.slice(0, 16)}…` : '—',
          )}</td>
          <td>${escapeHtml(formatGeo(image))}</td>
        </tr>
      `,
    )
    .join('');

  const notes = [
    hasReencoded
      ? 'O hash SHA-256 refere-se ao arquivo recebido e armazenado pelo SGS. Imagens capturadas por dispositivo móvel são otimizadas no navegador antes do envio; o hash comprova a integridade do arquivo desde o recebimento, não a autoria original da captura.'
      : '',
    hasLegacyRows
      ? 'Evidências enviadas antes da adoção do registro de integridade não possuem hash de origem e aparecem com "—".'
      : '',
    'Coordenadas são arredondadas para aproximadamente 1 km por proteção de privacidade.',
  ].filter(Boolean);

  return `
    <section class="ds-card break-before">
      <div class="ds-card-head">
        <div class="ds-card-accent"></div>
        <div class="ds-card-title">Manifesto de evidências</div>
      </div>
      <table class="data-table manifest-table">
        <thead>
          <tr>
            <th style="width:5%">#</th>
            <th style="width:11%">Data</th>
            <th style="width:20%">Arquivo</th>
            <th style="width:11%">Tipo</th>
            <th style="width:9%">Tamanho</th>
            <th style="width:16%">Captura</th>
            <th style="width:14%">Hash SHA-256</th>
            <th>Geolocalização</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="manifest-notes">
        ${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}
      </div>
    </section>
  `;
}

/**
 * Bloco de assinaturas. Omitido por completo quando não há nenhuma — um
 * quadro vazio de assinaturas num documento técnico sugere pendência, não
 * ausência de requisito.
 */
function renderSignatures(signatures?: RenderableSignature[]): string {
  if (!signatures || signatures.length === 0) return '';

  const cards = signatures
    .map((signature) => {
      const proof = [
        signature.type ? sanitize(signature.type).toUpperCase() : '',
        signature.signedAt ? formatDateTime(signature.signedAt) : '',
      ]
        .filter(Boolean)
        .join(' · ');

      return `
        <div class="sig-card">
          <div class="sig-area">
            ${
              signature.signatureImage
                ? `<img src="${escapeHtml(signature.signatureImage)}" alt="Assinatura de ${escapeHtml(sanitize(signature.signerName))}" />`
                : ''
            }
          </div>
          <div class="sig-rule"></div>
          <div class="sig-name">${escapeHtml(sanitize(signature.signerName))}</div>
          ${
            signature.signerRole
              ? `<div class="sig-role">${escapeHtml(signature.signerRole)}</div>`
              : ''
          }
          ${proof ? `<div class="sig-proof">${escapeHtml(proof)}</div>` : ''}
          ${
            signature.signatureHash
              ? `<div class="sig-hash mono">Prova ${escapeHtml(signature.signatureHash.slice(0, 24))}</div>`
              : ''
          }
        </div>
      `;
    })
    .join('');

  return `
    <section class="ds-card">
      <div class="ds-card-head">
        <div class="ds-card-accent"></div>
        <div class="ds-card-title">Assinaturas</div>
      </div>
      <div class="section-body">
        <div class="sig-grid">${cards}</div>
      </div>
    </section>
  `;
}

/** components/EvidenceGallery.ts — cabeçalho com acento "info". */
function renderGalleryHeading(title: string): string {
  return `
    <div class="gallery-head">
      <div class="gallery-accent"></div>
      <div class="ds-card-title">${escapeHtml(title)}</div>
    </div>
  `;
}

/**
 * components/EvidenceGallery.ts → drawOneEvidence, forma de coluna única:
 * poço de imagem à esquerda (surfaceMuted + borderStrong), texto à direita.
 */
function renderEvidenceCard(
  image: PhotographicReportRenderableImage,
  index: number,
): string {
  const title =
    sanitize(image.ai_title) !== '-'
      ? sanitize(image.ai_title)
      : sanitize(image.manual_caption) !== '-'
        ? sanitize(image.manual_caption)
        : `Foto ${index + 1}`;

  const classification = image.ai_condition_classification;
  const tone = classificationTone(classification);
  const points = (image.ai_positive_points || []).filter(Boolean);
  const recommendations = (image.ai_recommendations || []).filter(Boolean);
  const conditions = (image.photo_conditions || []).filter(Boolean);

  const meta = [
    `Ordem ${image.image_order}`,
    image.activity_date_label
      ? formatDate(image.activity_date_label) || image.activity_date_label
      : 'Data não vinculada',
  ].join(' • ');

  const detail = (label: string, value?: string | null) =>
    value && String(value).trim()
      ? `<div class="ev-detail"><div class="ds-label">${escapeHtml(label)}</div><div class="ev-detail-text">${escapeHtml(value)}</div></div>`
      : '';

  const list = (label: string, items: string[]) =>
    items.length
      ? `<div class="ev-detail"><div class="ds-label">${escapeHtml(label)}</div><ul class="ev-list">${items
          .map((i) => `<li>${escapeHtml(i)}</li>`)
          .join('')}</ul></div>`
      : '';

  return `
    <article class="ev-card">
      <div class="ev-well">
        ${
          image.data_url
            ? `<img src="${escapeHtml(image.data_url)}" alt="Evidência ${index + 1}" />`
            : `<div class="ev-well-empty"><div class="ds-label">SEM FOTO</div><p>Evidência textual preservada no documento.</p></div>`
        }
      </div>
      <div class="ev-body">
        <div class="ev-eyebrow">
          <span class="ds-label">EVIDÊNCIA ${index + 1}</span>
          <span class="ev-badges">
            ${
              image.is_nonconformity
                ? '<span class="badge badge--danger">Não conformidade</span>'
                : ''
            }
            ${
              classification
                ? `<span class="badge badge--${escapeHtml(tone)}">${escapeHtml(classification)}</span>`
                : ''
            }
          </span>
        </div>
        <h3 class="ev-title">${escapeHtml(title)}</h3>
        ${detail('DESCRIÇÃO', image.ai_description)}
        ${
          sanitize(image.manual_caption) !== '-' &&
          image.manual_caption !== title
            ? detail('LEGENDA MANUAL', image.manual_caption)
            : ''
        }
        ${detail('AVALIAÇÃO TÉCNICA', image.ai_technical_assessment)}
        ${list('PONTOS POSITIVOS', points)}
        ${list('RECOMENDAÇÃO PREVENTIVA', recommendations)}
        ${
          conditions.length
            ? `<div class="ev-detail"><div class="ds-label">CONDIÇÕES OBSERVADAS</div><div class="chip-row">${conditions
                .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
                .join('')}</div></div>`
            : ''
        }
        ${
          image.is_nonconformity
            ? `<div class="ev-nc">
                 ${detail('AÇÃO RECOMENDADA', image.recommended_action)}
                 ${
                   image.action_deadline
                     ? detail('PRAZO', formatDate(image.action_deadline))
                     : ''
                 }
                 ${detail('RESPONSÁVEL', image.action_responsible)}
               </div>`
            : ''
        }
        <div class="ev-meta">${escapeHtml(meta)}</div>
      </div>
    </article>
  `;
}

// ── documento ─────────────────────────────────────────────────────────────────

export function buildPhotographicReportHtml(
  report: PhotographicReportResponse,
  options: {
    /**
     * Empresa EMITENTE (o tenant). Antes o renderer recebia `companyName` já
     * preenchido com `report.client_name` — o cliente — e estampava o cliente
     * como emissor do documento técnico.
     */
    companyIdentity: {
      razaoSocial: string | null;
      cnpj: string | null;
    };
    /** Empresa CLIENTE, para quem o serviço foi prestado. */
    clientName: string;
    /**
     * Identificador impresso no documento. Vem de
     * `buildPhotographicReportCode` e é o MESMO valor gravado no Document
     * Registry e no `verification_code` — derivá-lo aqui foi o que fez o PDF
     * ostentar um código que não existia no sistema.
     */
    documentCode: string;
    generatedAt?: string;
    renderableImages?: PhotographicReportRenderableImage[];
    logoDataUrl?: string | null;
    /**
     * QR e URL de validação pública. Ambos nulos quando o portal não está
     * configurado — o bloco de governança colapsa para uma coluna só.
     */
    validation?: { url: string | null; qrDataUri: string | null };
    signatures?: RenderableSignature[];
  },
): string {
  const renderableImages = options.renderableImages || [];
  const groups = groupImagesByDay(report.days || [], renderableImages);
  const totalPhotos = renderableImages.length;
  const totalDays = (report.days || []).length || (totalPhotos > 0 ? 1 : 0);
  const summary = summarizeClassifications(renderableImages);
  const generatedAtLabel = formatDateTime(
    options.generatedAt || new Date().toISOString(),
  );
  const documentCode = options.documentCode;
  const validationUrl = options.validation?.url ?? null;
  const qrDataUri = options.validation?.qrDataUri ?? null;

  /**
   * O hash disponível aqui é o da emissão ANTERIOR — o desta só existe depois
   * do render, porque é o hash do documento que contém este bloco. Imprimi-lo
   * sob um rótulo genérico "Hash do documento" seria ativamente enganoso, então
   * ou se rotula como anterior, ou se omite (primeira emissão).
   */
  const previousHashLabel =
    report.final_pdf_hash_sha256 && report.pdf_generated_at
      ? `<div class="gov-hash">
           <span class="ds-label">Hash da emissão anterior</span>
           <span class="mono">${escapeHtml(report.final_pdf_hash_sha256.slice(0, 32))}…</span>
         </div>`
      : '';

  let seq = 0;
  const photoSections = groups
    .map((group) => {
      const dateLabel = group.day
        ? formatDate(group.day.activity_date)
        : 'sem data vinculada';
      const narrative = renderNarrative(
        group.day
          ? `Registro fotográfico — ${dateLabel}`
          : 'Registro fotográfico — sem data vinculada',
        buildDaySummary(group.day, group.items, report),
      );
      const cards = group.items
        .map((image) => renderEvidenceCard(image, seq++))
        .join('');
      return `
        ${narrative}
        <section class="gallery">
          ${renderGalleryHeading(`Fotos da data ${dateLabel}`)}
          ${cards}
        </section>
      `;
    })
    .join('');

  const style = `
    <style>
      /* Margem 0: a faixa de marca é full-bleed, como o rect(0,0,pageWidth) do
         DocumentHeader. As margens vêm de .sheet (pageMargin = 16mm). */
      @page { size: A4 portrait; margin: 0; }

      :root {
        color-scheme: light;

        /* tokens/visualTokens.ts → baseTone + variants/photographicTheme.ts */
        --page-bg:       #f6f8fb;
        --surface:       #ffffff;
        --surface-muted: #eef3f8;
        --border:        #c4d0e0;
        --border-strong: #8694a6;
        --text-primary:  #111827;
        --text-secondary:#374151;
        --text-muted:    #6b7280;
        --brand:         #18517c;
        --brand-strong:  #0f2036;
        --brand-on:      #ffffff;
        --success:       #1b5e3e;
        --warning:       #b45f14;
        --danger:        #b02a2a;
        --info:          #1865b0;

        /* tokens/visualTokens.ts → spacing */
        --page-margin: 16mm;
        --block-gap:   5mm;
        --section-gap: 9mm;
        --radius:      2.8mm;
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0;
        padding: 0;
        background: var(--page-bg);
        color: var(--text-primary);
        font-family: Helvetica, Arial, sans-serif;
        /* typography.body = 9.2 */
        font-size: 9.2pt;
        line-height: 1.42;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      h1, h2, h3, p, ul { margin: 0; padding: 0; }
      ul { list-style: none; }

      /* ── DocumentHeader: faixa de marca full-bleed ───────────────── */
      .doc-header {
        background: var(--brand);
        border-bottom: 1.4mm solid var(--brand-strong);
        padding: 6mm var(--page-margin) 5mm;
      }
      .doc-header-row {
        display: flex;
        align-items: flex-start;
        gap: 6mm;
      }
      .doc-logo {
        width: 32mm;
        max-height: 20mm;
        flex: 0 0 32mm;
      }
      .doc-logo img {
        max-width: 32mm;
        max-height: 20mm;
        object-fit: contain;
        display: block;
      }
      .doc-headings { flex: 1 1 auto; min-width: 0; }
      .doc-title {
        /* typography.headingLg = 15.2 */
        font-size: 15.2pt;
        font-weight: 700;
        color: var(--brand-on);
        letter-spacing: .02em;
        line-height: 1.15;
      }
      .doc-subtitle {
        /* typography.bodySm = 8.3 */
        font-size: 8.3pt;
        font-weight: 400;
        color: #dfe7ef;
        margin-top: 1.4mm;
        line-height: 1.3;
      }
      .doc-code {
        flex: 0 0 58mm;
        width: 58mm;
        background: var(--surface);
        border: 0.35mm solid var(--border-strong);
        border-radius: var(--radius);
        padding: 1.8mm;
        text-align: center;
      }
      .doc-code-pill {
        background: var(--info);
        border-radius: calc(var(--radius) / 2);
        padding: 0.7mm 0;
        /* typography.caption = 7 */
        font-size: 7pt;
        font-weight: 700;
        color: var(--brand-on);
        letter-spacing: .08em;
      }
      .doc-code-value {
        /* typography.headingSm = 9.5 */
        font-size: 9.5pt;
        font-weight: 700;
        color: var(--text-primary);
        margin-top: 2mm;
        word-break: break-all;
      }
      .doc-code-status {
        font-size: 7pt;
        color: var(--text-primary);
        margin-top: 1.4mm;
      }

      /* Cartões de metadados do cabeçalho (barra de marca à esquerda) */
      .doc-meta {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 2.4mm;
        margin-top: 4mm;
      }
      .doc-meta--4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .doc-meta-card {
        background: var(--surface);
        border: 0.24mm solid var(--border);
        border-left: 2.2mm solid var(--brand);
        border-radius: var(--radius);
        padding: 2mm 3mm 2.4mm;
      }
      .doc-meta-value {
        font-size: 8.3pt;
        font-weight: 700;
        color: var(--text-primary);
        margin-top: 1mm;
        word-break: break-word;
      }
      .doc-meta-sub {
        font-size: 7pt;
        color: var(--text-secondary);
        margin-top: 0.6mm;
      }

      /* ── folha de conteúdo (pageMargin) ──────────────────────────── */
      .sheet { padding: var(--section-gap) var(--page-margin) 12mm; }
      .sheet > * + * { margin-top: var(--section-gap); }

      /* Rótulo padrão: caption 7pt, bold, uppercase, textMuted */
      .ds-label {
        font-size: 7pt;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .07em;
        color: var(--text-muted);
      }

      /* ── DocumentIdentityRail ────────────────────────────────────── */
      .rail {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 3mm;
      }
      .rail-card {
        background: var(--surface);
        border: 0.24mm solid var(--border);
        border-radius: var(--radius);
        padding: 1.6mm 1.6mm 2.6mm;
      }
      .rail-value {
        font-size: 8.3pt;
        font-weight: 700;
        color: var(--text-primary);
        margin-top: 1.2mm;
        padding: 0 1.8mm;
      }
      .rail-card .ds-label { padding: 0 1.8mm; margin-top: 1.6mm; }

      /* Pílula de acento (largura total do cartão) */
      .pill {
        height: 3.2mm;
        border-radius: calc(var(--radius) / 2);
        background: var(--brand);
      }
      .pill--brand   { background: var(--brand); }
      .pill--info    { background: var(--info); }
      .pill--warning { background: var(--warning); }
      .pill--success { background: var(--success); }
      .pill--danger  { background: var(--danger); }
      .pill--default { background: var(--brand); }

      /* ── ExecutiveSummaryStrip ───────────────────────────────────── */
      .exec-strip {
        background: var(--surface-muted);
        border: 0.3mm solid var(--border);
        border-radius: var(--radius);
        padding: 1.6mm 4mm 4mm;
        break-inside: avoid;
      }
      .exec-tab {
        width: 30mm;
        height: 3.1mm;
        background: var(--brand);
        border-radius: calc(var(--radius) / 2);
      }
      .exec-title {
        font-size: 11.6pt;
        font-weight: 700;
        color: var(--text-primary);
        margin-top: 2.2mm;
      }
      .exec-summary {
        font-size: 8.3pt;
        color: var(--text-secondary);
        margin-top: 2mm;
        line-height: 1.5;
      }
      .metric-grid {
        display: grid;
        gap: 3mm;
        margin-top: 3.4mm;
      }
      .metric-grid--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric-grid--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .metric-grid--4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .metric-card {
        background: var(--surface);
        border: 0.22mm solid var(--border);
        border-radius: 1.8mm;
        padding: 1.3mm 1.4mm 2.6mm;
      }
      .metric-card .ds-label { padding: 0 1.2mm; margin-top: 1.6mm; }
      .metric-value {
        font-size: 15.2pt;
        font-weight: 700;
        color: var(--text-primary);
        margin-top: 1mm;
        padding: 0 1.2mm;
      }

      /* ── MetadataGrid / NarrativeSection: cartão padrão ──────────── */
      .ds-card {
        background: var(--surface);
        border: 0.3mm solid var(--border);
        border-radius: var(--radius);
        overflow: hidden;
        break-inside: avoid;
      }
      .ds-card-head {
        position: relative;
        background: var(--surface-muted);
        margin: 1.2mm;
        border-radius: calc(var(--radius) / 1.5);
        padding: 2.2mm 3mm 2.2mm 5mm;
      }
      /* Acento lateral de 2.4mm colado à borda do cartão */
      .ds-card-accent {
        position: absolute;
        left: -1.2mm;
        top: -1.2mm;
        width: 2.4mm;
        height: 10.5mm;
        background: var(--brand);
      }
      .ds-card-title {
        font-size: 11.6pt;
        font-weight: 700;
        color: var(--text-primary);
      }
      .narrative {
        padding: 1.4mm 4mm 4.2mm;
        font-size: 9.2pt;
        color: var(--text-primary);
        line-height: 1.5;
        white-space: pre-wrap;
      }

      /* Grade de metadados: 2 colunas com divisores de 0.2mm */
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        border-top: 0.2mm solid var(--border);
      }
      .meta-cell {
        padding: 3mm 4mm;
        border-bottom: 0.2mm solid var(--border);
      }
      .meta-cell:nth-child(odd) { border-right: 0.2mm solid var(--border); }
      .meta-cell:nth-last-child(1),
      .meta-cell:nth-last-child(2):nth-child(odd) { border-bottom: 0; }
      .meta-value {
        font-size: 9.2pt;
        color: var(--text-primary);
        margin-top: 1.4mm;
        word-break: break-word;
      }

      /* ── EvidenceGallery ────────────────────────────────────────── */
      .gallery > * + * { margin-top: var(--block-gap); }
      .gallery-head {
        position: relative;
        background: var(--surface);
        border: 0.3mm solid var(--border);
        border-radius: 2mm;
        padding: 2.6mm 3mm 2.6mm 6mm;
        overflow: hidden;
      }
      /* Cabeçalho da galeria usa acento "info" */
      .gallery-accent {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 2.5mm;
        background: var(--info);
      }
      .ev-card {
        display: flex;
        gap: 5mm;
        background: var(--surface);
        border: 0.28mm solid var(--border);
        border-radius: 2mm;
        padding: 5mm;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      /* Poço de imagem: surfaceMuted + borderStrong, como o roundedRect "S" */
      .ev-well {
        flex: 0 0 74mm;
        width: 74mm;
        min-height: 66mm;
        background: var(--surface-muted);
        border: 0.18mm solid var(--border-strong);
        border-radius: 1.5mm;
        padding: 2mm;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .ev-well img {
        max-width: 100%;
        max-height: 92mm;
        object-fit: contain;
        display: block;
      }
      .ev-well-empty { text-align: center; }
      .ev-well-empty p {
        font-size: 8.3pt;
        color: var(--text-secondary);
        margin-top: 2mm;
      }
      .ev-body { flex: 1 1 auto; min-width: 0; }
      .ev-eyebrow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 3mm;
      }
      .ev-title {
        font-size: 11.6pt;
        font-weight: 700;
        color: var(--text-primary);
        margin-top: 1.6mm;
        line-height: 1.25;
      }
      .ev-detail { margin-top: 2.6mm; }
      .ev-detail-text {
        font-size: 8.3pt;
        color: var(--text-secondary);
        margin-top: 0.8mm;
        line-height: 1.45;
      }
      .ev-list {
        margin-top: 0.8mm;
        font-size: 8.3pt;
        color: var(--text-secondary);
      }
      .ev-list li {
        padding-left: 3mm;
        position: relative;
        line-height: 1.45;
      }
      .ev-list li::before {
        content: '';
        position: absolute;
        left: 0.4mm;
        top: 1.5mm;
        width: 1mm;
        height: 1mm;
        border-radius: 50%;
        background: var(--border-strong);
      }
      .ev-meta {
        font-size: 7pt;
        color: var(--text-muted);
        margin-top: 3.4mm;
        padding-top: 1.8mm;
        border-top: 0.2mm solid var(--border);
      }

      /* ── StatusBadge ────────────────────────────────────────────── */
      .badge {
        display: inline-block;
        padding: 0.6mm 2mm;
        border-radius: 999px;
        border: 0.22mm solid var(--border);
        font-size: 7pt;
        font-weight: 700;
        white-space: nowrap;
        background: var(--surface-muted);
        color: var(--text-secondary);
      }
      .badge--success { background: #eaf3ee; color: var(--success); border-color: #b9d6c6; }
      .badge--info    { background: #e9f1fb; color: var(--info);    border-color: #b6cfec; }
      .badge--warning { background: #fbf1e6; color: var(--warning); border-color: #e6cbaa; }
      .badge--danger  { background: #f9ecec; color: var(--danger);  border-color: #e3bcbc; }

      .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 1.4mm;
        margin-top: 1.2mm;
      }
      .chip {
        display: inline-block;
        padding: 0.6mm 2mm;
        border-radius: 999px;
        background: var(--surface-muted);
        border: 0.22mm solid var(--border);
        color: var(--text-secondary);
        font-size: 7pt;
        font-weight: 700;
      }

      /* ── TABELAS DE DADOS ───────────────────────────────────────── */
      .data-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 8.3pt;
      }
      .data-table thead th {
        background: var(--surface-muted);
        color: var(--text-secondary);
        font-size: 7pt;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .06em;
        text-align: left;
        padding: 2mm 2.4mm;
        border-bottom: 0.25mm solid var(--border);
      }
      .data-table tbody td {
        padding: 2mm 2.4mm;
        border-bottom: 0.2mm solid var(--border);
        color: var(--text-primary);
        vertical-align: top;
        word-break: break-word;
      }
      .data-table tbody tr:last-child td { border-bottom: 0; }

      /* O manifesto tem 8 colunas: reduzir o corpo evita quebra feia do hash. */
      .manifest-table { font-size: 7pt; }
      .manifest-table .mono { word-break: break-all; }
      .manifest-notes {
        padding: 2.4mm 3mm 3mm;
        border-top: 0.2mm solid var(--border);
      }
      .manifest-notes p {
        font-size: 6.5pt;
        color: var(--text-secondary);
        line-height: 1.4;
      }
      .manifest-notes p + p { margin-top: 1.2mm; }

      .empty-note {
        font-size: 8.3pt;
        color: var(--text-secondary);
        margin-top: 1.4mm;
        line-height: 1.45;
      }

      /* Acento vermelho para o cartão de não conformidades. */
      .ds-card-accent--danger { background: var(--danger); }

      .ev-badges {
        display: flex;
        align-items: center;
        gap: 1.6mm;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      /* Bloco de tratativa da NC, destacado do restante da evidência. */
      .ev-nc {
        margin-top: 2.6mm;
        padding: 2.4mm 3mm;
        border-left: 0.8mm solid var(--danger);
        background: #fbf4f4;
        border-radius: 1.2mm;
      }
      .ev-nc .ev-detail:first-child { margin-top: 0; }

      /* ── governança / rodapé ────────────────────────────────────── */
      .gov {
        background: var(--surface);
        border: 0.3mm solid var(--border);
        border-radius: var(--radius);
        padding: 4mm;
        break-inside: avoid;
      }
      /* Duas colunas quando há QR; colapsa sozinho para uma quando não há —
         por isso é flex com gap, e não uma classe condicional. */
      .gov-main {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 6mm;
      }
      .gov-text { flex: 1 1 auto; min-width: 0; }
      .gov-qr {
        flex: 0 0 28mm;
        text-align: center;
      }
      .gov-qr img {
        width: 28mm;
        height: 28mm;
        display: block;
        border: 0.2mm solid var(--border);
        border-radius: 1.5mm;
        background: #fff;
      }
      .gov-qr-caption {
        font-size: 6.5pt;
        color: var(--text-secondary);
        margin-top: 1.2mm;
        line-height: 1.25;
      }
      /* 6pt para digitação manual quando a câmera não estiver disponível. */
      .gov-qr-url {
        font-size: 6pt;
        color: var(--text-muted);
        margin-top: 0.8mm;
        word-break: break-all;
        line-height: 1.2;
      }
      .gov-hash {
        margin-top: 3mm;
        display: flex;
        flex-direction: column;
        gap: 0.6mm;
      }
      .gov-hash .mono {
        font-size: 7pt;
        color: var(--text-secondary);
        word-break: break-all;
      }
      .mono { font-family: 'Courier New', Courier, monospace; }

      /* ── ASSINATURAS ────────────────────────────────────────────────
         Formato convencional de documento técnico: área de assinatura no
         topo, linha, e identificação abaixo dela. Antes era identidade à
         esquerda e linha à direita, o que deixava um vão morto no meio e
         não lia como campo de assinatura. */
      .sig-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 5mm;
      }
      .sig-card {
        border: 0.24mm solid var(--border);
        border-radius: 1.8mm;
        padding: 3mm 4mm 3.4mm;
        background: var(--surface);
        break-inside: avoid;
        text-align: center;
      }
      /* Altura fixa para que cards com e sem imagem alinhem a linha. */
      .sig-area {
        height: 16mm;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding-bottom: 1mm;
      }
      .sig-area img {
        max-width: 100%;
        max-height: 15mm;
        object-fit: contain;
      }
      .sig-rule {
        border-top: 0.3mm solid var(--border-strong);
        margin-bottom: 2mm;
      }
      .sig-name {
        font-size: 9.2pt;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.25;
      }
      .sig-role {
        font-size: 8.3pt;
        color: var(--text-secondary);
        margin-top: 0.6mm;
        line-height: 1.3;
      }
      .sig-proof {
        font-size: 7pt;
        color: var(--text-muted);
        margin-top: 1.4mm;
        letter-spacing: .04em;
      }
      .sig-hash {
        font-size: 6.5pt;
        color: var(--text-muted);
        margin-top: 0.8mm;
        word-break: break-all;
      }
      .gov-title {
        font-size: 11.6pt;
        font-weight: 700;
        color: var(--text-primary);
      }
      .gov-subtitle {
        font-size: 8.3pt;
        color: var(--text-secondary);
        margin-top: 1.4mm;
        line-height: 1.45;
      }
      .gov-code {
        display: inline-block;
        margin-top: 3mm;
        background: var(--surface-muted);
        border: 0.24mm solid var(--border-strong);
        border-radius: calc(var(--radius) / 1.5);
        padding: 2mm 4mm;
        font-size: 9.5pt;
        font-weight: 700;
        letter-spacing: .1em;
        color: var(--text-primary);
      }
      .doc-footer {
        display: flex;
        justify-content: space-between;
        gap: 6mm;
        border-top: 0.25mm solid var(--border);
        padding-top: 2.4mm;
        font-size: 7pt;
        color: var(--text-secondary);
      }
      .doc-footer strong { font-weight: 700; }
    </style>
  `;

  const railHtml = renderIdentityRail([
    { label: 'Tipo documental', value: 'Relatório Fotográfico' },
    { label: 'Criticidade', value: buildActivityTone(report) },
    { label: 'Validade', value: buildPeriodLabel(report) },
    { label: 'Classe', value: 'Fotográfico' },
  ]);

  const execHtml = renderExecutiveSummary({
    title: 'Leitura executiva',
    summary: buildExecutiveSummary(report, totalPhotos, totalDays || 1),
    metrics: [
      {
        label: 'Fotos',
        value: totalPhotos,
        tone: totalPhotos > 0 ? 'success' : 'warning',
      },
      {
        label: 'Datas',
        value: totalDays,
        tone: totalDays > 0 ? 'info' : 'warning',
      },
      {
        label: 'Muito satisfatória',
        value: summary.muitoSatisfatoria,
        tone: 'success',
      },
      { label: 'Satisfatória', value: summary.satisfatoria, tone: 'info' },
      { label: 'Preventiva', value: summary.preventiva, tone: 'warning' },
      { label: 'Atenção necessária', value: summary.atencao, tone: 'danger' },
      {
        label: 'Não conformidades',
        value: summary.naoConformidades,
        tone: 'danger',
      },
    ],
  });

  const metaHtml = renderMetadataGrid({
    title: 'Dados da obra e atividade',
    fields: [
      { label: 'Cliente', value: report.client_name },
      { label: 'Obra', value: report.project_name },
      { label: 'Unidade', value: report.unit_name || '-' },
      { label: 'Local específico', value: report.location || '-' },
      { label: 'Data inicial', value: formatDate(report.start_date) || '-' },
      { label: 'Data final', value: formatDate(report.end_date) || '-' },
      {
        label: 'Horário',
        value: formatClockRange(report.start_time, report.end_time),
      },
      { label: 'Turno', value: report.shift },
      { label: 'Condição da área', value: report.area_status },
      { label: 'Tipo de atividade', value: report.activity_type },
      { label: 'Responsável', value: report.responsible_name },
      { label: 'Empresa executora', value: report.contractor_company },
      { label: 'Status', value: report.status },
    ],
  });

  const logoHtml = options.logoDataUrl
    ? `<div class="doc-logo"><img src="${escapeHtml(options.logoDataUrl)}" alt="Logo" /></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Relatório Fotográfico — ${escapeHtml(report.project_name)}</title>
    ${style}
  </head>
  <body>

    <header class="doc-header">
      <div class="doc-header-row">
        ${logoHtml}
        <div class="doc-headings">
          <h1 class="doc-title">Relatório Fotográfico</h1>
          <p class="doc-subtitle">
            Registro fotográfico técnico de atividade em campo — SGS, Sistema de Gestão de Segurança
          </p>
        </div>
        <div class="doc-code">
          <div class="doc-code-pill">IDENTIFICADOR</div>
          <div class="doc-code-value">${escapeHtml(documentCode || '-')}</div>
          <div class="doc-code-status">Status: ${escapeHtml(sanitize(report.status))}</div>
        </div>
      </div>

      <div class="doc-meta doc-meta--4">
        <div class="doc-meta-card">
          <div class="ds-label">Empresa emitente</div>
          <div class="doc-meta-value">${escapeHtml(sanitize(options.companyIdentity.razaoSocial))}</div>
          ${
            options.companyIdentity.cnpj
              ? `<div class="doc-meta-sub">CNPJ ${escapeHtml(formatCnpj(options.companyIdentity.cnpj))}</div>`
              : ''
          }
        </div>
        <div class="doc-meta-card">
          <div class="ds-label">Cliente</div>
          <div class="doc-meta-value">${escapeHtml(sanitize(options.clientName))}</div>
        </div>
        <div class="doc-meta-card">
          <div class="ds-label">Obra / Site</div>
          <div class="doc-meta-value">${escapeHtml(sanitize(report.project_name))}</div>
        </div>
        <div class="doc-meta-card">
          <div class="ds-label">Data de referência</div>
          <div class="doc-meta-value">${escapeHtml(formatDate(report.start_date) || '-')}</div>
        </div>
      </div>
    </header>

    <main class="sheet">
      ${railHtml}
      ${execHtml}
      ${metaHtml}
      ${renderTechnicalResponsible(report)}
      ${renderApplicableNrs(report.applicable_nrs)}

      ${renderNarrative('Metodologia de inspeção', report.inspection_methodology)}
      ${renderNarrative('Escopo e limitações', report.scope_and_limitations)}

      ${renderNarrative('Objetivo do relatório', buildReportObjective(report))}
      ${renderNarrative('Descrição geral da atividade', buildGeneralConditions(report))}
      ${renderNarrative('Observações gerais', report.general_observations)}
      ${renderNarrative('Avaliação consolidada', buildConsolidatedAssessment(report, totalPhotos))}
      ${renderNarrative('Parecer técnico', buildTechnicalOpinion(report))}

      ${
        photoSections ||
        renderNarrative(
          'Registro fotográfico',
          'Nenhuma fotografia vinculada ao relatório.',
        )
      }

      ${renderNonconformitySummary(renderableImages)}

      ${renderNarrative('Conclusão final', buildFinalConclusion(report))}

      ${renderEvidenceManifest(renderableImages)}

      ${renderSignatures(options.signatures)}

      <section class="gov">
        <div class="gov-main">
          <div class="gov-text">
            <div class="gov-title">Governança e autenticidade</div>
            <p class="gov-subtitle">
              ${
                validationUrl
                  ? 'Documento emitido pelo SGS e verificável publicamente pelo código abaixo ou pelo QR ao lado.'
                  : 'Documento fotográfico emitido pelo SGS com identificador próprio para conferência interna e rastreabilidade documental.'
              }
            </p>
            <div class="gov-code">${escapeHtml(documentCode || '-')}</div>
            ${previousHashLabel}
          </div>
          ${
            qrDataUri
              ? `<div class="gov-qr">
                   <img src="${escapeHtml(qrDataUri)}" alt="QR Code de validação pública" />
                   <div class="gov-qr-caption">Aponte a câmera para validar</div>
                   ${
                     validationUrl
                       ? `<div class="gov-qr-url">${escapeHtml(validationUrl)}</div>`
                       : ''
                   }
                 </div>`
              : ''
          }
        </div>
      </section>

      <div class="doc-footer">
        <span><strong>SGS — Sistema de Gestão de Segurança</strong><br />Gerado em ${escapeHtml(generatedAtLabel)}</span>
        <span style="text-align:right"><strong>ID: ${escapeHtml(documentCode || '-')}</strong><br />${escapeHtml(sanitize(options.companyIdentity.razaoSocial))}</span>
      </div>
    </main>

  </body>
</html>`;
}
