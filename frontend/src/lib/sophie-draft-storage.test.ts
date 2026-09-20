import {
  storeSophieAprDraft,
  storeSophieNcPreview,
  storeSophiePtDraft,
} from "./sophie-draft-storage";

describe("sophie-draft-storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("persiste rascunhos de APR/PT sem assinaturas, CPF, anexos ou URLs privadas", () => {
    const draft = {
      step: 2,
      values: {
        titulo: "Atividade critica",
        trabalhador: {
          nome: "Operador",
          cpf: "12345678900",
        },
        presignedUrl: "https://storage.local/private",
        evidencia: {
          descricao: "Queda de material",
          imageDataUrl: "data:image/png;base64,abc",
        },
      },
      signatures: {
        user1: {
          data: "data:image/png;base64,signature",
          type: "draw",
        },
      },
    };

    storeSophieAprDraft("company-1", draft);
    storeSophiePtDraft("company-1", "user-1", draft);

    const aprDraft = window.sessionStorage.getItem(
      "gst.apr.wizard.draft.company-1",
    );
    const ptDraft = window.localStorage.getItem(
      "gst.pt.wizard.draft.company-1.user-1",
    );

    expect(aprDraft).not.toContain("12345678900");
    expect(aprDraft).not.toContain("presignedUrl");
    expect(aprDraft).not.toContain("data:image");
    expect(aprDraft).toContain('"signatures":{}');
    expect(ptDraft).not.toContain("12345678900");
    expect(ptDraft).not.toContain("presignedUrl");
    expect(ptDraft).not.toContain("data:image");
    expect(ptDraft).toContain('"signatures":{}');
    expect(window.sessionStorage.getItem("gst.pt.wizard.draft.company-1")).toBeNull();
  });

  it("remove anexos de evidencia do preview de NC", () => {
    storeSophieNcPreview({
      id: "nc-1",
      sourceType: "checklist",
      evidenceAttachments: [
        {
          label: "Foto",
          url: "https://storage.local/private",
        },
      ],
    });

    const preview = window.sessionStorage.getItem("gst.nc.sophie.preview.nc-1");

    expect(preview).not.toContain("https://storage.local/private");
    expect(preview).toContain('"evidenceAttachments":[]');
  });
});
