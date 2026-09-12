import { useEffect, type Dispatch, type SetStateAction } from "react";
import { siteStore } from "@/lib/siteStore";
import { selectedTenantStore } from "@/lib/selectedTenantStore";
import { logger } from "@/lib/logger";
import type { UseFormSetValue } from "react-hook-form";
import { toast } from "sonner";

import {
  activitiesService,
  type Activity,
} from "@/services/activitiesService";
import { risksService, type Risk } from "@/services/risksService";
import { episService, type Epi } from "@/services/episService";
import { toolsService, type Tool } from "@/services/toolsService";
import {
  machinesService,
  type Machine,
} from "@/services/machinesService";
import { sitesService, type Site } from "@/services/sitesService";
import { usersService, type User } from "@/services/usersService";
import { companiesService, type Company } from "@/services/companiesService";

import type { AprFormData } from "../components/aprForm.schema";
import { dedupeById, isUuidLike } from "../components/aprFormUtils";

type AprCatalogUser = Pick<User, "id" | "company_id" | "site_id"> & {
  id?: string | null;
  company_id?: string | null;
  site_id?: string | null;
};

interface UseAprCatalogsOptions {
  id?: string;
  selectedCompanyId?: string;
  selectedSiteId?: string;
  user?: AprCatalogUser | null;
  setValue: UseFormSetValue<AprFormData>;
  setActivities: Dispatch<SetStateAction<Activity[]>>;
  setRisks: Dispatch<SetStateAction<Risk[]>>;
  setEpis: Dispatch<SetStateAction<Epi[]>>;
  setTools: Dispatch<SetStateAction<Tool[]>>;
  setMachines: Dispatch<SetStateAction<Machine[]>>;
  setSites: Dispatch<SetStateAction<Site[]>>;
  setUsers: Dispatch<SetStateAction<User[]>>;
  setCompanies: Dispatch<SetStateAction<Company[]>>;
}

function mergeTenantCatalog<T extends { id: string; company_id: string }>(
  selectedCompanyId: string,
  result: PromiseSettledResult<T[]>,
  label: string,
  failures: string[],
  setter: Dispatch<SetStateAction<T[]>>,
) {
  if (result.status === "fulfilled") {
    setter((prev) =>
      dedupeById([
        ...prev.filter((item) => item.company_id !== selectedCompanyId),
        ...result.value,
      ]),
    );
    return;
  }

  failures.push(label);
  logger.error("Erro ao carregar catálogo da APR: %s", label, result.reason);
}

