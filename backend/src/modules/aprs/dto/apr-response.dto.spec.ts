import { toAprResponseDto } from './apr-response.dto';

describe('AprResponseDto minimization', () => {
  it('expõe apenas resumo de empresa/usuário/obra, sem PII ou RBAC', () => {
    const dto = toAprResponseDto({
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      elaborador_id: 'user-1',
      participants: [
        {
          id: 'user-1',
          nome: 'Ana',
          email: 'ana@example.test',
          profile: { permissoes: { can_view_apr: true } },
        },
      ],
      company: {
        id: 'company-1',
        razao_social: 'Empresa',
        cnpj: '00.000.000/0001-00',
        email_contato: 'contato@example.test',
      },
      site: {
        id: 'site-1',
        nome: 'Obra A',
        endereco: 'endereço sensível',
      },
      elaborador: {
        id: 'user-1',
        nome: 'Ana',
        email: 'ana@example.test',
        profile: { permissoes: { can_view_apr: true } },
      },
      activities: [],
      risks: [],
      epis: [],
      tools: [],
      machines: [],
      risk_items: [],
      approval_steps: [],
    } as never);

    expect(dto.company).toEqual({ id: 'company-1', razao_social: 'Empresa' });
    expect(dto.site).toEqual({ id: 'site-1', nome: 'Obra A' });
    expect(dto.elaborador).toEqual({ id: 'user-1', nome: 'Ana' });
    expect(dto.participants).toEqual([{ id: 'user-1', nome: 'Ana' }]);
    expect(JSON.stringify(dto)).not.toContain('email');
    expect(JSON.stringify(dto)).not.toContain('permissoes');
    expect(JSON.stringify(dto)).not.toContain('cnpj');
  });

  it('não expõe caminho interno do PDF na resposta principal', () => {
    const dto = toAprResponseDto({
      id: 'apr-2',
      pdf_file_key: 'documents/company-1/aprs/apr-2/final.pdf',
      pdf_folder_path: 'documents/company-1/aprs/apr-2',
    } as never);

    expect(dto).toHaveProperty('has_final_pdf', true);
    expect(dto).not.toHaveProperty('pdf_file_key');
    expect(dto).not.toHaveProperty('pdf_folder_path');
  });
});
