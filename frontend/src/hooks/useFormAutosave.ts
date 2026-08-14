"use client";

import { useEffect, useRef, useState } from "react";
import { secureOfflineDB } from "@/lib/offline-db-secure";
import { logger } from "@/lib/logger";
import { toast } from "sonner";

interface UseFormAutosaveOptions<T> {
  formId: string;
  currentValues: T;
  onRestore: (draft: T) => void;
  enabled?: boolean;
}

export function useFormAutosave<T>({
  formId,
  currentValues,
  onRestore,
  enabled = true,
}: UseFormAutosaveOptions<T>) {
  const [hasDraft, setHasDraft] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const draftRef = useRef<T | null>(null);
  const isFirstMount = useRef(true);

  const draftKey = `sgs.draft.${formId}`;

  // Verifica se há rascunho salvo no IndexedDB seguro no mount
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      draftRef.current = null;
      isFirstMount.current = true;
      setHasDraft(false);
      return () => {
        cancelled = true;
      };
    }

    draftRef.current = null;
    isFirstMount.current = true;
    setHasDraft(false);

    async function checkDraft() {
      try {
        const savedDraft = await secureOfflineDB.get<T>("sgs-cache", draftKey);
        if (savedDraft && !cancelled) {
          draftRef.current = savedDraft;
          setHasDraft(true);
        }
      } catch (err) {
        logger.warn("Erro ao buscar rascunho de formulario:", err);
      }
    }
    void checkDraft();
    return () => {
      cancelled = true;
    };
  }, [draftKey, enabled]);

  // Hook de Debounce para salvar rascunhos de forma assíncrona ao mudar os valores
  useEffect(() => {
    // Evita salvar no primeiro render/mount
    if (!enabled) {
      isFirstMount.current = true;
      return;
    }
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }

    setSaveStatus("saving");
    const timer = setTimeout(async () => {
      try {
        await secureOfflineDB.set("sgs-cache", draftKey, currentValues);
        setSaveStatus("saved");
        // Voltar ao estado idle após um tempo visual
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch (err) {
        logger.warn("Erro ao gravar rascunho automaticamente:", err);
        setSaveStatus("idle");
      }
    }, 1500); // 1.5s debounce

    return () => clearTimeout(timer);
  }, [currentValues, draftKey, enabled]);

  // Restaura o rascunho na tela
  const restoreDraft = () => {
    if (draftRef.current) {
      onRestore(draftRef.current);
      setHasDraft(false);
      toast.success("Rascunho recuperado com sucesso!");
    }
  };

  // Descarta o rascunho salvo
  const discardDraft = async () => {
    try {
      await secureOfflineDB.del("sgs-cache", draftKey);
      setHasDraft(false);
      draftRef.current = null;
      toast.info("Rascunho descartado.");
    } catch (err) {
      logger.warn("Erro ao descartar rascunho:", err);
    }
  };

  // Limpa o rascunho ao finalizar/enviar o formulário com sucesso
  const clearDraft = async () => {
    try {
      await secureOfflineDB.del("sgs-cache", draftKey);
      setHasDraft(false);
      draftRef.current = null;
    } catch (err) {
      logger.warn("Erro ao limpar rascunho:", err);
    }
  };

  return {
    hasDraft,
    saveStatus,
    restoreDraft,
    discardDraft,
    clearDraft,
  };
}
