import { openPdfForPrint, openUrlInNewTab, resolveSafeBrowserUrl } from './print-utils';

describe('resolveSafeBrowserUrl', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.sgsseguranca.com.br';
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it('aceita URLs https e blob para documentos', () => {
    expect(
      resolveSafeBrowserUrl('https://bucket.r2.cloudflarestorage.com/document.pdf'),
    ).toBe('https://bucket.r2.cloudflarestorage.com/document.pdf');
    expect(
      resolveSafeBrowserUrl(
        'https://s3.us-east-005.backblazeb2.com/Sgs-Seguranca/document.pdf',
      ),
    ).toBe(
      'https://s3.us-east-005.backblazeb2.com/Sgs-Seguranca/document.pdf',
    );
    expect(resolveSafeBrowserUrl('blob:https://app.sgsseguranca.com.br/123')).toBe(
      'blob:https://app.sgsseguranca.com.br/123',
    );
  });

  it('rejeita protocolos inseguros para abertura de documentos', () => {
    expect(() => resolveSafeBrowserUrl('javascript:alert(1)')).toThrow(
      /URL bloqueada/i,
    );
    expect(() => resolveSafeBrowserUrl('data:text/html,evil')).toThrow(
      /URL bloqueada/i,
    );
  });
});

describe('openPdfForPrint', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('não substitui a tela atual quando o pop-up é bloqueado', () => {
    const onPopupBlocked = jest.fn();
    jest.spyOn(window, 'open').mockReturnValue(null);

    expect(
      openPdfForPrint(
        'https://bucket.r2.cloudflarestorage.com/document.pdf',
        onPopupBlocked,
      ),
    ).toBe(false);
    expect(onPopupBlocked).toHaveBeenCalledTimes(1);
  });

  it('navega uma janela preparada sem depender de novo pop-up após chamada assíncrona', () => {
    const openSpy = jest.spyOn(window, 'open');
    const fakeWindow = {
      opener: {},
      location: { href: '' },
      focus: jest.fn(),
      print: jest.fn(),
      addEventListener: jest.fn(),
    } as unknown as Window & { location: { href: string } };

    expect(
      openPdfForPrint(
        'https://bucket.r2.cloudflarestorage.com/document.pdf',
        undefined,
        fakeWindow,
      ),
    ).toBe(true);
    expect(openSpy).not.toHaveBeenCalled();
    expect(fakeWindow.location.href).toBe(
      'https://bucket.r2.cloudflarestorage.com/document.pdf',
    );
  });

  it('revoga blob URL depois que a janela de impressão teve tempo de consumi-la', () => {
    jest.useFakeTimers();
    const revokeObjectURL = jest
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    const fakeWindow = {
      opener: {},
      location: { href: '' },
      focus: jest.fn(),
      print: jest.fn(),
      addEventListener: jest.fn(),
    } as unknown as Window & { location: { href: string } };

    openPdfForPrint('blob:http://localhost:3000/temporary-pdf', undefined, fakeWindow);

    jest.advanceTimersByTime(60_000);

    expect(revokeObjectURL).toHaveBeenCalledWith(
      'blob:http://localhost:3000/temporary-pdf',
    );
  });
});

describe('openUrlInNewTab', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('não navega a aba atual quando o pop-up é bloqueado', () => {
    const onPopupBlocked = jest.fn();
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(null);

    expect(
      openUrlInNewTab(
        'https://bucket.r2.cloudflarestorage.com/document.pdf',
        onPopupBlocked,
      ),
    ).toBe(false);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(onPopupBlocked).toHaveBeenCalledTimes(1);
  });
});
