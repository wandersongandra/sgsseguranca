export type OfflineCapability =
  | "read-write"
  | "read-only"
  | "online-required"
  | "unsupported";

export type OfflineModule =
  | "apr"
  | "pt"
  | "checklists"
  | "nonconformities"
  | "arr"
  | "did"
  | "sites"
  | "dds"
  | "rdo"
  | "trainings"
  | "medical";

export const OFFLINE_CAPABILITY_MATRIX: Readonly<
  Record<OfflineModule, OfflineCapability>
> = Object.freeze({
  apr: "read-write",
  pt: "read-write",
  checklists: "read-write",
  // Mutações passam pela barreira coarse aqui. O controle granular por ação
  // fica em NONCONFORMITY_OFFLINE_ACTIONS (assertNonConformityActionAvailable).
  nonconformities: "read-write",
  arr: "read-only",
  did: "read-only",
  sites: "read-only",
  dds: "online-required",
  rdo: "online-required",
  trainings: "online-required",
  medical: "online-required",
});

export type OfflineAction = "read" | "write";

export type NonConformityOfflineAction =
  | "create"
  | "update"
  | "update-status"
  | "remove"
  | "upload"
  | "generate-pdf"
  | "capa"
  | "email"
  | "export";

export type OfflineActionCapability = "queue" | "online-required";

export const NONCONFORMITY_OFFLINE_ACTIONS: Readonly<
  Record<NonConformityOfflineAction, OfflineActionCapability>
> = Object.freeze({
  create: "online-required",
  update: "online-required",
  "update-status": "online-required",
  remove: "online-required",
  upload: "online-required",
  "generate-pdf": "online-required",
  capa: "online-required",
  email: "online-required",
  export: "online-required",
});

export class OfflineActionUnavailableError extends Error {
  readonly code = "ERR_OFFLINE_ACTION_UNAVAILABLE";

  constructor(readonly action: NonConformityOfflineAction) {
    super(nonConformityOfflineActionMessage(action));
    this.name = "OfflineActionUnavailableError";
  }
}

export function getNonConformityOfflineActionCapability(
  action: NonConformityOfflineAction,
): OfflineActionCapability {
  return NONCONFORMITY_OFFLINE_ACTIONS[action];
}

export function isNonConformityActionAllowed(
  action: NonConformityOfflineAction,
  online: boolean,
): boolean {
  return online || getNonConformityOfflineActionCapability(action) === "queue";
}

export function nonConformityOfflineActionMessage(
  action: NonConformityOfflineAction,
): string {
  const labels: Record<NonConformityOfflineAction, string> = {
    create: "criar a não conformidade",
    update: "editar a não conformidade",
    "update-status": "alterar o status da não conformidade",
    remove: "excluir a não conformidade",
    upload: "anexar evidências à não conformidade",
    "generate-pdf": "gerar o PDF oficial da não conformidade",
    capa: "gerar a CAPA",
    email: "enviar a não conformidade por e-mail",
    export: "exportar não conformidades",
  };
  if (getNonConformityOfflineActionCapability(action) === "queue") {
    return `Você está offline. É possível ${labels[action]}; a alteração será sincronizada após a reconexão.`;
  }
  return `Você está offline. Não é possível ${labels[action]}; esta ação exige conexão e não será colocada na fila.`;
}

export function assertNonConformityActionAvailable(
  action: NonConformityOfflineAction,
  online = typeof navigator === "undefined" || navigator.onLine,
): void {
  if (!isNonConformityActionAllowed(action, online)) {
    throw new OfflineActionUnavailableError(action);
  }
}

export type OfflineRouteCapability = {
  module: OfflineModule | null;
  capability: OfflineCapability;
};

export class OfflineCapabilityError extends Error {
  readonly code = "ERR_OFFLINE_CAPABILITY";

  constructor(
    readonly pathname: string,
    readonly method: string,
    readonly capability: OfflineCapability,
  ) {
    super(offlineCapabilityMessage(capability));
    this.name = "OfflineCapabilityError";
  }
}

const ROUTES: ReadonlyArray<readonly [RegExp, OfflineModule]> = [
  [/^\/dashboard\/aprs(?:\/|$)/, "apr"],
  [/^\/dashboard\/pts(?:\/|$)/, "pt"],
  [/^\/dashboard\/(?:checklists|checklist-models)(?:\/|$)/, "checklists"],
  [/^\/dashboard\/nonconformities(?:\/|$)/, "nonconformities"],
  [/^\/dashboard\/arrs(?:\/|$)/, "arr"],
  [/^\/dashboard\/dids(?:\/|$)/, "did"],
  [/^\/dashboard\/sites(?:\/|$)/, "sites"],
  [/^\/dashboard\/dds(?:\/|$)/, "dds"],
  [/^\/dashboard\/(?:relatorios\/rdos|rdos)(?:\/|$)/, "rdo"],
  [/^\/dashboard\/trainings(?:\/|$)/, "trainings"],
  [/^\/dashboard\/medical-exams(?:\/|$)/, "medical"],
];

export function getOfflineCapability(
  moduleId: OfflineModule | null | undefined,
): OfflineCapability {
  return moduleId ? OFFLINE_CAPABILITY_MATRIX[moduleId] : "unsupported";
}

export function resolveOfflineRouteCapability(
  pathname: string,
): OfflineRouteCapability {
  const normalizedPathname = pathname.split(/[?#]/, 1)[0] || "/";
  const match = ROUTES.find(([pattern]) => pattern.test(normalizedPathname));
  const matchedModule = match?.[1] ?? null;
  return {
    module: matchedModule,
    capability: getOfflineCapability(matchedModule),
  };
}

/** Reading is never blocked by this policy. Writes require explicit support. */
export function isOfflineActionAllowed(
  capability: OfflineCapability,
  action: OfflineAction,
  online: boolean,
): boolean {
  if (online || action === "read") return true;
  return capability === "read-write";
}

export function offlineCapabilityMessage(
  capability: OfflineCapability,
): string {
  switch (capability) {
    case "read-write":
      return "Você está offline. Este módulo permite consultar e registrar alterações; elas serão sincronizadas após a reconexão.";
    case "read-only":
      return "Você está offline. Os dados já carregados continuam disponíveis para consulta, mas alterações exigem conexão.";
    case "online-required":
      return "Você está offline. Os dados já carregados continuam disponíveis para consulta, mas as ações deste módulo exigem conexão.";
    default:
      return "Você está offline. A leitura do conteúdo já carregado não será bloqueada, mas este módulo não oferece operações offline.";
  }
}
