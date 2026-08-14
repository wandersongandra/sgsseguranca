"use client";

import axios from "axios";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  GovernedDocumentVideoAccessResponse,
  GovernedDocumentVideoAttachment,
  GovernedDocumentVideoMutationResponse,
} from "@/lib/videos/documentVideos";
import { logger } from "@/lib/logger";

type UseDocumentVideosOptions = {
  documentId?: string | null;
  enabled?: boolean;
  /** Invalida respostas e feedback quando o consumidor troca de tenant/documento. */
  operationKey: string;
  loadVideos: (documentId: string) => Promise<GovernedDocumentVideoAttachment[]>;
  uploadVideo: (
    documentId: string,
    file: File,
  ) => Promise<GovernedDocumentVideoMutationResponse>;
  removeVideo: (
    documentId: string,
    attachmentId: string,
  ) => Promise<GovernedDocumentVideoMutationResponse>;
  getVideoAccess: (
    documentId: string,
    attachmentId: string,
  ) => Promise<GovernedDocumentVideoAccessResponse>;
  labels?: {
    loadError?: string;
    uploadSuccess?: string;
    uploadError?: string;
    removeSuccess?: string;
    removeError?: string;
    accessError?: string;
  };
};

function extractVideoApiMessage(error: unknown): string | undefined {
  const normalize = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = normalize(item);
        if (normalized) {
          return normalized;
        }
      }
      return undefined;
    }

    if (value && typeof value === "object") {
      const objectValue = value as Record<string, unknown>;
      return (
        normalize(objectValue.message) ||
        normalize(objectValue.error) ||
        normalize(objectValue.details)
      );
    }

    return undefined;
  };

  if (axios.isAxiosError(error)) {
    return normalize(error.response?.data);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return undefined;
}

export function useDocumentVideos({
  documentId,
  enabled = true,
  operationKey,
  loadVideos,
  uploadVideo,
  removeVideo,
  getVideoAccess,
  labels,
}: UseDocumentVideosOptions) {
  const [attachments, setAttachments] = useState<GovernedDocumentVideoAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const operationGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const operationContextRef = useRef({ documentId, enabled, operationKey });
  const previousContext = operationContextRef.current;
  if (
    previousContext.documentId !== documentId ||
    previousContext.enabled !== enabled ||
    previousContext.operationKey !== operationKey
  ) {
    operationContextRef.current = { documentId, enabled, operationKey };
    operationGenerationRef.current += 1;
  }
  const isCurrent = useCallback(
    (generation: number) =>
      mountedRef.current && generation === operationGenerationRef.current,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setAttachments([]);
    setLoading(false);
    setUploading(false);
    setRemovingId(null);
  }, [documentId, enabled, operationKey]);

  const refresh = useCallback(async () => {
    const generation = operationGenerationRef.current;
    const isRefreshCurrent = () => isCurrent(generation);
    if (!enabled || !documentId) {
      setAttachments([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const result = await loadVideos(documentId);
      if (!isRefreshCurrent()) return;
      setAttachments(result);
    } catch (error) {
      if (!isRefreshCurrent()) return;
      logger.error("Erro ao carregar vídeos governados:", error);
      toast.error(
        extractVideoApiMessage(error) ||
          labels?.loadError ||
          "Não foi possível carregar os vídeos anexados.",
      );
    } finally {
      if (isRefreshCurrent()) setLoading(false);
    }
  }, [documentId, enabled, isCurrent, labels?.loadError, loadVideos]);

  useEffect(() => {
    if (operationContextRef.current.operationKey !== operationKey) return;
    void refresh();
  }, [operationKey, refresh]);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!documentId) {
        toast.info("Salve o documento antes de anexar vídeos governados.");
        return null;
      }

      const generation = operationGenerationRef.current;
      try {
        setUploading(true);
        const result = await uploadVideo(documentId, file);
        if (!isCurrent(generation)) return null;
        setAttachments(result.attachments);
        toast.success(labels?.uploadSuccess || result.message || "Vídeo anexado com sucesso.");
        return result;
      } catch (error) {
        if (!isCurrent(generation)) return null;
        logger.error("Erro ao enviar vídeo governado:", error);
        toast.error(
          extractVideoApiMessage(error) ||
            labels?.uploadError ||
            "Não foi possível anexar o vídeo.",
        );
        throw error;
      } finally {
        if (isCurrent(generation)) setUploading(false);
      }
    },
    [documentId, isCurrent, labels?.uploadError, labels?.uploadSuccess, uploadVideo],
  );

  const handleRemove = useCallback(
    async (attachment: GovernedDocumentVideoAttachment) => {
      if (!documentId) {
        return null;
      }

      const generation = operationGenerationRef.current;
      try {
        setRemovingId(attachment.id);
        const result = await removeVideo(documentId, attachment.id);
        if (!isCurrent(generation)) return null;
        setAttachments(result.attachments);
        toast.success(labels?.removeSuccess || result.message || "Vídeo removido.");
        return result;
      } catch (error) {
        if (!isCurrent(generation)) return null;
        logger.error("Erro ao remover vídeo governado:", error);
        toast.error(
          extractVideoApiMessage(error) ||
            labels?.removeError ||
            "Não foi possível remover o vídeo.",
        );
        throw error;
      } finally {
        if (isCurrent(generation)) setRemovingId(null);
      }
    },
    [documentId, isCurrent, labels?.removeError, labels?.removeSuccess, removeVideo],
  );

  const resolveAccess = useCallback(
    async (attachment: GovernedDocumentVideoAttachment) => {
      if (!documentId) {
        return null;
      }

      const generation = operationGenerationRef.current;
      try {
        const result = await getVideoAccess(documentId, attachment.id);
        if (!isCurrent(generation)) return null;
        if (!result.url && result.message) {
          toast.warning(result.message);
        }
        return result;
      } catch (error) {
        if (!isCurrent(generation)) return null;
        logger.error("Erro ao resolver acesso ao vídeo governado:", error);
        toast.error(
          extractVideoApiMessage(error) ||
            labels?.accessError ||
            "Não foi possível abrir o vídeo.",
        );
        throw error;
      }
    },
    [documentId, getVideoAccess, isCurrent, labels?.accessError],
  );

  return {
    attachments,
    loading,
    uploading,
    removingId,
    refresh,
    handleUpload,
    handleRemove,
    resolveAccess,
  };
}
