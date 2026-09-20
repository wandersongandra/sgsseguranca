import { render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { initialChecklists, type PtFormData } from './pt-schema-and-data';
import { RapidRiskAnalysisSection } from './RapidRiskAnalysisSection';

function TestForm() {
  const methods = useForm<PtFormData>({ defaultValues: initialChecklists });
  return (
    <FormProvider {...methods}>
      <RapidRiskAnalysisSection />
    </FormProvider>
  );
}

describe('RapidRiskAnalysisSection', () => {
  it('nomeia grupos de radios e associa o campo de observações', () => {
    render(<TestForm />);

    const firstQuestion = initialChecklists.analise_risco_rapida_checklist[0]?.pergunta;
    expect(firstQuestion).toBeDefined();
    expect(screen.getByRole('group', { name: firstQuestion })).toBeInTheDocument();
    expect(screen.getByLabelText('Observações e evidências')).toBeInTheDocument();
  });
});
