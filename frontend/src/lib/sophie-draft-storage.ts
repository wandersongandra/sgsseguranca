import { sanitizeSensitiveDraftValue } from "./sensitive-draft-sanitizer";

type WizardSignatureMap = Record<string, { data: string; type: string }>;

export type SophieDraftRiskSuggestion = {
  id?: string;
  label: string;
  category?: string;
};

export type SophieDraftChecklistSuggestion = {
  id: string;
  label: string;
  reason: string;
  source: "template" | "pt-group";
};

export type SophieWizardDraftMetadata = {
  suggestedRisks?: SophieDraftRiskSuggestion[];
  mandatoryChecklists?: SophieDraftChecklistSuggestion[];
  riskLevel?: string;
};

export type SophieWizardDraft = {
  step: number;
  values: Record<string, unknown>;
  signatures?: WizardSignatureMap;
  metadata?: SophieWizardDraftMetadata;
};

export type SophieNcPreview = {
  id: string;
  riskLevel?: string;
  sourceType?: "manual" | "image" | "checklist";
  actionPlan?: Array<{
    title: string;
    owner: string;
    priority: "low" | "medium" | "high" | "critical";
    timeline: string;
    type: "immediate" | "corrective" | "preventive";
  }>;
  evidenceAttachments?: Array<{
    url: string;
    label: string;
  }>;
  notes?: string[];
};

function resolveCompanyStorageKey(companyId?: string | null) {
  return companyId || "default";
}

function getDraftStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage;
}

function persistDraft(key: string, draft: SophieWizardDraft) {
  const storage = getDraftStorage();
  if (!storage) {
    return;
  }

  storage.setItem(
    key,
    JSON.stringify({
      step: draft.step,
      values: sanitizeSensitiveDraftValue(draft.values),
      signatures: {},
      metadata: draft.metadata || {},
    }),
  );
}

export function storeSophieAprDraft(
  companyId: string | null | undefined,
  draft: SophieWizardDraft,
  metadata?: SophieWizardDraftMetadata,
) {
  persistDraft(`gst.apr.wizard.draft.${resolveCompanyStorageKey(companyId)}`, {
    ...draft,
    metadata: metadata || draft.metadata,
  });
}

export function readSophieAprDraft(companyId: string | null | undefined): SophieWizardDraft | null {
  const storage = getDraftStorage();
  if (!storage) return null;
  const raw = storage.getItem(`gst.apr.wizard.draft.${resolveCompanyStorageKey(companyId)}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SophieWizardDraft;
  } catch {
    return null;
  }
}

export function storeSophiePtDraft(
  companyId: string | null | undefined,
  draft: SophieWizardDraft,
  metadata?: SophieWizardDraftMetadata,
) {
  persistDraft(`gst.pt.wizard.draft.${resolveCompanyStorageKey(companyId)}`, {
    ...draft,
    metadata: metadata || draft.metadata,
  });
}

export function storeSophieNcPreview(preview: SophieNcPreview) {
  const storage = getDraftStorage();
  if (!storage || !preview.id) {
    return;
  }

  storage.setItem(
    `gst.nc.sophie.preview.${preview.id}`,
    JSON.stringify({
      ...preview,
      evidenceAttachments: [],
    }),
  );
}

export function readSophieNcPreview(id: string): SophieNcPreview | null {
  const storage = getDraftStorage();
  if (!storage || !id) {
    return null;
  }

  const raw = storage.getItem(`gst.nc.sophie.preview.${id}`);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SophieNcPreview;
  } catch {
    return null;
  }
}
