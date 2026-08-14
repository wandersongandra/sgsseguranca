"use client";

import { useState, useEffect } from "react";
import { ddsService, type Dds } from "@/services/ddsService";
import {
  ModalFrame,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@/components/ui/modal-frame";
import { Button } from "@/components/ui/button";
import { Search, BookOpen, Loader2 } from "lucide-react";
import { safeToLocaleDateString } from "@/lib/date/safeFormat";
import { logger } from "@/lib/logger";

interface DdsThemeLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (theme: Dds) => void;
}

export function DdsThemeLibraryModal({
  isOpen,
  onClose,
  onSelect,
}: DdsThemeLibraryModalProps) {
  const [loading, setLoading] = useState(true);
  const [themes, setThemes] = useState<Dds[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!isOpen) return;

    async function loadThemes() {
      try {
        setLoading(true);
        const response = await ddsService.findPaginated({
          kind: "model",
          limit: 50,
        });
        setThemes(response.data);
      } catch (error) {
        logger.error("Erro ao carregar biblioteca de temas:", error);
      } finally {
        setLoading(false);
      }
    }

    loadThemes();
  }, [isOpen]);

  const filteredThemes = themes.filter((theme) =>
    theme.tema.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} shellClassName="max-w-2xl">
      <ModalHeader
        title="Biblioteca de Temas"
        description="Escolha um tema pré-definido para agilizar o preenchimento do seu DDS."
        icon={<BookOpen className="h-5 w-5 text-[var(--ds-color-action-primary)]" />}
        onClose={onClose}
      />
      <ModalBody>
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-color-text-muted)]" />
            <input
              type="text"
              placeholder="Buscar tema..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] py-2 pl-10 pr-3 text-sm focus:border-[var(--ds-color-action-primary)] focus:outline-none"
            />
          </div>

          <div className="max-h-[400px] overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ds-color-action-primary)]" />
              </div>
            ) : filteredThemes.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm text-[var(--ds-color-text-muted)]">
                  {search
                    ? "Nenhum tema encontrado para esta busca."
                    : "Nenhum tema modelo cadastrado para esta empresa ainda. Peça ao administrador para executar o seed de temas do DDS."}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {filteredThemes.map((theme) => (
                  <button
                    key={theme.id}
                    onClick={() => {
                      onSelect(theme);
                      onClose();
                    }}
                    className="flex flex-col rounded-lg border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-4 text-left transition-colors hover:border-[var(--ds-color-action-primary)] hover:bg-[var(--ds-color-action-primary)]/5"
                  >
                    <span className="font-semibold text-[var(--ds-color-text-primary)]">
                      {theme.tema}
                    </span>
                    {theme.conteudo && (
                      <p className="mt-1 line-clamp-2 text-xs text-[var(--ds-color-text-secondary)]">
                        {theme.conteudo}
                      </p>
                    )}
                    <div className="mt-3 flex items-center gap-3 text-[10px] uppercase tracking-wider text-[var(--ds-color-text-muted)]">
                      <span>Ref: {theme.document_code || "Modelo"}</span>
                      {theme.updated_at && (
                        <span>
                          Atualizado em:{" "}
                          {safeToLocaleDateString(theme.updated_at, "pt-BR")}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={onClose}>
          Fechar
        </Button>
      </ModalFooter>
    </ModalFrame>
  );
}