export function useAprCatalogs({
  id,
  selectedCompanyId,
  selectedSiteId,
  user,
  setValue,
  setActivities,
  setRisks,
  setEpis,
  setTools,
  setMachines,
  setSites,
  setUsers,
  setCompanies,
}: UseAprCatalogsOptions) {
  // Achado real (auditoria): o estado `companies` no AprForm nunca era
  // populado em lugar nenhum do fluxo — o <select> "Empresa" ficava com
  // apenas o placeholder. Como um <select> nativo não consegue refletir um
  // valor via setValue() sem uma <option> correspondente, isso travava
  // silenciosamente o formulário no passo 1 para QUALQUER usuário (não só
  // fora do admin_geral): company_id ficava permanentemente vazio no DOM,
  // mesmo com o fallback de sessionStore/user.company_id funcionando.
  // companiesService.findAll() já trata corretamente usuário comum
  // (sintetiza a própria empresa a partir da sessão) vs admin_geral (lista
  // completa) — só faltava ser chamado aqui.
  useEffect(() => {
    let cancelled = false;

    async function loadCompanies() {
      try {
        const result = await companiesService.findAll();
        if (cancelled) return;
        setCompanies(result);
      } catch (error) {
        if (cancelled) return;
        logger.error("Erro ao carregar empresas para a APR:", error);
        toast.error("Não foi possível carregar a lista de empresas.");
      }
    }

    void loadCompanies();

    return () => {
      cancelled = true;
    };
  }, [setCompanies]);

  useEffect(() => {
    let cancelled = false;

    async function loadOperationalCatalogs() {
      if (!selectedCompanyId) {
        if (cancelled) return;
        setActivities([]);
        setRisks([]);
        setEpis([]);
        return;
      }

      if (!isUuidLike(selectedCompanyId)) {
        if (cancelled) return;
        logger.warn(
          "Empresa inválida ao carregar catálogos operacionais da APR:",
          selectedCompanyId,
        );
        setActivities([]);
        setRisks([]);
        setEpis([]);
        toast.error(
          "A empresa selecionada para a APR está inválida. Recarregue a tela e selecione novamente.",
        );
        return;
      }

      try {
        const [activityResult, riskResult, epiResult] =
          await Promise.allSettled([
            activitiesService.findAll(selectedCompanyId),
            risksService.findAll(selectedCompanyId),
            episService.findAll(selectedCompanyId),
          ]);

        if (cancelled) {
          return;
        }

        const catalogFailures: string[] = [];
        mergeTenantCatalog(
          selectedCompanyId,
          activityResult,
          "atividades",
          catalogFailures,
          setActivities,
        );
        mergeTenantCatalog(
          selectedCompanyId,
          riskResult,
          "riscos",
          catalogFailures,
          setRisks,
        );
        mergeTenantCatalog(
          selectedCompanyId,
          epiResult,
          "EPIs",
          catalogFailures,
          setEpis,
        );

        if (catalogFailures.length > 0) {
          toast.error(
            "Alguns catálogos operacionais da APR não puderam ser carregados.",
            {
              description: `Falharam: ${catalogFailures.join(", ")}.`,
            },
          );
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        logger.error(
          "Erro inesperado ao carregar catálogos operacionais da APR:",
          error,
        );
        toast.error("Erro ao carregar catálogos operacionais da APR.");
      }
    }

    void loadOperationalCatalogs();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, setActivities, setEpis, setRisks]);

  useEffect(() => {
    let cancelled = false;

    async function loadEquipmentCatalogs() {
      if (!selectedCompanyId) {
        if (cancelled) return;
        setTools([]);
        setMachines([]);
        setSites([]);
        return;
      }

      if (!isUuidLike(selectedCompanyId)) {
        if (cancelled) return;
        logger.warn(
          "Empresa inválida ao carregar catálogos de apoio da APR:",
          selectedCompanyId,
        );
        setTools([]);
        setMachines([]);
        setSites([]);
        return;
      }

      try {
        const [siteResult, toolResult, machineResult] =
          await Promise.allSettled([
            sitesService.findAll(selectedCompanyId),
            toolsService.findAll(selectedCompanyId),
            machinesService.findAll(selectedCompanyId),
          ]);

        if (cancelled) {
          return;
        }

        const catalogFailures: string[] = [];
        mergeTenantCatalog(
          selectedCompanyId,
          siteResult,
          "obras",
          catalogFailures,
          setSites,
        );
        mergeTenantCatalog(
          selectedCompanyId,
          toolResult,
          "ferramentas",
          catalogFailures,
          setTools,
        );
        mergeTenantCatalog(
          selectedCompanyId,
          machineResult,
          "máquinas",
          catalogFailures,
          setMachines,
        );

        if (catalogFailures.length > 0) {
          toast.error(
            "Alguns catálogos de apoio da APR não puderam ser carregados.",
            {
              description: `Falharam: ${catalogFailures.join(", ")}.`,
            },
          );
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        logger.error(
          "Erro inesperado ao carregar catálogos de apoio da APR:",
          error,
        );
        toast.error("Erro ao carregar catálogos de apoio da APR.");
      }
    }

    void loadEquipmentCatalogs();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, setMachines, setSites, setTools]);

  useEffect(() => {
    let cancelled = false;
    const activeCompanyId = selectedTenantStore.get()?.companyId || selectedCompanyId;
    const activeSiteId = siteStore.get()?.siteId;

    async function loadUsersForSite() {
      if (!activeCompanyId || !activeSiteId) {
        if (cancelled) return;
        setUsers([]);
        return;
      }

      if (!isUuidLike(activeCompanyId) || !isUuidLike(activeSiteId)) {
        if (cancelled) return;
        setUsers([]);
        return;
      }

      try {
        const usersResult = await usersService.findAll(
          activeCompanyId,
          activeSiteId,
        );
        if (cancelled) {
          return;
        }
        setUsers(usersResult);
      } catch (error) {
        if (cancelled) {
          return;
        }
        logger.error("Erro ao carregar usuários da APR:", error);
        toast.error("Alguns responsáveis da APR não puderam ser carregados.");
      }
    }

    void loadUsersForSite();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, selectedSiteId, setUsers]);

  useEffect(() => {
    if (id || selectedCompanyId) return;
    const companyId = selectedTenantStore.get()?.companyId || user?.company_id;
    const activeSiteId = siteStore.get()?.siteId;
    if (!isUuidLike(companyId)) return;
    setValue("company_id", String(companyId));
    if (isUuidLike(activeSiteId)) {
      setValue("site_id", String(activeSiteId));
    }
    if (isUuidLike(user?.id)) {
      setValue("elaborador_id", String(user?.id));
      setValue("participants", [String(user?.id)]);
    }
  }, [
    id,
    selectedCompanyId,
    setValue,
    user?.company_id,
    user?.id,
    user?.site_id,
  ]);
}
