import api from "@/lib/api";
import { ptsService, isPtOfflineSignatureBlockedError, getPtApprovalBlockedPayload } from "@/services/ptsService";
import { enqueueOfflineMutation } from "@/lib/offline-sync";

jest.mock("@/lib/api", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("@/lib/offline-sync", () => ({
  enqueueOfflineMutation: jest.fn(),
}));

describe("ptsService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------- findPaginated ----------

  it("busca PTs paginadas com filtros completos", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { data: [], page: 1, limit: 20, total: 0, lastPage: 1 },
    });

    await ptsService.findPaginated({ page: 2, limit: 10, search: "PT-001", status: "Pendente" });

    expect(api.get).toHaveBeenCalledWith("/pts", {
      params: { page: 2, limit: 10, search: "PT-001", status: "Pendente" },
    });
  });

  it("usa valores padrão ao chamar findPaginated sem opções", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { data: [], page: 1, limit: 20, total: 0, lastPage: 1 },
    });

    await ptsService.findPaginated();

    expect(api.get).toHaveBeenCalledWith("/pts", {
      params: { page: 1, limit: 20 },
    });
  });

  it("não usa cache local sensível ao buscar PTs paginadas sem conexão", async () => {
    const error = { code: "ERR_NETWORK" };
    (api.get as jest.Mock).mockRejectedValue(error);

    await expect(ptsService.findPaginated()).rejects.toBe(error);
  });

  it("propaga erro não-offline ao buscar PTs paginadas", async () => {
    const error = { response: { status: 500 } };
    (api.get as jest.Mock).mockRejectedValue(error);

    await expect(ptsService.findPaginated()).rejects.toBe(error);
  });

  // ---------- findOne ----------

  it("busca uma PT pelo id corretamente", async () => {
    const pt = { id: "pt-1", numero: "PT-001", titulo: "Trabalho em Altura" };
    (api.get as jest.Mock).mockResolvedValue({ data: pt });

    const result = await ptsService.findOne("pt-1");

    expect(api.get).toHaveBeenCalledWith("/pts/pt-1");
    expect(result).toEqual(pt);
  });

  it("não usa cache local sensível ao buscar PT individual sem conexão", async () => {
    const error = { code: "ERR_NETWORK" };
    (api.get as jest.Mock).mockRejectedValue(error);

    await expect(ptsService.findOne("pt-1")).rejects.toBe(error);
  });

  it("propaga erro ao buscar PT inexistente", async () => {
    const error = { response: { status: 404 } };
    (api.get as jest.Mock).mockRejectedValue(error);

    await expect(ptsService.findOne("nao-existe")).rejects.toBe(error);
  });

  // ---------- create ----------

  it("cria uma PT e retorna os dados do backend", async () => {
    const pt = { id: "pt-new", numero: "PT-002", titulo: "Espaço Confinado" };
    (api.post as jest.Mock).mockResolvedValue({ data: pt });

    const result = await ptsService.create({
      titulo: "Espaço Confinado",
      site_id: "site-1",
      responsavel_id: "user-1",
    });

    expect(api.post).toHaveBeenCalledWith("/pts", expect.objectContaining({ titulo: "Espaço Confinado" }));
    expect(result).toEqual(pt);
  });

  it("enfileira PT offline quando há erro de rede e allowOfflineQueue não está desativado", async () => {
    (api.post as jest.Mock).mockRejectedValue({ code: "ERR_NETWORK" });
    (enqueueOfflineMutation as jest.Mock).mockResolvedValue({
      id: "queue-pt-1",
      createdAt: "2026-04-15T10:00:00.000Z",
    });

    const result = (await ptsService.create({ titulo: "PT Offline", site_id: "site-1", responsavel_id: "user-1" })) as {
      offlineQueued?: boolean;
    };

    expect(enqueueOfflineMutation).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/pts", method: "post", label: "PT" }),
    );
    expect(result.offlineQueued).toBe(true);
  });

  it("lança PT_OFFLINE_SIGNATURES_NOT_SUPPORTED ao criar PT offline com allowOfflineQueue=false", async () => {
    (api.post as jest.Mock).mockRejectedValue({ code: "ERR_NETWORK" });

    const error = await ptsService
      .create({ titulo: "PT Assinatura", site_id: "site-1", responsavel_id: "user-1" }, { allowOfflineQueue: false })
      .catch((e) => e);

    expect(isPtOfflineSignatureBlockedError(error)).toBe(true);
    expect(error.response?.data?.code).toBe("PT_OFFLINE_SIGNATURES_NOT_SUPPORTED");
    expect(error.response?.status).toBe(400);
  });

  it("propaga erro não-rede ao criar PT", async () => {
    const error = { response: { status: 422, data: { message: "Inválido" } } };
    (api.post as jest.Mock).mockRejectedValue(error);

    await expect(ptsService.create({ titulo: "PT Inválida", site_id: "site-1", responsavel_id: "user-1" })).rejects.toBe(error);
    expect(enqueueOfflineMutation).not.toHaveBeenCalled();
  });

  // ---------- update ----------

  it("atualiza uma PT com PATCH na rota canônica", async () => {
    const updated = { id: "pt-1", titulo: "PT Atualizada" };
    (api.patch as jest.Mock).mockResolvedValue({ data: updated });

    const result = await ptsService.update("pt-1", { titulo: "PT Atualizada" });

    expect(api.patch).toHaveBeenCalledWith("/pts/pt-1", { titulo: "PT Atualizada" });
    expect(result).toEqual(updated);
  });

  it("substitui assinaturas da PT pela rota atômica do módulo", async () => {
    const resultPayload = { entityId: "pt-1", replaced: 1 };
    (api.put as jest.Mock).mockResolvedValue({ data: resultPayload });
    const signatures = [
      {
        user_id: "user-1",
        signature_data: "data:image/png;base64,signature",
        type: "drawn",
      },
    ];

    await expect(ptsService.replaceSignatures("pt-1", signatures)).resolves.toEqual(
      resultPayload,
    );
    expect(api.put).toHaveBeenCalledWith("/pts/pt-1/signatures", { signatures });
  });

  it("cria assinatura avulsa pela rota PT restrita ao executante", async () => {
    const resultPayload = { entityId: "pt-1", created: true as const };
    (api.post as jest.Mock).mockResolvedValue({ data: resultPayload });

    await expect(
      ptsService.createSignature("pt-1", {
        signature_data: "data:image/png;base64,signature",
        type: "drawn",
      }),
    ).resolves.toEqual(resultPayload);

    expect(api.post).toHaveBeenCalledWith("/pts/pt-1/signatures", {
      signature_data: "data:image/png;base64,signature",
      type: "drawn",
    });
  });

  it("lança PT_OFFLINE_SIGNATURES_NOT_SUPPORTED ao atualizar PT offline com allowOfflineQueue=false", async () => {
    (api.patch as jest.Mock).mockRejectedValue({ code: "ERR_NETWORK" });

    const error = await ptsService
      .update("pt-1", { titulo: "Atualização" }, { allowOfflineQueue: false })
      .catch((e) => e);

    expect(isPtOfflineSignatureBlockedError(error)).toBe(true);
  });

  it("enfileira atualização de PT offline quando há erro de rede", async () => {
    (api.patch as jest.Mock).mockRejectedValue({ code: "ERR_NETWORK" });
    (enqueueOfflineMutation as jest.Mock).mockResolvedValue({
      id: "queue-pt-2",
      createdAt: "2026-04-15T11:00:00.000Z",
    });

    const result = (await ptsService.update("pt-1", { titulo: "Atualização Offline" })) as {
      offlineQueued?: boolean;
    };

    expect(enqueueOfflineMutation).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/pts/pt-1", method: "patch", label: "PT" }),
    );
    expect(result.offlineQueued).toBe(true);
  });

  // ---------- delete ----------

  it("deleta uma PT via DELETE na rota correta", async () => {
    (api.delete as jest.Mock).mockResolvedValue({});

    await ptsService.delete("pt-1");

    expect(api.delete).toHaveBeenCalledWith("/pts/pt-1");
  });

  it("propaga erro ao deletar PT que não existe", async () => {
    const error = { response: { status: 404 } };
    (api.delete as jest.Mock).mockRejectedValue(error);

    await expect(ptsService.delete("nao-existe")).rejects.toBe(error);
  });

  // ---------- approve / reject / finalize ----------

  it("aprova uma PT com POST na rota correta e motivo", async () => {
    const approved = { id: "pt-1", status: "Aprovada" };
    (api.post as jest.Mock).mockResolvedValue({ data: approved });

    const result = await ptsService.approve("pt-1", "Tudo conforme");

    expect(api.post).toHaveBeenCalledWith("/pts/pt-1/approve", { reason: "Tudo conforme" });
    expect(result.status).toBe("Aprovada");
  });

  it("rejeita uma PT com POST e motivo obrigatório", async () => {
    const rejected = { id: "pt-1", status: "Cancelada" };
    (api.post as jest.Mock).mockResolvedValue({ data: rejected });

    const result = await ptsService.reject("pt-1", "Risco não mitigado");

    expect(api.post).toHaveBeenCalledWith("/pts/pt-1/reject", { reason: "Risco não mitigado" });
    expect(result).toEqual(rejected);
  });

  it("finaliza uma PT com POST na rota de finalização e dados de encerramento", async () => {
    (api.post as jest.Mock).mockResolvedValue({ data: { id: "pt-1", status: "Encerrada" } });

    const result = await ptsService.finalize("pt-1", {
      condicao_area: "Limpa e liberada",
      observacoes: "Área devolvida sem pendências",
    });

    expect(api.post).toHaveBeenCalledWith("/pts/pt-1/finalize", {
      condicao_area: "Limpa e liberada",
      observacoes: "Área devolvida sem pendências",
    });
    expect(result.status).toBe("Encerrada");
  });

  // ---------- PDF ----------

  it("obtém acesso ao PDF governado da PT", async () => {
    const pdfAccess = { hasFinalPdf: true, availability: "available", url: "https://cdn.example.com/pt-1.pdf" };
    (api.get as jest.Mock).mockResolvedValue({ data: pdfAccess });

    const result = await ptsService.getPdfAccess("pt-1");

    expect(api.get).toHaveBeenCalledWith("/pts/pt-1/pdf");
    expect(result).toEqual(pdfAccess);
  });

  // ---------- attachFile ----------

  it("envia arquivo como multipart para rota de evidência da PT", async () => {
    (api.post as jest.Mock).mockResolvedValue({ data: { fileKey: "key-1" } });

    const file = new File(["conteudo"], "evidencia.jpg", { type: "image/jpeg" });
    const result = await ptsService.attachFile("pt-1", file);

    expect(api.post).toHaveBeenCalledWith(
      "/pts/pt-1/file",
      expect.any(FormData),
      expect.objectContaining({ headers: { "Content-Type": "multipart/form-data" } }),
    );
    expect(result.fileKey).toBe("key-1");
  });

  // ---------- analytics ----------

  it("retorna visão geral de analytics de PTs", async () => {
    const overview = { totalPts: 10, aprovadas: 5, pendentes: 3, canceladas: 1, encerradas: 1, expiradas: 0 };
    (api.get as jest.Mock).mockResolvedValue({ data: overview });

    const result = await ptsService.getAnalyticsOverview();

    expect(api.get).toHaveBeenCalledWith("/pts/analytics/overview");
    expect(result.totalPts).toBe(10);
  });

  // ---------- approval rules ----------

  it("retorna regras de aprovação de PT", async () => {
    const rules = {
      blockCriticalRiskWithoutEvidence: true,
      blockWorkerWithoutValidMedicalExam: false,
      blockWorkerWithExpiredBlockingTraining: true,
      requireAtLeastOneExecutante: false,
    };
    (api.get as jest.Mock).mockResolvedValue({ data: rules });

    const result = await ptsService.getApprovalRules();

    expect(api.get).toHaveBeenCalledWith("/pts/approval-rules");
    expect(result).toEqual(rules);
  });

  it("atualiza regras de aprovação de PT via PATCH", async () => {
    const updatedRules = {
      blockCriticalRiskWithoutEvidence: false,
      blockWorkerWithoutValidMedicalExam: true,
      blockWorkerWithExpiredBlockingTraining: true,
      requireAtLeastOneExecutante: true,
    };
    (api.patch as jest.Mock).mockResolvedValue({ data: updatedRules });

    const result = await ptsService.updateApprovalRules({ blockCriticalRiskWithoutEvidence: false });

    expect(api.patch).toHaveBeenCalledWith("/pts/approval-rules", { blockCriticalRiskWithoutEvidence: false });
    expect(result).toEqual(updatedRules);
  });

  // ---------- pre-approval review ----------

  it("registra revisão de pré-aprovação via POST", async () => {
    (api.post as jest.Mock).mockResolvedValue({ data: { logged: true } });

    const payload = {
      stage: "preview" as const,
      readyForRelease: false,
      blockers: ["Risco crítico sem evidência"],
      unansweredChecklistItems: 2,
      adverseChecklistItems: 1,
      pendingSignatures: 0,
      hasRapidRiskBlocker: false,
      workerStatuses: [],
      warnings: [],
    };

    const result = await ptsService.logPreApprovalReview("pt-1", payload);

    expect(api.post).toHaveBeenCalledWith("/pts/pt-1/pre-approval-review", payload);
    expect(result).toEqual({ logged: true });
  });

  it("obtém histórico de pré-aprovação de uma PT", async () => {
    const history = [{ id: "hist-1", action: "PRE_APPROVAL", userId: "user-1", createdAt: "2026-04-01T00:00:00Z" }];
    (api.get as jest.Mock).mockResolvedValue({ data: history });

    const result = await ptsService.getPreApprovalHistory("pt-1");

    expect(api.get).toHaveBeenCalledWith("/pts/pt-1/pre-approval-history");
    expect(result).toHaveLength(1);
  });

  // ---------- stored files ----------

  it("lista arquivos armazenados com filtros de empresa e semana", async () => {
    (api.get as jest.Mock).mockResolvedValue({ data: [{ fileName: "bundle.zip" }] });

    await ptsService.listStoredFiles({ company_id: "co-1", year: 2026, week: 15 });

    expect(api.get).toHaveBeenCalledWith("/pts/files/list", {
      params: { company_id: "co-1", year: 2026, week: 15 },
    });
  });

  it("faz download do bundle semanal como Blob", async () => {
    const blob = new Blob(["zip content"], { type: "application/zip" });
    (api.get as jest.Mock).mockResolvedValue({ data: blob });

    const result = await ptsService.downloadWeeklyBundle({ company_id: "co-1", year: 2026, week: 15 });

    expect(api.get).toHaveBeenCalledWith("/pts/files/weekly-bundle", {
      params: { company_id: "co-1", year: 2026, week: 15 },
      responseType: "blob",
    });
    expect(result).toBeInstanceOf(Blob);
  });

  // ---------- isPtOfflineSignatureBlockedError ----------

  it("isPtOfflineSignatureBlockedError retorna true para o código correto", () => {
    const error = {
      response: {
        status: 400,
        data: { code: "PT_OFFLINE_SIGNATURES_NOT_SUPPORTED", message: "Conexão necessária." },
      },
    };
    expect(isPtOfflineSignatureBlockedError(error)).toBe(true);
  });

  it("isPtOfflineSignatureBlockedError retorna false para código diferente", () => {
    const error = { response: { data: { code: "OUTRO_ERRO" } } };
    expect(isPtOfflineSignatureBlockedError(error)).toBe(false);
  });

  it("isPtOfflineSignatureBlockedError retorna false para erro sem response", () => {
    expect(isPtOfflineSignatureBlockedError(new Error("Erro genérico"))).toBe(false);
  });

  // ---------- getPtApprovalBlockedPayload ----------

  it("getPtApprovalBlockedPayload extrai payload completo de bloqueio de aprovação", () => {
    const error = {
      response: {
        data: {
          code: "PT_APPROVAL_BLOCKED",
          message: "PT bloqueada.",
          reasons: ["Risco crítico sem evidência"],
          rules: {
            blockCriticalRiskWithoutEvidence: true,
            blockWorkerWithoutValidMedicalExam: false,
            blockWorkerWithExpiredBlockingTraining: true,
            requireAtLeastOneExecutante: false,
          },
        },
      },
    };

    const payload = getPtApprovalBlockedPayload(error);
    expect(payload?.code).toBe("PT_APPROVAL_BLOCKED");
    expect(payload?.reasons).toContain("Risco crítico sem evidência");
  });

  it("getPtApprovalBlockedPayload retorna null para código incorreto", () => {
    const error = { response: { data: { code: "OUTRO", reasons: [] } } };
    expect(getPtApprovalBlockedPayload(error)).toBeNull();
  });

  it("getPtApprovalBlockedPayload retorna null quando reasons não é array", () => {
    const error = { response: { data: { code: "PT_APPROVAL_BLOCKED", reasons: "string inválida" } } };
    expect(getPtApprovalBlockedPayload(error)).toBeNull();
  });

  it("getPtApprovalBlockedPayload filtra reasons vazias ou em branco", () => {
    const error = {
      response: {
        data: {
          code: "PT_APPROVAL_BLOCKED",
          reasons: ["Motivo válido", "  ", ""],
          rules: {},
        },
      },
    };
    const payload = getPtApprovalBlockedPayload(error);
    expect(payload?.reasons).toEqual(["Motivo válido"]);
  });

  // ---------- findByCursor ----------

  it("busca PTs por cursor com parâmetros corretos", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { data: [], nextCursor: null, total: 0 },
    });

    await ptsService.findByCursor({ cursor: "cursor-abc", limit: 15, search: "PT", status: "Aprovada" });

    expect(api.get).toHaveBeenCalledWith("/pts", {
      params: { cursor: "cursor-abc", limit: 15, search: "PT", status: "Aprovada" },
    });
  });

  // ---------- findAll ----------

  it("busca todas as PTs para exportação", async () => {
    const pts = [{ id: "pt-1" }, { id: "pt-2" }];
    (api.get as jest.Mock).mockResolvedValue({ data: pts });

    const result = await ptsService.findAll();

    expect(api.get).toHaveBeenCalledWith("/pts/export/all");
    expect(result).toEqual(pts);
  });
});
