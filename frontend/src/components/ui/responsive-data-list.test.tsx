import { act, fireEvent, render, screen } from '@testing-library/react';
import { ResponsiveDataList } from './responsive-data-list';

type Item = { id: string; label: string };

function installMatchMedia(initiallyDesktop: boolean) {
  let matches = initiallyDesktop;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: '(min-width: 768px)',
    onchange: null,
    addEventListener: jest.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: jest.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  } as unknown as MediaQueryList;

  window.matchMedia = jest.fn(() => mediaQuery);

  return (nextMatches: boolean) => {
    matches = nextMatches;
    act(() => {
      listeners.forEach((listener) =>
        listener({ matches, media: mediaQuery.media } as MediaQueryListEvent),
      );
    });
  };
}

const items: Item[] = [
  { id: 'one', label: 'Primeiro' },
  { id: 'two', label: 'Segundo' },
];

function renderList(props: Partial<React.ComponentProps<typeof ResponsiveDataList<Item>>> = {}) {
  return render(
    <ResponsiveDataList
      items={items}
      getKey={(item) => item.id}
      desktop={(currentItems) => (
        <table aria-label="Lista desktop">
          <tbody>
            {currentItems.map((item) => (
              <tr key={item.id}>
                <td>{item.label}</td>
                <td><button type="button">Abrir {item.label}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      mobile={(item) => (
        <article>
          <span>{item.label}</span>
          <button type="button">Abrir {item.label}</button>
        </article>
      )}
      {...props}
    />,
  );
}

describe('ResponsiveDataList', () => {
  it('renderiza somente a árvore desktop interativa quando o breakpoint corresponde', () => {
    installMatchMedia(true);
    renderList();

    expect(screen.getByRole('table', { name: 'Lista desktop' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Abrir Primeiro' })).toHaveLength(1);
    expect(screen.getAllByText('Primeiro')).toHaveLength(1);
  });

  it('renderiza os itens mobile com chaves estáveis e troca de árvore ao mudar o breakpoint', () => {
    const setDesktop = installMatchMedia(false);
    const { container } = renderList();

    expect(screen.queryByRole('table', { name: 'Lista desktop' })).not.toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Abrir Primeiro' })).toHaveLength(1);

    setDesktop(true);

    expect(screen.getByRole('table', { name: 'Lista desktop' })).toBeInTheDocument();
    expect(container.querySelectorAll('article')).toHaveLength(0);
  });

  it('prioriza loading e empty sem montar as árvores responsivas', () => {
    installMatchMedia(true);
    const { rerender } = renderList({ loading: <p>Carregando documentos</p> });

    expect(screen.getByText('Carregando documentos')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    rerender(
      <ResponsiveDataList
        items={[]}
        getKey={(item: Item) => item.id}
        desktop={() => <table aria-label="Lista desktop" />}
        mobile={(item) => <article>{item.label}</article>}
        empty={<p>Nenhum documento</p>}
      />,
    );

    expect(screen.getByText('Nenhum documento')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('mantém uma única ação executável depois da mudança de viewport', () => {
    const setDesktop = installMatchMedia(false);
    const onAction = jest.fn();
    const actionItem: Item = { id: 'one', label: 'Primeiro' };
    render(
      <ResponsiveDataList
        items={[actionItem]}
        getKey={(item) => item.id}
        desktop={(currentItems) => (
          <button type="button" onClick={() => onAction(currentItems[0]!.id)}>Executar</button>
        )}
        mobile={(item) => (
          <button type="button" onClick={() => onAction(item.id)}>Executar</button>
        )}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Executar' }));
    setDesktop(true);
    fireEvent.click(screen.getByRole('button', { name: 'Executar' }));

    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('usa addListener/removeListener em WebViews sem a API moderna', () => {
    const listeners = new Set<() => void>();
    const mediaQuery = {
      matches: false,
      media: '(min-width: 768px)',
      onchange: null,
      addListener: jest.fn((listener: () => void) => listeners.add(listener)),
      removeListener: jest.fn((listener: () => void) => listeners.delete(listener)),
      dispatchEvent: jest.fn(),
    } as unknown as MediaQueryList;
    window.matchMedia = jest.fn(() => mediaQuery);

    const { unmount } = renderList();
    expect(mediaQuery.addListener).toHaveBeenCalledTimes(1);

    unmount();
    expect(mediaQuery.removeListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
