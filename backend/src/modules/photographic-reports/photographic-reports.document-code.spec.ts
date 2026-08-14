import { buildPhotographicReportCode } from './photographic-reports.document-code';

describe('buildPhotographicReportCode', () => {
  const id = 'c283fe18-cdbd-4413-8247-e5e8bd064405';

  it('usa o formato RFP-<ano>-<8 caracteres do id em maiúsculas>', () => {
    expect(buildPhotographicReportCode({ id, start_date: '2026-08-08' })).toBe(
      'RFP-2026-C283FE18',
    );
  });

  it('cabe no varchar(24) da coluna verification_code', () => {
    const code = buildPhotographicReportCode({ id, start_date: '2026-08-08' });
    expect(code.length).toBeLessThanOrEqual(24);
  });

  it('é determinístico — a mesma entrada sempre produz o mesmo código', () => {
    const first = buildPhotographicReportCode({ id, start_date: '2026-08-08' });
    const second = buildPhotographicReportCode({
      id,
      start_date: '2026-08-08',
    });
    expect(first).toBe(second);
  });

  it('toma o ano da data de início, não da data corrente', () => {
    expect(buildPhotographicReportCode({ id, start_date: '2019-03-02' })).toBe(
      'RFP-2019-C283FE18',
    );
  });

  it('ignora hífens do UUID ao montar o sufixo', () => {
    // Um id cujo 8º caractere cairia sobre um hífen se não fossem removidos.
    expect(
      buildPhotographicReportCode({
        id: 'abc-def-1234567890',
        start_date: '2026-01-01',
      }),
    ).toBe('RFP-2026-ABCDEF12');
  });

  it('cai no ano corrente quando a data está ausente ou é inválida', () => {
    const currentYear = new Date().getFullYear().toString();
    expect(buildPhotographicReportCode({ id })).toBe(
      `RFP-${currentYear}-C283FE18`,
    );
    expect(buildPhotographicReportCode({ id, start_date: null })).toBe(
      `RFP-${currentYear}-C283FE18`,
    );
    expect(buildPhotographicReportCode({ id, start_date: 'nao-e-data' })).toBe(
      `RFP-${currentYear}-C283FE18`,
    );
  });

  it('não lança para data inválida — a emissão não pode falhar pelo identificador', () => {
    expect(() =>
      buildPhotographicReportCode({ id, start_date: '31/02/2026' }),
    ).not.toThrow();
  });

  it('produz códigos distintos para relatórios distintos no mesmo ano', () => {
    const a = buildPhotographicReportCode({ id, start_date: '2026-08-08' });
    const b = buildPhotographicReportCode({
      id: '99887766-5544-3322-1100-aabbccddeeff',
      start_date: '2026-08-08',
    });
    expect(a).not.toBe(b);
  });
});
