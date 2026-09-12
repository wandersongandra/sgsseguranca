import { clearSensitiveBrowserStorage } from "./browser-sensitive-storage";

describe("clearSensitiveBrowserStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("remove caches, fila offline e rascunhos sensiveis do browser", async () => {
    window.localStorage.setItem("gst.cache.aprs", '{"cpf":"12345678900"}');
    window.localStorage.setItem("gst.offline.queue", "enc:payload");
    window.localStorage.setItem("gst.apr.wizard.draft.company-1", "{}");
    window.localStorage.setItem("gst.pt.wizard.draft.company-1", "{}");
    window.localStorage.setItem("gst.nc.sophie.preview.nc-1", "{}");
    window.localStorage.setItem("checklist.form.draft.user-1.standard", "{}");
    window.localStorage.setItem("checklist.form.draft.create.user-1.template-1", "{}");
    window.sessionStorage.setItem("gst.pt.wizard.draft.company-legacy", "{}");
    window.sessionStorage.setItem("gst.apr.wizard.draft.company-legacy", "{}");
    window.localStorage.setItem("theme", "dark");

    await clearSensitiveBrowserStorage();

    expect(window.localStorage.getItem("gst.cache.aprs")).toBeNull();
    expect(window.localStorage.getItem("gst.offline.queue")).toBeNull();
    expect(
      window.localStorage.getItem("gst.apr.wizard.draft.company-1"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("gst.pt.wizard.draft.company-1"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("gst.nc.sophie.preview.nc-1"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("checklist.form.draft.user-1.standard"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("checklist.form.draft.create.user-1.template-1"),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem("gst.pt.wizard.draft.company-legacy"),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem("gst.apr.wizard.draft.company-legacy"),
    ).toBeNull();
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });
});
