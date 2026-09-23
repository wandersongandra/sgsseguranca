import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PublicHashVerifyPage from "./page";

jest.mock("@/lib/api", () => ({
  buildApiUrl: jest.fn((path: string) => `https://api.example.test${path}`),
}));

describe("PublicHashVerifyPage", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    window.history.pushState({}, "", "/verify");
  });

  it("uses the public evidence route when validating APR evidence", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        verified: true,
        matchedIn: "original",
        evidence: { apr_numero: "APR-1" },
      }),
    });

    render(<PublicHashVerifyPage />);

    fireEvent.click(screen.getByRole("button", { name: "Evidência APR" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "a".repeat(64) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/evidence/verify?hash=".concat(
          "a".repeat(64),
        ),
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });

    expect(
      await screen.findByText("Registro validado com sucesso."),
    ).toBeInTheDocument();
  });

  it("uses the public signature route when validating a signature hash", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        valid: true,
        signature: { hash: "b".repeat(64), document_type: "PT" },
      }),
    });

    render(<PublicHashVerifyPage />);

    fireEvent.click(screen.getByRole("button", { name: "Assinatura PDF" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "b".repeat(64) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/signature/verify?hash=".concat(
          "b".repeat(64),
        ),
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });

    expect(
      await screen.findByText("Registro validado com sucesso."),
    ).toBeInTheDocument();
  });

  it("uses the public CAT route when validating a CAT code", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        valid: true,
        code: "CAT-2026-ABCDEF12",
        document: {
          id: "cat-1",
          module: "cat",
          document_type: "cat",
          title: "CAT 001",
          document_date: null,
          original_name: null,
          file_hash: null,
          updated_at: "2026-03-19T00:00:00.000Z",
        },
      }),
    });

    render(<PublicHashVerifyPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "Código do documento" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "CAT-2026-ABCDEF12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/cats/validate?code=CAT-2026-ABCDEF12",
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });

    expect(
      await screen.findByText("Registro validado com sucesso."),
    ).toBeInTheDocument();
  });

  it("uses the public checklist route when validating a checklist code", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        valid: true,
        code: "CHK-2026-11-ABCD1234",
      }),
    });

    render(<PublicHashVerifyPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "Código do documento" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "CHK-2026-11-ABCD1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/checklists/validate?code=CHK-2026-11-ABCD1234",
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });
  });

  it("uses the public dossier route when validating a dossier code", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        valid: true,
        code: "DOS-EMP-ABCDEF12",
        document: {
          id: "user-1",
          module: "dossier",
          document_type: "employee_dossier",
          title: "Dossie do colaborador Maria",
          document_date: null,
          original_name: null,
          file_hash: null,
          updated_at: "2026-03-19T00:00:00.000Z",
        },
      }),
    });

    render(<PublicHashVerifyPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "Código do documento" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "DOS-EMP-ABCDEF12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/dossiers/validate?code=DOS-EMP-ABCDEF12",
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });

    expect(
      await screen.findByText("Registro validado com sucesso."),
    ).toBeInTheDocument();
  });

  it("uses the tokenized public APR route when validating an APR code", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        valid: true,
        apr: {
          id: "apr-1",
          numero: "APR-001",
          titulo: "APR de campo",
        },
      }),
    });

    window.history.pushState(
      {},
      "",
      "/verify?type=code&code=APR-AB12CD34&token=apr-token-123",
    );

    render(<PublicHashVerifyPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/aprs/verify?code=APR-AB12CD34&token=apr-token-123",
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });
  });

  it("auto-runs the public signature route for signature deep links", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        valid: true,
        signature: { hash: "c".repeat(64), document_type: "APR" },
      }),
    });
    window.history.pushState(
      {},
      "",
      `/verify?type=signature&hash=${"c".repeat(64)}`,
    );

    render(<PublicHashVerifyPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/signature/verify?hash=".concat(
          "c".repeat(64),
        ),
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });

    expect(
      await screen.findByText("Registro validado com sucesso."),
    ).toBeInTheDocument();
  });

  it("forwards validation token in deep-link code validation", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        valid: true,
        code: "CHK-2026-22D77ACC",
      }),
    });
    window.history.pushState(
      {},
      "",
      "/verify?type=code&code=CHK-2026-22D77ACC&token=opaque-token-123",
    );

    render(<PublicHashVerifyPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/checklists/validate?code=CHK-2026-22D77ACC&token=opaque-token-123",
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });
  });

  it("keeps evidence as the default deep-link mode for bare hashes", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        verified: true,
        matchedIn: "watermarked",
        evidence: { apr_numero: "APR-2" },
      }),
    });
    window.history.pushState({}, "", `/verify?hash=${"d".repeat(64)}`);

    render(<PublicHashVerifyPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/public/evidence/verify?hash=".concat(
          "d".repeat(64),
        ),
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });

    expect(
      await screen.findByText("Registro validado com sucesso."),
    ).toBeInTheDocument();
  });

  it("announces the selected validation mode", () => {
    render(<PublicHashVerifyPage />);

    expect(screen.getByRole("group", { name: "Tipo de validação" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Código do documento" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Evidência APR" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
