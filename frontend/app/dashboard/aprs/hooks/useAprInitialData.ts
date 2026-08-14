import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  UseFieldArrayReplace,
  UseFormGetValues,
  UseFormReset,
  UseFormSetValue,
} from "react-hook-form";
import { toast } from "sonner";

import { aprsService, type Apr } from "@/services/aprsService";
import type { Activity } from "@/services/activitiesService";
import type { Risk } from "@/services/risksService";
import type { Epi } from "@/services/episService";
import type { Tool } from "@/services/toolsService";
import type { Machine } from "@/services/machinesService";
import type { Site } from "@/services/sitesService";
import { companiesService, type Company } from "@/services/companiesService";
import type { User } from "@/services/usersService";
import {
  signaturesService,
  type Signature,
} from "@/services/signaturesService";
import { toInputDateValue } from "@/lib/date/safeFormat";
import { logger } from "@/lib/logger";
import type {
  SophieDraftChecklistSuggestion,
  SophieDraftRiskSuggestion,
} from "@/lib/sophie-draft-storage";

import type { AprLogEntry } from "../components/AprTimeline";
import {
  createAprDraftMetadata,
  readAprDraft,
  type AprDraftPendingOfflineSync,
} from "../components/aprDraftStorage";
import type { AprFormData } from "../components/aprForm.schema";
import { trackAprOfflineTelemetry } from "../components/aprOfflineTelemetry";
import {
  dedupeById,
  isUuidLike,
  mapPersistedRiskItemToFormRow,
  normalizeRiskRow,
} from "../components/aprFormUtils";
import type {
  AprWorkflowEvidenceItem,
  AprWorkflowVersionHistoryItem,
} from "./useAprPdfWorkflow";

type AprInitialDataUser = Pick<User, "company_id" | "profile"> & {
  company_id?: string | null;
};

type SignatureMap = Record<string, { data: string; type: string }>;
type PersistedSignatureMap = Record<
  string,
  { id?: string; data: string; type: string }
>;

interface UseAprInitialDataOptions {
  id?: string;
  user?: AprInitialDataUser | null;
  canViewSignatures: boolean;
  draftStorageKey?: string | null;
  legacyDraftStorageKey?: string | null;
  getValuesRef: MutableRefObject<UseFormGetValues<AprFormData>>;
  reset: UseFormReset<AprFormData>;
  setValue: UseFormSetValue<AprFormData>;
  replaceRisk: UseFieldArrayReplace<AprFormData, "itens_risco">;
  setFetching: Dispatch<SetStateAction<boolean>>;
  setLoadingTimeline: Dispatch<SetStateAction<boolean>>;
  setCurrentApr: Dispatch<SetStateAction<Apr | null>>;
  setAprLogs: Dispatch<SetStateAction<AprLogEntry[]>>;
  setVersionHistory: Dispatch<SetStateAction<AprWorkflowVersionHistoryItem[]>>;
  setAprEvidences: Dispatch<SetStateAction<AprWorkflowEvidenceItem[]>>;
  setActivities: Dispatch<SetStateAction<Activity[]>>;
  setRisks: Dispatch<SetStateAction<Risk[]>>;
  setEpis: Dispatch<SetStateAction<Epi[]>>;
  setTools: Dispatch<SetStateAction<Tool[]>>;
  setMachines: Dispatch<SetStateAction<Machine[]>>;
  setSites: Dispatch<SetStateAction<Site[]>>;
  setUsers: Dispatch<SetStateAction<User[]>>;
  setCompanies: Dispatch<SetStateAction<Company[]>>;
  setSignatures: Dispatch<SetStateAction<SignatureMap>>;
  setPersistedSignatures: Dispatch<SetStateAction<PersistedSignatureMap>>;
  setCurrentStep: Dispatch<SetStateAction<number>>;
  setDraftId: Dispatch<SetStateAction<string | null>>;
  setDraftRestored: Dispatch<SetStateAction<boolean>>;
  setDraftPendingOfflineSync: Dispatch<
    SetStateAction<AprDraftPendingOfflineSync | null>
  >;
  setDraftSecurityNotice: Dispatch<
    SetStateAction<{
      corrupted: boolean;
      sensitiveDataRemoved: boolean;
    }>
  >;
  setSophieSuggestedRisks: Dispatch<
    SetStateAction<SophieDraftRiskSuggestion[]>
  >;
  setSophieMandatoryChecklists: Dispatch<
    SetStateAction<SophieDraftChecklistSuggestion[]>
  >;
}

