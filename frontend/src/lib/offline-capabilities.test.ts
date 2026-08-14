import {
  OFFLINE_CAPABILITY_MATRIX,
  assertNonConformityActionAvailable,
  getNonConformityOfflineActionCapability,
  getOfflineCapability,
  isNonConformityActionAllowed,
  isOfflineActionAllowed,
  nonConformityOfflineActionMessage,
  resolveOfflineRouteCapability,
} from "./offline-capabilities";

describe("offline capability policy", () => {
  it("keeps the approved baseline matrix explicit", () => {
    expect(OFFLINE_CAPABILITY_MATRIX).toEqual({
      apr: "read-write",
      pt: "read-write",
      checklists: "read-write",
      nonconformities: "read-write",
      arr: "read-only",
      did: "read-only",
      sites: "read-only",
      dds: "online-required",
      rdo: "online-required",
      trainings: "online-required",
      medical: "online-required",
    });
  });

  it.each([
    ["/dashboard/aprs/new", "apr", "read-write"],
    ["/dashboard/pts", "pt", "read-write"],
    ["/dashboard/checklists/1", "checklists", "read-write"],
    ["/dashboard/nonconformities", "nonconformities", "read-write"],
    ["/dashboard/arrs", "arr", "read-only"],
    ["/dashboard/dids", "did", "read-only"],
    ["/dashboard/sites", "sites", "read-only"],
    ["/dashboard/dds/new", "dds", "online-required"],
    ["/dashboard/relatorios/rdos", "rdo", "online-required"],
    ["/dashboard/trainings", "trainings", "online-required"],
    ["/dashboard/medical-exams", "medical", "online-required"],
  ] as const)("resolves %s", (pathname, module, capability) => {
    expect(resolveOfflineRouteCapability(pathname)).toEqual({ module, capability });
  });

  it("uses unsupported as the safe default", () => {
    expect(getOfflineCapability(null)).toBe("unsupported");
    expect(resolveOfflineRouteCapability("/dashboard/reports")).toEqual({
      module: null,
      capability: "unsupported",
    });
  });

  it("never blocks reading and only permits offline writes for read-write modules", () => {
    expect(isOfflineActionAllowed("online-required", "read", false)).toBe(true);
    expect(isOfflineActionAllowed("read-only", "write", false)).toBe(false);
    expect(isOfflineActionAllowed("online-required", "write", false)).toBe(false);
    expect(isOfflineActionAllowed("unsupported", "write", false)).toBe(false);
    expect(isOfflineActionAllowed("read-write", "write", false)).toBe(true);
    expect(isOfflineActionAllowed("online-required", "write", true)).toBe(true);
  });

  it("requires a connection for every NC mutation when there is no safe queue", () => {
    for (const action of ["create", "update", "update-status", "remove", "upload", "generate-pdf", "capa", "email", "export"] as const) {
      expect(getNonConformityOfflineActionCapability(action)).toBe("online-required");
      expect(isNonConformityActionAllowed(action, false)).toBe(false);
      expect(nonConformityOfflineActionMessage(action)).toContain("não será colocada na fila");
      expect(() => assertNonConformityActionAvailable(action, false)).toThrow("exige conexão");
    }
    expect(isNonConformityActionAllowed("create", true)).toBe(true);
    expect(isNonConformityActionAllowed("update-status", true)).toBe(true);
  });
});
