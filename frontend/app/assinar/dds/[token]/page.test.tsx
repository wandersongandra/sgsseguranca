import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PublicDdsSignaturePage from "./page";
import {
  decodeDdsSignatureToken,
  resolveDdsSignatureToken,
} from "./token-utils";
import { publicDdsSignatureService } from "@/services/publicDdsSignatureService";

jest.mock("next/navigation", () => ({ useParams: () => ({ token: "token-a11y" }) }));
jest.mock("next/script", () => function ScriptMock() { return null; });
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock("@/services/publicDdsSignatureService", () => ({
  publicDdsSignatureService: { getContext: jest.fn(), submit: jest.fn() },
}));

const signatureCanvas = document.createElement("canvas");
const clear = jest.fn();
const signatureApi = {
  clear,
  getCanvas: () => signatureCanvas,
  getTrimmedCanvas: () => signatureCanvas,
  isEmpty: () => false,
  toDataURL: () => "data:image/png;base64,drawn",
};

jest.mock("react-signature-canvas", () => {
  const React = jest.requireActual("react");
  return React.forwardRef(function SignatureMock(
    props: {
      canvasProps?: React.CanvasHTMLAttributes<HTMLCanvasElement>;
      onEnd?: () => void;
    },
    ref: React.ForwardedRef<typeof signatureApi>,
  ) {
    React.useImperativeHandle(ref, () => signatureApi);
    return <canvas {...props.canvasProps} />;
  });
});

const getContext = publicDdsSignatureService.getContext as jest.Mock;
const submit = publicDdsSignatureService.submit as jest.Mock;

const context2d = {
  drawImage: jest.fn(),
  scale: jest.fn(),
  fillRect: jest.fn(),
  fillText: jest.fn(),
  fillStyle: "",
  font: "",
  textAlign: "start",
  textBaseline: "alphabetic",
};

describe("PublicDdsSignaturePage accessibility", () => {
  beforeEach(() => {
    sessionStorage.clear();
    jest.clearAllMocks();
    signatureCanvas.width = 100;
    signatureCanvas.height = 100;
    getContext.mockResolvedValue({
      inviteId: "invite-1",
      status: "pending",
      expiresAt: "2026-12-01T12:00:00.000Z",
      signedAt: null,
      signer: { name: "Ana da Silva", role: "Técnica" },
      dds: {
        id: "dds-1",
        tema: "Trabalho seguro",
        data: "2026-07-15",
        status: "publicado",
        companyName: "SGS",
        siteName: "Obra",
        facilitatorName: "Facilitador",
        version: 1,
      },
    });
    submit.mockResolvedValue({ signed: true, signedAt: "2026-07-15T12:00:00.000Z" });
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context2d as unknown as CanvasRenderingContext2D);
    jest.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,typed");
    jest.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 300,
      height: 224,
      top: 0,
      left: 0,
      right: 300,
      bottom: 224,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it("prioriza o token da URL e falha fechado para encoding inválido", () => {
    expect(resolveDdsSignatureToken("token-novo", "token-antigo")).toBe(
      "token-novo",
    );
    expect(resolveDdsSignatureToken("", "token-antigo")).toBe("token-antigo");
    expect(decodeDdsSignatureToken("token%20valido")).toBe("token valido");
    expect(decodeDdsSignatureToken("%E0%A4%A")).toBe("");
  });

  it("oferece assinatura digitada por teclado e envia PNG compatível com a API", async () => {
    render(<PublicDdsSignaturePage />);

    const typedMode = await screen.findByRole("radio", { name: "Digitar nome completo" });
    fireEvent.click(typedMode);
    fireEvent.change(screen.getByLabelText("Nome completo do assinante"), {
      target: { value: "Ana da Silva" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirmo que participei/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar assinatura" }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0][1]).toMatchObject({
      accepted_terms: true,
      signature_data: "data:image/png;base64,typed",
    });
  });

  it("mantém canvas acessivelmente descrito e preserva conteúdo no resize DPR", async () => {
    render(<PublicDdsSignaturePage />);
    const canvas = await screen.findByLabelText("Quadro para desenhar assinatura");
    expect(canvas).toHaveAttribute("aria-describedby", "signature-canvas-instructions");

    fireEvent(window, new Event("resize"));
    expect(context2d.drawImage).toHaveBeenCalled();
  });
});
