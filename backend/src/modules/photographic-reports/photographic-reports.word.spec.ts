import JSZip from 'jszip';
import {
  PhotographicReportAreaStatus,
  PhotographicReportShift,
  PhotographicReportStatus,
  PhotographicReportTone,
} from './entities/photographic-report.entity';
import { PhotographicReportExportType } from './entities/photographic-report-export.entity';
import type {
  PhotographicReportResponse,
  PhotographicReportDayResponse,
  PhotographicReportImageResponse,
} from './photographic-reports.types';
import { buildPhotographicReportWordBuffer } from './photographic-reports.word';

function buildSampleReport(): PhotographicReportResponse {
  const day: PhotographicReportDayResponse = {
    id: 'day-1',
    report_id: 'report-1',
    activity_date: '2026-05-15',
    day_summary:
      'Serviço executado com organização operacional e controle da frente.',
    created_at: '2026-05-15T10:00:00.000Z',
    updated_at: '2026-05-15T10:05:00.000Z',
    image_count: 1,
  };

  const image: PhotographicReportImageResponse = {
    id: 'image-1',
    report_id: 'report-1',
    report_day_id: day.id,
    image_url: 'https://storage.example/report-1/image-1.png',
    download_url: null,
    image_order: 1,
    manual_caption: 'Frente de serviço organizada',
    ai_title: 'Organização da área de trabalho',
    ai_description:
      'Área com boa organização e controle visual das atividades.',
    ai_positive_points: ['Frente limpa', 'Materiais organizados'],
    ai_technical_assessment:
      'Condição técnica satisfatória para execução da atividade.',
    ai_condition_classification: 'Muito satisfatória',
    ai_recommendations: ['Manter a organização atual'],
    photo_conditions: [
      'EPIs em uso pelos trabalhadores',
      'Área devidamente sinalizada',
    ],

    is_nonconformity: false,
    recommended_action: null,
    action_deadline: null,
    action_responsible: null,

    original_name: 'frente-de-servico.jpg',
    mime_type: 'image/jpeg',
    file_size_bytes: 248_113,
    hash_sha256:
      'a3f1c9d24b7e8051f6c2a90d3e5b71482c6d0f9a1b3e5c7d9f0a2b4c6d8e0f12',
    captured_at: '2026-05-15T10:08:00.000Z',
    latitude: -23.56,
    longitude: -46.64,
    accuracy_m: 12.5,
    exif_datetime: null,
    integrity_flags: {
      gps: true,
      accuracy: true,
      device: false,
      ip: true,
      exif: false,
      client_reencoded: true,
    },

    created_at: '2026-05-15T10:10:00.000Z',
    updated_at: '2026-05-15T10:12:00.000Z',
    day,
  };

  return {
    id: 'report-1',
    company_id: 'company-1',
    client_id: 'client-1',
    project_id: 'project-1',
    client_name: 'Cliente Exemplo',
    project_name: 'Obra Exemplo',
    unit_name: 'Unidade Central',
    location: 'Corredor principal',
    activity_type: 'Organização de frente de serviço',
    report_tone: PhotographicReportTone.POSITIVO,
    area_status: PhotographicReportAreaStatus.LOJA_FECHADA,
    shift: PhotographicReportShift.NOTURNO,
    start_date: '2026-05-15',
    end_date: null,
    start_time: '20:00:00',
    end_time: '22:00:00',
    responsible_name: 'Responsável Técnico',
    responsible_registration_type: 'CREA',
    responsible_registration_number: '123456',
    responsible_registration_state: 'SP',
    art_number: 'ART-2026-000123',
    contractor_company: 'Empresa Executora LTDA',
    applicable_nrs: ['NR-06', 'NR-12', 'NR-35'],
    inspection_methodology:
      'Inspeção visual da frente de serviço com registro fotográfico sequencial.',
    scope_and_limitations:
      'Escopo limitado às áreas acessíveis no turno; não contempla ensaios instrumentais.',
    general_observations: 'Observações gerais do relatório.',
    ai_summary: 'Resumo consolidado do serviço fotográfico.',
    final_conclusion: 'Conclusão final aprovada.',
    status: PhotographicReportStatus.ANALISADO,
    created_by: 'user-1',
    created_at: '2026-05-15T10:00:00.000Z',
    updated_at: '2026-05-15T10:30:00.000Z',
    day_count: 1,
    image_count: 1,
    export_count: 1,
    last_exported_at: '2026-05-15T10:40:00.000Z',
    verification_code: 'RFP-2026-REPORT01',
    final_pdf_hash_sha256:
      'b7e2d4f60a1c8395e2f4a6b8c0d2e4f60819a3b5c7d9e1f30527496a8b0c2d4e',
    pdf_generated_at: '2026-05-15T10:40:00.000Z',
    days: [day],
    images: [image],
    exports: [
      {
        id: 'export-1',
        report_id: 'report-1',
        export_type: PhotographicReportExportType.WORD,
        file_url:
          'documents/company-1/photographic-report/report-1/export.docx',
        download_url: null,
        generated_by: 'user-1',
        generated_at: '2026-05-15T10:40:00.000Z',
      },
    ],
  };
}

