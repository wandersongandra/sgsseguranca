import { act, render, screen, waitFor } from '@testing-library/react';
import { PtEvidencePhotosSection } from './PtEvidencePhotosSection';

const mockGetEvidencePhotoAccess = jest.fn();
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    getEvidencePhotoAccess: (...args: unknown[]) =>
      mockGetEvidencePhotoAccess(...args),
    attachEvidencePhoto: jest.fn(),
    removeEvidencePhoto: jest.fn(),
  },
  PT_EVIDENCE_FASE_LABELS: {
    antes: 'Antes',
    durante: 'Durante',
    depois: 'Depois',
  },
}));

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('PtEvidencePhotosSection', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.sgsseguranca.com.br';
    mockGetEvidencePhotoAccess.mockReset();
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
  });

  it('ignora thumbnail de uma lista anterior quando a PT é atualizada', async () => {
    const oldAccess = deferred<{ url: string | null }>();
    const newAccess = deferred<{ url: string | null }>();
    mockGetEvidencePhotoAccess
      .mockReturnValueOnce(oldAccess.promise)
      .mockReturnValueOnce(newAccess.promise);

    const oldPhoto = { ref: 'photo-old', fase: 'antes' };
    const newPhoto = { ref: 'photo-new', fase: 'durante' };
    const { rerender } = render(
      <PtEvidencePhotosSection
        ptId="pt-1"
        ptStatus="Pendente"
        photos={[oldPhoto] as never}
        canUploadPhotos
        onPhotosChanged={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockGetEvidencePhotoAccess).toHaveBeenCalledTimes(1));

    rerender(
      <PtEvidencePhotosSection
        ptId="pt-1"
        ptStatus="Pendente"
        photos={[newPhoto] as never}
        canUploadPhotos
        onPhotosChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetEvidencePhotoAccess).toHaveBeenCalledTimes(2));

    await act(async () => {
      newAccess.resolve({ url: 'https://api.sgsseguranca.com.br/storage/new.jpg' });
      await newAccess.promise;
      oldAccess.resolve({ url: 'https://api.sgsseguranca.com.br/storage/old.jpg' });
      await oldAccess.promise;
    });

    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute(
        'src',
        'https://api.sgsseguranca.com.br/storage/new.jpg',
      ),
    );
  });

  it('não renderiza thumbnail com esquema de URL inseguro', async () => {
    mockGetEvidencePhotoAccess.mockResolvedValue({ url: 'javascript:alert(1)' });

    render(
      <PtEvidencePhotosSection
        ptId="pt-1"
        ptStatus="Pendente"
        photos={[{ ref: 'photo-unsafe', fase: 'antes' }] as never}
        canUploadPhotos
        onPhotosChanged={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockGetEvidencePhotoAccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Pré-visualização indisponível')).toBeInTheDocument();
  });
});