export function useAprInitialData({
  id,
  user,
  canViewSignatures,
  draftStorageKey,
  legacyDraftStorageKey,
  getValuesRef,
  reset,
  setValue,
  replaceRisk,
  setFetching,
  setLoadingTimeline,
  setCurrentApr,
  setAprLogs,
  setVersionHistory,
  setAprEvidences,
  setActivities,
  setRisks,
  setEpis,
  setTools,
  setMachines,
  setSites,
  setUsers,
  setCompanies,
  setSignatures,
  setPersistedSignatures,
  setCurrentStep,
  setDraftId,
  setDraftRestored,
  setDraftPendingOfflineSync,
  setDraftSecurityNotice,
  setSophieSuggestedRisks,
  setSophieMandatoryChecklists,
}: UseAprInitialDataOptions) {
  const userCompanyId = user?.company_id;
  const userProfileName = user?.profile?.nome;

  useEffect(() => {
    let cancelled = false;

    const loadCompanies = async (selectedCompanyId?: string) => {
      const isGlobalAdmin = userProfileName === "Administrador Geral";
      let nextCompanies: Company[] = [];
      const scopedCompanyId = isUuidLike(selectedCompanyId)
        ? String(selectedCompanyId)
        : undefined;

      if (isGlobalAdmin) {
        try {
          const companiesPage = await companiesService.findPaginated({
            page: 1,
            limit: 100,
          });
          nextCompanies = companiesPage.data;
        } catch (error) {
          logger.error("Erro ao carregar lista de empresas da APR:", error);
        }
      } else {
        const fallbackCompanyId =
          scopedCompanyId ||
          (isUuidLike(userCompanyId) ? String(userCompanyId) : undefined);
        if (fallbackCompanyId) {
          try {
            const selectedCompany =
              await companiesService.findOne(fallbackCompanyId);
            nextCompanies = [selectedCompany];
          } catch (error) {
            logger.error(
              "Erro ao carregar empresa padrão da APR para o usuário:",
              error,
            );
          }
        }
      }

      if (
        isGlobalAdmin &&
        scopedCompanyId &&
        !nextCompanies.some((company) => company.id === scopedCompanyId)
      ) {
        try {
          const selectedCompany =
            await companiesService.findOne(scopedCompanyId);
          nextCompanies = dedupeById([selectedCompany, ...nextCompanies]);
        } catch {
          nextCompanies = dedupeById(nextCompanies);
        }
      }

      if (!cancelled) {
        setCompanies(dedupeById(nextCompanies));
      }
    };

    async function loadData() {
      let timelineLoadStarted = false;

      try {
        let companySeedId = isUuidLike(userCompanyId)
          ? String(userCompanyId)
          : "";

        if (id) {
          setLoadingTimeline(true);
          setDraftId(null);
          setDraftPendingOfflineSync(null);
          setPersistedSignatures({});
          setSignatures({});

          const signaturesPromise = canViewSignatures
            ? signaturesService.findByDocument(id, "APR")
            : Promise.resolve<Signature[]>([]);
          const apr = await aprsService.findOne(id);
          if (cancelled) {
            return;
          }

          setCurrentApr(apr);

          void signaturesPromise
            .then((sigs) => {
              if (cancelled) {
                return;
              }
              const sigMap: SignatureMap = {};
              const persistedSigMap: PersistedSignatureMap = {};
              sigs.forEach((signature) => {
                if (!signature.user_id) return;
                const signatureData = signature.signature_data ?? "";
                sigMap[signature.user_id] = {
                  data: signatureData,
                  type: signature.type,
                };
                persistedSigMap[signature.user_id] = {
                  id: signature.id,
                  data: signatureData,
                  type: signature.type,
                };
              });
              setSignatures(sigMap);
              setPersistedSignatures(persistedSigMap);
            })
            .catch((error) => {
              if (cancelled) {
                return;
              }
              logger.error("Erro ao carregar assinaturas da APR:", error);
              toast.error(
                "Algumas assinaturas da APR não puderam ser carregadas.",
              );
            });

          companySeedId = apr.company_id || companySeedId;
          setActivities(dedupeById(apr.activities || []));
          setRisks(dedupeById(apr.risks || []));
          setEpis(dedupeById(apr.epis || []));
          setTools(dedupeById(apr.tools || []));
          setMachines(dedupeById(apr.machines || []));
          setSites(dedupeById(apr.site ? [apr.site] : []));
          setUsers(
            dedupeById([
              ...(apr.elaborador ? [apr.elaborador] : []),
              ...(apr.participants || []),
              ...(apr.auditado_por ? [apr.auditado_por] : []),
            ]),
          );
          setSophieSuggestedRisks([]);
          setSophieMandatoryChecklists([]);

          timelineLoadStarted = true;
          void (async () => {
            try {
              const [logs, versions, evidences] = await Promise.all([
                aprsService.getLogs(id),
                aprsService.getVersionHistory(id),
                aprsService.listAprEvidences(id),
              ]);
              if (cancelled) {
                return;
              }
              setAprLogs(logs);
              setAprEvidences(evidences);
              setVersionHistory(
                versions.map((item) => ({
                  id: item.id,
                  numero: item.numero,
                  versao: item.versao,
                  status: item.status,
                })),
              );
            } catch (error) {
              if (!cancelled) {
                logger.error(
                  "Erro ao carregar a linha do tempo da APR:",
                  error,
                );
              }
            } finally {
              if (!cancelled) {
                setLoadingTimeline(false);
              }
            }
          })();

          reset({
            pdf_signed: Boolean(apr.has_final_pdf),
            numero: apr.numero,
            titulo: apr.titulo,
            descricao: apr.descricao || "",
            tipo_atividade: apr.tipo_atividade || "",
            frente_trabalho: apr.frente_trabalho || "",
            area_risco: apr.area_risco || "",
            turno: apr.turno || "",
            local_execucao_detalhado: apr.local_execucao_detalhado || "",
            responsavel_tecnico_nome: apr.responsavel_tecnico_nome || "",
            responsavel_tecnico_registro:
              apr.responsavel_tecnico_registro || "",
            data_inicio: toInputDateValue(apr.data_inicio),
            data_fim: toInputDateValue(apr.data_fim),
            status: apr.status,
            company_id: apr.company_id,
            site_id: apr.site_id,
            elaborador_id: apr.elaborador_id,
            activities: apr.activities.map((activity: Activity) => activity.id),
            risks: apr.risks.map((risk: Risk) => risk.id),
            epis: apr.epis.map((epi: Epi) => epi.id),
            tools: apr.tools.map((tool: Tool) => tool.id),
            machines: apr.machines.map((machine: Machine) => machine.id),
            participants: apr.participants.map(
              (participant: User) => participant.id,
            ),
            is_modelo: apr.is_modelo || false,
            is_modelo_padrao: apr.is_modelo_padrao || false,
            itens_risco:
              apr.risk_items && apr.risk_items.length > 0
                ? apr.risk_items.map((item) =>
                    mapPersistedRiskItemToFormRow(item),
                  )
                : apr.itens_risco && apr.itens_risco.length > 0
                  ? apr.itens_risco.map((item) => normalizeRiskRow(item))
                  : [],
            auditado_por_id: apr.auditado_por_id || "",
            data_auditoria: toInputDateValue(apr.data_auditoria),
            resultado_auditoria: apr.resultado_auditoria || "",
            notas_auditoria: apr.notas_auditoria || "",
          });
          setLoadingTimeline(false);
        } else if (draftStorageKey && typeof window !== "undefined") {
          setPersistedSignatures({});
          setSignatures({});
          const draftReadResult = readAprDraft(
            draftStorageKey,
            legacyDraftStorageKey,
          );

          if (draftReadResult.corrupted) {
            trackAprOfflineTelemetry("draft_corrupted_discarded", {
              source: "apr_form_load",
            });
            setDraftSecurityNotice((prev) => ({ ...prev, corrupted: true }));
          }

          if (draftReadResult.removedSensitiveState) {
            trackAprOfflineTelemetry("draft_restored_sanitized", {
              draftId: draftReadResult.draft?.metadata.draftId,
              source: "apr_form_load",
            });
            setDraftSecurityNotice((prev) => ({
              ...prev,
              sensitiveDataRemoved: true,
            }));
          }

          if (draftReadResult.draft) {
            const parsedDraft = draftReadResult.draft;
            setDraftId(parsedDraft.metadata.draftId);

            if (draftReadResult.migratedFromLegacy) {
              trackAprOfflineTelemetry("draft_legacy_detected", {
                draftId: parsedDraft.metadata.draftId,
                source: "apr_form_load",
              });
            }

            if (parsedDraft.values) {
              reset({
                ...getValuesRef.current(),
                ...parsedDraft.values,
              });
              companySeedId = parsedDraft.values.company_id || companySeedId;
              replaceRisk(
                parsedDraft.values.itens_risco &&
                  parsedDraft.values.itens_risco.length > 0
                  ? parsedDraft.values.itens_risco.map((item) =>
                      normalizeRiskRow(item),
                    )
                  : [],
              );
            }

            setCurrentStep(parsedDraft.step);
            setSophieSuggestedRisks(parsedDraft.metadata?.suggestedRisks || []);
            setSophieMandatoryChecklists(
              parsedDraft.metadata?.mandatoryChecklists || [],
            );
            setDraftPendingOfflineSync(
              parsedDraft.metadata?.pendingOfflineSync || null,
            );
            setDraftRestored(true);
          } else {
            const initialMetadata = createAprDraftMetadata();
            setPersistedSignatures({});
            setSignatures({});
            setDraftId(initialMetadata.draftId);
            setSophieSuggestedRisks([]);
            setSophieMandatoryChecklists([]);
            setDraftPendingOfflineSync(null);

            const defaultAprPage = await aprsService.findPaginated({
              page: 1,
              limit: 20,
              companyId: userCompanyId || undefined,
              isModeloPadrao: true,
            });
            if (cancelled) {
              return;
            }

            const defaultAprItem = defaultAprPage.data[0];

            if (defaultAprItem) {
              const defaultApr = await aprsService.findOne(defaultAprItem.id);
              if (cancelled) {
                return;
              }

              companySeedId = defaultApr.company_id || companySeedId;
              setValue("company_id", defaultApr.company_id || "");
              setValue("titulo", defaultApr.titulo);
              setValue("descricao", defaultApr.descricao || "");
              setValue("tipo_atividade", defaultApr.tipo_atividade || "");
              setValue("frente_trabalho", defaultApr.frente_trabalho || "");
              setValue("area_risco", defaultApr.area_risco || "");
              setValue("turno", defaultApr.turno || "");
              setValue(
                "local_execucao_detalhado",
                defaultApr.local_execucao_detalhado || "",
              );
              setValue(
                "responsavel_tecnico_nome",
                defaultApr.responsavel_tecnico_nome || "",
              );
              setValue(
                "responsavel_tecnico_registro",
                defaultApr.responsavel_tecnico_registro || "",
              );
              setValue(
                "activities",
                (defaultApr.activities || []).map((activity) => activity.id),
              );
              setValue(
                "risks",
                (defaultApr.risks || []).map((risk) => risk.id),
              );
              setValue(
                "epis",
                (defaultApr.epis || []).map((epi) => epi.id),
              );
              setValue(
                "tools",
                (defaultApr.tools || []).map((tool) => tool.id),
              );
              setValue(
                "machines",
                (defaultApr.machines || []).map((machine) => machine.id),
              );
              setValue(
                "participants",
                (defaultApr.participants || []).map(
                  (participant) => participant.id,
                ),
              );
              replaceRisk(
                defaultApr.risk_items && defaultApr.risk_items.length > 0
                  ? defaultApr.risk_items.map((item) =>
                      mapPersistedRiskItemToFormRow(item),
                    )
                  : defaultApr.itens_risco && defaultApr.itens_risco.length > 0
                    ? defaultApr.itens_risco.map((item) =>
                        normalizeRiskRow(item),
                      )
                    : [],
              );
              setActivities(dedupeById(defaultApr.activities || []));
              setRisks(dedupeById(defaultApr.risks || []));
              setEpis(dedupeById(defaultApr.epis || []));
              setTools(dedupeById(defaultApr.tools || []));
              setMachines(dedupeById(defaultApr.machines || []));
              setSites(dedupeById(defaultApr.site ? [defaultApr.site] : []));
              setUsers(
                dedupeById([
                  ...(defaultApr.elaborador ? [defaultApr.elaborador] : []),
                  ...(defaultApr.participants || []),
                  ...(defaultApr.auditado_por ? [defaultApr.auditado_por] : []),
                ]),
              );
            }
          }
        }

        await loadCompanies(companySeedId);
      } catch (error) {
        if (!cancelled) {
          logger.error("Erro ao carregar dados:", error);
          toast.error("Erro ao carregar dados para o formulário.");
        }
      } finally {
        if (cancelled) {
          return;
        }
        if (!timelineLoadStarted) {
          setLoadingTimeline(false);
        }
        setFetching(false);
      }
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, [
    canViewSignatures,
    draftStorageKey,
    getValuesRef,
    id,
    legacyDraftStorageKey,
    replaceRisk,
    reset,
    setActivities,
    setAprEvidences,
    setAprLogs,
    setCompanies,
    setCurrentApr,
    setCurrentStep,
    setDraftId,
    setDraftPendingOfflineSync,
    setDraftRestored,
    setDraftSecurityNotice,
    setEpis,
    setFetching,
    setLoadingTimeline,
    setMachines,
    setPersistedSignatures,
    setRisks,
    setSignatures,
    setSites,
    setSophieMandatoryChecklists,
    setSophieSuggestedRisks,
    setTools,
    setUsers,
    setValue,
    setVersionHistory,
    userCompanyId,
    userProfileName,
  ]);
}
