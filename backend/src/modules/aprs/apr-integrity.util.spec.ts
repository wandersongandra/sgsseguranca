import {
  type AprSignableInput,
  buildAprSignableContentV1,
  hashAprSignableContentV1,
} from './apr-integrity.util';
import { AprStatus } from './entities/apr.entity';

function aprFixture(): AprSignableInput {
  return {
    id: 'apr-1',
    company_id: 'company-1',
    site_id: 'site-1',
    elaborador_id: 'user-1',
    auditado_por_id: null,
    numero: 'APR-001',
    titulo: 'Título',
    descricao: 'Descrição',
    tipo_atividade: 'altura',
    frente_trabalho: null,
    area_risco: null,
    turno: 'dia',
    local_execucao_detalhado: 'Obra A',
    responsavel_tecnico_nome: 'Ana',
    responsavel_tecnico_registro: 'MTE-1',
    data_inicio: new Date('2026-01-01T00:00:00Z'),
    data_fim: new Date('2026-01-02T00:00:00Z'),
    status: AprStatus.PENDENTE,
    is_modelo: false,
    is_modelo_padrao: false,
    probability: 2,
    severity: 3,
    exposure: 1,
    initial_risk: 6,
    residual_risk: 'MEDIUM',
    evidence_photo: null,
    evidence_document: null,
    control_description: 'Controle',
    control_evidence: true,
    versao: 1,
    parent_apr_id: null,
    data_auditoria: null,
    resultado_auditoria: null,
    notas_auditoria: null,
    company: { id: 'company-1', nome: 'Empresa' },
    site: { id: 'site-1', nome: 'Obra' },
    elaborador: { id: 'user-1', nome: 'Ana', funcao: 'TST' },
    activities: [],
    risks: [],
    epis: [],
    tools: [],
    machines: [],
    participants: [],
    risk_items: [
      {
        id: 'risk-1',
        ordem: 0,
        atividade: 'Montagem',
        probabilidade: 2,
        severidade: 3,
        medidas_prevencao: 'Isolar',
        prazo: new Date('2026-01-03T00:00:00Z'),
      },
    ],
    evidences: [],
  } as unknown as AprSignableInput;
}

describe('APR signable content V1', () => {
  it('produz o mesmo hash para a mesma semântica independentemente da ordem de relações', () => {
    const first = aprFixture();
    const second: AprSignableInput = {
      ...aprFixture(),
      activities: [
        { id: 'b', nome: 'B' },
        { id: 'a', nome: 'A' },
      ],
    };
    const third: AprSignableInput = {
      ...aprFixture(),
      activities: [
        { id: 'a', nome: 'A' },
        { id: 'b', nome: 'B' },
      ],
    };
    expect(hashAprSignableContentV1(second)).toBe(
      hashAprSignableContentV1(third),
    );
    expect(buildAprSignableContentV1(first)).toEqual(
      buildAprSignableContentV1(first),
    );
  });

  it.each([
    ['titulo', { titulo: 'Título alterado' }],
    [
      'risco',
      { risk_items: [{ id: 'risk-1', ordem: 0, atividade: 'Outro risco' }] },
    ],
    ['controle', { control_description: 'Controle alterado' }],
    ['versão', { versao: 2 }],
  ])('altera o hash quando muda %s', (_label, change) => {
    expect(
      hashAprSignableContentV1({
        ...aprFixture(),
        ...change,
      }),
    ).not.toBe(hashAprSignableContentV1(aprFixture()));
  });

  it('normaliza Unicode e não inclui metadados de storage/permissões', () => {
    const content = buildAprSignableContentV1({
      ...aprFixture(),
      titulo: 'Cafe\u0301',
      elaborador: {
        id: 'user-1',
        nome: 'Ana',
        funcao: 'TST',
        email: 'ana@example.test',
        profile: { permissoes: { admin: true } },
      },
      pdf_file_key: 'internal/key.pdf',
      updated_at: new Date(),
    } as unknown as AprSignableInput);
    expect(JSON.stringify(content)).toContain('Café');
    expect(JSON.stringify(content)).not.toContain('email');
    expect(JSON.stringify(content)).not.toContain('pdf_file_key');
    expect(JSON.stringify(content)).not.toContain('permissoes');
  });
});
