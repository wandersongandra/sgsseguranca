import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import ChecklistSection from './ChecklistSection';
import type { PtFormData } from './pt-schema-and-data';

const getChecklistItemAttachmentAccess = jest.fn();

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    getChecklistItemAttachmentAccess: (...args: unknown[]) =>
      getChecklistItemAttachmentAccess(...args),
  },
}));

function renderChecklistSection(withAttachment = false) {
  const Wrapper = () => {
    const methods = useForm<PtFormData>({
      defaultValues: {
        numero: 'PT-1',
        titulo: 'Checklist legado',
        descricao: '',
        data_hora_inicio: '',
        data_hora_fim: '',
        status: 'Pendente',
        company_id: 'company-1',
        site_id: 'site-1',
        apr_id: '',
        responsavel_id: 'user-1',
        trabalho_altura: true,
        espaco_confinado: false,
        trabalho_quente: false,
        eletricidade: false,
        escavacao: false,
        analise_risco_rapida_checklist: [],
        analise_risco_rapida_observacoes: '',
        recomendacoes_gerais_checklist: [],
        trabalho_altura_checklist: [
          {
            id: 'legacy_unknown_question',
            pergunta: 'Pergunta legada preservada',
            resposta: 'Sim',
            justificativa: '',
            anexo_nome: '',
            anexo_ref: withAttachment ? 'attachment-ref' : '',
          },
        ],
        trabalho_eletrico_checklist: [],
        trabalho_quente_checklist: [],
        trabalho_espaco_confinado_checklist: [],
        trabalho_escavacao_checklist: [],
        executantes: ['user-1'],
        auditado_por_id: '',
        data_auditoria: '',
        resultado_auditoria: '',
        notas_auditoria: '',
      },
    });

    return (
      <FormProvider {...methods}>
        <ChecklistSection
          name="trabalho_altura_checklist"
          title="Altura"
          description="Teste"
          questions={[]}
          baseResponses={['Sim', 'Não', 'Não aplicável']}
          showJustificationOn={['Não', 'Não aplicável']}
          ptId={withAttachment ? 'pt-1' : undefined}
        />
      </FormProvider>
    );
  };

  return render(<Wrapper />);
}

describe('ChecklistSection', () => {
  it('keeps rendering legacy question text when the catalog changes', () => {
    renderChecklistSection();

    expect(screen.getByText('Pergunta legada preservada')).toBeInTheDocument();
  });

  it('bloqueia URL de anexo com esquema inseguro', async () => {
    getChecklistItemAttachmentAccess.mockResolvedValue({
      url: 'javascript:alert(document.cookie)',
    });
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(null);

    renderChecklistSection(true);
    fireEvent.click(screen.getByRole('button', { name: 'Ver anexo' }));

    await waitFor(() =>
      expect(getChecklistItemAttachmentAccess).toHaveBeenCalledWith(
        'pt-1',
        'trabalho_altura_checklist',
        0,
      ),
    );
    expect(openSpy).not.toHaveBeenCalled();
  });
});