describe('buildPhotographicReportWordBuffer', () => {
  it('gera um pacote docx válido com conteúdo e mídia embutida', async () => {
    const report = buildSampleReport();
    const image = report.images[0];
    if (!image) {
      throw new Error('Imagem de teste ausente.');
    }
    const buffer = await buildPhotographicReportWordBuffer(report, {
      companyIdentity: {
        razaoSocial: 'SGS Segurança LTDA',
        cnpj: '12345678000190',
      },
      clientName: 'Cliente Exemplo',
      documentCode: 'RFP-2026-REPORT01',
      generatedAt: '2026-05-15T10:45:00.000Z',
      renderableImages: [
        {
          ...image,
          data_url:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6Z0M8AAAAASUVORK5CYII=',
          activity_date_label: '15/05/2026',
        },
      ],
    });

    const zip = await JSZip.loadAsync(buffer);
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    const documentXml = await zip.file('word/document.xml')!.async('string');
    const relationshipsXml = await zip
      .file('word/_rels/document.xml.rels')!
      .async('string');

    expect(contentTypes).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    );
    expect(documentXml).toContain('RELATÓRIO FOTOGRÁFICO');
    expect(documentXml).toContain('Registro Fotográfico 01');
    expect(documentXml).toContain('Organização da área de trabalho');
    expect(relationshipsXml).toContain('media/image1.png');
    expect(zip.file('word/media/image1.png')).not.toBeNull();
  });

  it('emite as seções de SST, o manifesto e a identidade correta da empresa', async () => {
    const report = buildSampleReport();
    const image = report.images[0];
    if (!image) {
      throw new Error('Imagem de teste ausente.');
    }

    const buffer = await buildPhotographicReportWordBuffer(report, {
      companyIdentity: {
        razaoSocial: 'SGS Segurança LTDA',
        cnpj: '12345678000190',
      },
      clientName: 'Cliente Exemplo',
      documentCode: 'RFP-2026-REPORT01',
      generatedAt: '2026-05-15T10:45:00.000Z',
      renderableImages: [
        {
          ...image,
          data_url: null,
          activity_date_label: '2026-05-15',
        },
      ],
    });

    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('string');

    // A empresa EMITENTE é o tenant, não o cliente — era exatamente o bug.
    expect(documentXml).toContain('SGS Segurança LTDA');
    expect(documentXml).toContain('RFP-2026-REPORT01');

    // Credencial técnica e escopo normativo.
    expect(documentXml).toContain('Responsável técnico');
    expect(documentXml).toContain('CREA-SP 123456');
    expect(documentXml).toContain('ART-2026-000123');
    expect(documentXml).toContain('Normas regulamentadoras aplicáveis');
    expect(documentXml).toContain('NR-06 · NR-12 · NR-35');
    expect(documentXml).toContain('Metodologia de inspeção');
    expect(documentXml).toContain('Escopo e limitações');

    // Resumo de NC aparece mesmo sem nenhuma, com estado explícito: o leitor
    // precisa distinguir "nenhuma encontrada" de "não avaliado".
    expect(documentXml).toContain('Resumo de não conformidades');
    expect(documentXml).toContain(
      'Nenhuma das evidências deste relatório foi marcada como não conformidade',
    );

    // Manifesto e a ressalva sobre o que o hash prova.
    expect(documentXml).toContain('Manifesto de evidências');
    expect(documentXml).toContain('não a autoria original da captura');
    expect(documentXml).toContain('arredondadas para aproximadamente 1 km');

    expect(documentXml).toContain('Validação pública');
  });

  it('numera as seções sem furos ao inserir blocos condicionais', async () => {
    const report = buildSampleReport();
    // Sem NRs, metodologia nem escopo: três seções condicionais somem e a
    // numeração precisa continuar contígua.
    report.applicable_nrs = null;
    report.inspection_methodology = null;
    report.scope_and_limitations = null;

    const buffer = await buildPhotographicReportWordBuffer(report, {
      companyIdentity: { razaoSocial: 'SGS', cnpj: null },
      clientName: 'Cliente',
      documentCode: 'RFP-2026-REPORT01',
      renderableImages: [],
    });

    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('string');

    const numbers = [...documentXml.matchAll(/>(\d+)\.\s[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));

    expect(numbers.length).toBeGreaterThan(0);
    // Começa em 2 (a capa não é numerada) e cresce de um em um.
    expect(numbers[0]).toBe(2);
    numbers.forEach((value, index) => {
      expect(value).toBe(index + 2);
    });
  });
});
