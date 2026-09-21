import {
  confinadoQuestions,
  eletricoQuestions,
  escavacaoQuestions,
  initialChecklists,
  ptSchema,
  recomendacoesQuestions,
} from './pt-schema-and-data';

describe('pt checklist definitions', () => {
  it('keeps the general recommendations operational and explicit', () => {
    expect(recomendacoesQuestions.map((item) => item.id)).toEqual([
      'direito_recusa_risco_grave',
      'alteracao_invalida_pt',
      'pt_documentos_disponiveis',
      'somente_pessoas_autorizadas',
    ]);
  });

  it('includes critical electrical, confined-space and excavation checks aligned with the latest review', () => {
    expect(eletricoQuestions.some((item) => item.id === 'profissionais_autorizados_nr10')).toBe(true);
    expect(confinadoQuestions.some((item) => item.id === 'entrada_sinalizada_controlada')).toBe(true);
    expect(escavacaoQuestions.some((item) => item.id === 'responsavel_tecnico_escavacao')).toBe(true);
    expect(
      escavacaoQuestions.find((item) => item.id === 'escoramento_nr18')?.pergunta,
    ).toContain('1,25m');
  });
});

describe('ptSchema — campos normativos NR-33/NR-35', () => {
  const buildValidBase = () => ({
    numero: 'PT-001',
    titulo: 'Atividade de manutenção',
    descricao: '',
    status: 'Pendente' as const,
    data_hora_inicio: '2026-06-16T08:00',
    data_hora_fim: '2026-06-16T18:00',
    company_id: 'company-1',
    site_id: 'site-1',
    apr_id: '',
    responsavel_id: 'user-1',
    trabalho_altura: false,
    espaco_confinado: false,
    trabalho_quente: false,
    eletricidade: false,
    escavacao: false,
    ...initialChecklists,
    analise_risco_rapida_checklist:
      initialChecklists.analise_risco_rapida_checklist.map((item) => ({
        ...item,
        resposta: 'Sim' as const,
      })),
    recomendacoes_gerais_checklist:
      initialChecklists.recomendacoes_gerais_checklist.map((item) => ({
        ...item,
        resposta: 'Ciente' as const,
      })),
    executantes: ['user-1'],
    analise_risco_rapida_observacoes: '',
  });

  it('aceita PT sem espaço confinado mesmo sem campos de emergência', () => {
    const result = ptSchema.safeParse(buildValidBase());
    expect(result.success).toBe(true);
  });

  it('exige contato de emergência, plano de resgate e vigia quando espaço confinado', () => {
    const result = ptSchema.safeParse({
      ...buildValidBase(),
      espaco_confinado: true,
      trabalho_espaco_confinado_checklist:
        initialChecklists.trabalho_espaco_confinado_checklist.map((item) => ({
          ...item,
          resposta: 'Sim' as const,
        })),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('contato_emergencia');
      expect(paths).toContain('plano_resgate');
      expect(paths).toContain('vigia_nome');
    }
  });

  it('aceita espaço confinado com emergência preenchida e vigia por nome livre', () => {
    const result = ptSchema.safeParse({
      ...buildValidBase(),
      espaco_confinado: true,
      trabalho_espaco_confinado_checklist:
        initialChecklists.trabalho_espaco_confinado_checklist.map((item) => ({
          ...item,
          resposta: 'Sim' as const,
        })),
      contato_emergencia: 'Brigada (11) 99999-0000',
      plano_resgate: 'Equipe própria com tripé e guincho.',
      vigia_nome: 'Pedro Lima',
    });
    expect(result.success).toBe(true);
  });

  it('valida ranges das medições atmosféricas (O2 acima de 25% falha; 20.9 passa)', () => {
    const base = buildValidBase();
    const reading = {
      id: 'm1',
      hora: '08:30',
      oxigenio: 20.9,
      inflamaveis_lel: 0,
      co: 2,
      h2s: 0,
      instrumento: 'MX6',
      responsavel: 'Fabio',
    };

    expect(
      ptSchema.safeParse({ ...base, medicoes_atmosfericas: [reading] }).success,
    ).toBe(true);

    const invalid = ptSchema.safeParse({
      ...base,
      medicoes_atmosfericas: [{ ...reading, oxigenio: 26 }],
    });
    expect(invalid.success).toBe(false);

    const invalidHora = ptSchema.safeParse({
      ...base,
      medicoes_atmosfericas: [{ ...reading, hora: '25:00' }],
    });
    expect(invalidHora.success).toBe(false);
  });

  it('limita textos e a quantidade de executantes antes do envio', () => {
    const base = buildValidBase();
    const invalid = ptSchema.safeParse({
      ...base,
      numero: 'x'.repeat(81),
      titulo: 'x'.repeat(201),
      descricao: 'x'.repeat(5001),
      executantes: Array.from({ length: 201 }, (_, index) => `user-${index}`),
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      const paths = invalid.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(
        expect.arrayContaining(['numero', 'titulo', 'descricao', 'executantes']),
      );
    }
  });
});
