import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import AtmosphericReadingsSection from './AtmosphericReadingsSection';
import type { PtFormData } from './pt-schema-and-data';

const appendAtmosphericReading = jest.fn();

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    appendAtmosphericReading: (...args: unknown[]) => appendAtmosphericReading(...args),
  },
}));

function renderDesktopReadings() {
  const Wrapper = () => {
    const methods = useForm<PtFormData>({
      defaultValues: {
        medicoes_atmosfericas: [
          {
            id: 'reading-1',
            hora: '08:30',
            oxigenio: 20.9,
            inflamaveis_lel: 0,
            co: 0,
            h2s: 0,
            instrumento: 'Detector XYZ',
            responsavel: 'Técnico',
          },
        ],
      },
    });

    return (
      <FormProvider {...methods}>
        <AtmosphericReadingsSection
          readOnly={false}
          canAppendReadings={false}
        />
      </FormProvider>
    );
  };

  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: query === '(min-width: 768px)',
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));

  return render(<Wrapper />);
}

describe('AtmosphericReadingsSection', () => {
  beforeEach(() => {
    appendAtmosphericReading.mockReset();
  });

  it('associa os cabeçalhos da tabela aos campos de medição no desktop', () => {
    renderDesktopReadings();

    expect(screen.getByRole('textbox', { name: 'Hora' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'O2 (%)' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Instrumento' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Responsável' })).toBeInTheDocument();
  });

  it('ignora um segundo registro enquanto o primeiro ainda está pendente', async () => {
    let resolveRequest!: () => void;
    appendAtmosphericReading.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const Wrapper = () => {
      const methods = useForm<PtFormData>();
      return (
        <FormProvider {...methods}>
          <AtmosphericReadingsSection
            ptId="pt-1"
            readOnly
            canAppendReadings
          />
        </FormProvider>
      );
    };

    render(<Wrapper />);
    fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '08:30' } });
    fireEvent.change(screen.getByLabelText('O2 (%)'), { target: { value: '20.9' } });
    fireEvent.change(screen.getByLabelText('LEL (%)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('CO (ppm)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('H2S (ppm)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Instrumento'), { target: { value: 'Detector' } });
    fireEvent.change(screen.getByLabelText('Responsável'), { target: { value: 'Técnico' } });

    const submit = screen.getByRole('button', { name: 'Registrar medição' });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(appendAtmosphericReading).toHaveBeenCalledTimes(1));
    resolveRequest();
  });
});
