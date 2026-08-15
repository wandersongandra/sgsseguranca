import { toAprLogResponseDto } from './apr-log-response.dto';

describe('AprLogResponseDto minimization', () => {
  it('remove chaves de storage e texto livre da resposta da timeline', () => {
    const dto = toAprLogResponseDto({
      id: 'log-1',
      apr_id: 'apr-1',
      usuario_id: 'user-1',
      acao: 'APR_EVIDENCIA_ENVIADA',
      metadata: {
        evidenceId: 'evidence-1',
        riskItemId: 'risk-1',
        fileKey: 'documents/company-1/apr-evidences/evidence.jpg',
        originalName: 'foto-com-cpf.jpg',
        motivo: 'texto livre com dado pessoal',
        status: 'Pendente',
        riskItemCount: 2,
      },
      data_hora: new Date('2026-08-13T10:00:00.000Z'),
    });

    expect(dto.metadata).toEqual({ status: 'Pendente', riskItemCount: 2 });
    expect(JSON.stringify(dto)).not.toContain('documents/company-1');
    expect(JSON.stringify(dto)).not.toContain('foto-com-cpf');
    expect(JSON.stringify(dto)).not.toContain('texto livre');
  });
});
