"use client";

import type { Dispatch, SetStateAction } from "react";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import type { Site } from "@/services/sitesService";
import type { User } from "@/services/usersService";
import { isUserVisibleForSite } from "@/lib/site-scoped-user-visibility";
import type {
  EquipamentoItem,
  MaoDeObraItem,
  MaterialItem,
  OcorrenciaItem,
  ServicoItem,
} from "@/services/rdosService";
import { cn } from "@/lib/utils";
import { RdoActivityEditorCard } from "@/components/rdos/RdoActivityEditorCard";
import type {
  PendingActivityPhoto,
  RdoFormState,
} from "@/components/rdos/rdo-modal-types";
import type { LucideIcon } from "lucide-react";
import {
  ModalBody,
  ModalFooter,
  ModalFrame,
  ModalHeader,
} from "@/components/ui/modal-frame";

type ModalStep = {
  label: string;
  icon: LucideIcon;
};

interface RdoEditorModalProps {
  open: boolean;
  editingId: string | null;
  currentStep: number;
  steps: ModalStep[];
  form: RdoFormState;
  setForm: Dispatch<SetStateAction<RdoFormState>>;
  sites: Site[];
  users: User[];
  saving: boolean;
  formInputClassName: string;
  formInputSmClassName: string;
  onClose: () => void;
  onSave: (options?: { printAfterSave?: boolean }) => void;
  setCurrentStep: Dispatch<SetStateAction<number>>;
  addMaoDeObra: () => void;
  removeMaoDeObra: (index: number) => void;
  updateMaoDeObra: (
    index: number,
    field: keyof MaoDeObraItem,
    value: string | number,
  ) => void;
  addEquipamento: () => void;
  removeEquipamento: (index: number) => void;
  updateEquipamento: (
    index: number,
    field: keyof EquipamentoItem,
    value: string | number,
  ) => void;
  addMaterial: () => void;
  removeMaterial: (index: number) => void;
  updateMaterial: (
    index: number,
    field: keyof MaterialItem,
    value: string | number,
  ) => void;
  addServico: () => void;
  removeServico: (index: number) => void;
  updateServico: (
    index: number,
    field: keyof ServicoItem,
    value: string | number | string[],
  ) => void;
  addOcorrencia: () => void;
  removeOcorrencia: (index: number) => void;
  updateOcorrencia: (
    index: number,
    field: keyof OcorrenciaItem,
    value: string,
  ) => void;
  getPendingActivityPhotos: (activityIndex: number) => PendingActivityPhoto[];
  onAddActivityPhotos: (
    activityIndex: number,
    files: FileList | null,
  ) => void;
  onRemoveActivityPhoto: (
    activityIndex: number,
    photoIndex: number,
    photo: string,
  ) => void;
  resolveActivityPhotoSrc: (photo: string) => string;
}

export function RdoEditorModal({
  open,
  editingId,
  currentStep,
  steps,
  form,
  setForm,
  sites,
  users,
  saving,
  formInputClassName,
  formInputSmClassName,
  onClose,
  onSave,
  setCurrentStep,
  addMaoDeObra,
  removeMaoDeObra,
  updateMaoDeObra,
  addEquipamento,
  removeEquipamento,
  updateEquipamento,
  addMaterial,
  removeMaterial,
  updateMaterial,
  addServico,
  removeServico,
  updateServico,
  addOcorrencia,
  removeOcorrencia,
  updateOcorrencia,
  getPendingActivityPhotos,
  onAddActivityPhotos,
  onRemoveActivityPhoto,
  resolveActivityPhotoSrc,
}: RdoEditorModalProps) {
  const ActiveIcon = steps[currentStep]?.icon;

  return (
    <ModalFrame
      isOpen={open}
      onClose={onClose}
      shellClassName="flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-5xl flex-col"
    >
        <ModalHeader
          title={editingId ? "Editar RDO" : "Novo Relatório Diário de Obra"}
          description={steps[currentStep]?.label ?? "Preencha os dados do relatório diário de obra"}
          icon={ActiveIcon ? <ActiveIcon className="h-5 w-5" /> : undefined}
          onClose={onClose}
        />

        <ModalBody className="min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="mb-6 flex items-center gap-2 overflow-x-auto pb-1">
            {steps.map((step, idx) => {
              const Icon = step.icon;
              return (
                <button
                  key={step.label}
                  type="button"
                  onClick={() => setCurrentStep(idx)}
                  className={cn(
                    "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                    idx === currentStep
                      ? "bg-[var(--ds-color-action-primary)] text-white"
                      : idx < currentStep
                        ? "bg-[color:var(--ds-color-success)]/10 text-[var(--ds-color-success)]"
                        : "bg-[var(--ds-color-surface-muted)] text-[var(--ds-color-text-secondary)]",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {step.label}
                </button>
              );
            })}
          </div>

          <div className="min-h-[28rem]">
            {currentStep === 0 && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor="rdo-data"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                    >
                      Data
                    </label>
                    <input
                      id="rdo-data"
                      type="date"
                      value={form.data}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, data: e.target.value }))
                      }
                      className={formInputClassName}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="rdo-site-id"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                    >
                      Obra / Setor
                    </label>
                    <select
                      id="rdo-site-id"
                      value={form.site_id}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          site_id: e.target.value,
                          responsavel_id:
                            f.responsavel_id &&
                            e.target.value &&
                            users.some(
                              (user) =>
                                user.id === f.responsavel_id &&
                                (!user.site_id || user.site_id === e.target.value),
                            )
                              ? f.responsavel_id
                              : "",
                        }))
                      }
                      className={formInputClassName}
                    >
                      <option value="">Selecionar obra...</option>
                      {sites.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.nome}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="rdo-responsavel-id"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                    >
                      Responsável
                    </label>
                    <select
                      id="rdo-responsavel-id"
                      value={form.responsavel_id}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          responsavel_id: e.target.value,
                        }))
                      }
                      className={formInputClassName}
                    >
                      <option value="">Selecionar responsável...</option>
                      {users
                        .filter((u) =>
                          isUserVisibleForSite(u, u.company_id || "", form.site_id),
                        )
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.nome}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {currentStep === 1 && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="rdo-clima-manha"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                    >
                      Clima manhã
                    </label>
                    <select
                      id="rdo-clima-manha"
                      value={form.clima_manha}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          clima_manha: e.target.value,
                        }))
                      }
                      className={formInputClassName}
                    >
                      <option value="">Selecionar...</option>
                      <option value="ensolarado">Ensolarado</option>
                      <option value="nublado">Nublado</option>
                      <option value="chuvoso">Chuvoso</option>
                      <option value="parcialmente_nublado">
                        Parcialmente Nublado
                      </option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="rdo-clima-tarde"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                    >
                      Clima tarde
                    </label>
                    <select
                      id="rdo-clima-tarde"
                      value={form.clima_tarde}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          clima_tarde: e.target.value,
                        }))
                      }
                      className={formInputClassName}
                    >
                      <option value="">Selecionar...</option>
                      <option value="ensolarado">Ensolarado</option>
                      <option value="nublado">Nublado</option>
                      <option value="chuvoso">Chuvoso</option>
                      <option value="parcialmente_nublado">
                        Parcialmente Nublado
                      </option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="rdo-temperatura-min"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                    >
                      Temp. mín (°C)
                    </label>
                    <input
                      id="rdo-temperatura-min"
                      type="number"
                      value={form.temperatura_min}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          temperatura_min: e.target.value,
                        }))
                      }
                      className={formInputClassName}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="rdo-temperatura-max"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                    >
                      Temp. máx (°C)
                    </label>
                    <input
                      id="rdo-temperatura-max"
                      type="number"
                      value={form.temperatura_max}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          temperatura_max: e.target.value,
                        }))
                      }
                      className={formInputClassName}
                    />
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="rdo-condicao-terreno"
                    className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                  >
                    Condição do terreno
                  </label>
                  <input
                    id="rdo-condicao-terreno"
                    type="text"
                    value={form.condicao_terreno}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        condicao_terreno: e.target.value,
                      }))
                    }
                    placeholder="Ex: seco, molhado, enlameado..."
                    className={formInputClassName}
                  />
                </div>
              </div>
            )}

            {currentStep === 2 && (
              <div className="space-y-3">
                {form.mao_de_obra.map((item, i) => (
                  <div
                    key={item.__rowKey}
                    className="grid grid-cols-1 items-end gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] p-3 sm:grid-cols-2 lg:grid-cols-4"
                  >
                    <div>
                      <label htmlFor={`rdo-work-role-${i}`} className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Função
                      </label>
                      <input
                        id={`rdo-work-role-${i}`}
                        type="text"
                        aria-label={`Função ${i + 1}`}
                        value={item.funcao}
                        onChange={(e) =>
                          updateMaoDeObra(i, "funcao", e.target.value)
                        }
                        className={formInputSmClassName}
                        placeholder="Ex: Pedreiro"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Qtd
                      </label>
                      <input
                        type="number"
                        aria-label={`Quantidade de trabalhadores da função ${i + 1}${item.funcao ? `, ${item.funcao}` : ""}`}
                        value={item.quantidade}
                        min={1}
                        onChange={(e) =>
                          updateMaoDeObra(
                            i,
                            "quantidade",
                            Number(e.target.value),
                          )
                        }
                        className={formInputSmClassName}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Turno
                      </label>
                      <select
                        aria-label={`Turno de trabalho da função ${i + 1}${item.funcao ? `, ${item.funcao}` : ""}`}
                        value={item.turno}
                        onChange={(e) =>
                          updateMaoDeObra(i, "turno", e.target.value)
                        }
                        className={formInputSmClassName}
                      >
                        <option value="manha">Manhã</option>
                        <option value="tarde">Tarde</option>
                        <option value="noite">Noite</option>
                      </select>
                    </div>
                    <div className="flex items-end gap-1">
                      <div className="flex-1">
                        <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                          Horas
                        </label>
                        <input
                          type="number"
                          aria-label={`Horas trabalhadas da função ${i + 1}${item.funcao ? `, ${item.funcao}` : ""}`}
                          value={item.horas}
                          min={0}
                          max={24}
                          onChange={(e) =>
                            updateMaoDeObra(i, "horas", Number(e.target.value))
                          }
                          className={formInputSmClassName}
                        />
                      </div>
                      <button
                        type="button"
                        aria-label={`Remover função ${i + 1}${item.funcao ? `, ${item.funcao}` : ""}`}
                        onClick={() => removeMaoDeObra(i)}
                        className="mb-0.5 rounded p-1 text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addMaoDeObra}
                  className="flex items-center gap-1 text-sm text-[var(--ds-color-action-primary)] hover:underline"
                >
                  <Plus className="h-4 w-4" /> Adicionar função
                </button>
              </div>
            )}

            {currentStep === 3 && (
              <div className="space-y-3">
                {form.equipamentos.map((item, i) => (
                  <div
                    key={item.__rowKey}
                    className="grid grid-cols-1 items-end gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] p-3 sm:grid-cols-2 lg:grid-cols-4"
                  >
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Equipamento
                      </label>
                      <input
                        type="text"
                        aria-label={`Equipamento ${i + 1}`}
                        value={item.nome}
                        onChange={(e) =>
                          updateEquipamento(i, "nome", e.target.value)
                        }
                        className={formInputSmClassName}
                        placeholder="Ex: Betoneira"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Qtd
                      </label>
                      <input
                        type="number"
                        aria-label={`Quantidade do equipamento ${i + 1}${item.nome ? `, ${item.nome}` : ""}`}
                        value={item.quantidade}
                        min={1}
                        onChange={(e) =>
                          updateEquipamento(
                            i,
                            "quantidade",
                            Number(e.target.value),
                          )
                        }
                        className={formInputSmClassName}
                      />
                    </div>
                    <div className="flex items-end gap-1">
                      <div className="flex-1">
                        <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                          H. trabalhadas
                        </label>
                        <input
                          type="number"
                          aria-label={`Horas trabalhadas pelo equipamento ${i + 1}${item.nome ? `, ${item.nome}` : ""}`}
                          value={item.horas_trabalhadas}
                          min={0}
                          onChange={(e) =>
                            updateEquipamento(
                              i,
                              "horas_trabalhadas",
                              Number(e.target.value),
                            )
                          }
                          className={formInputSmClassName}
                        />
                      </div>
                      <button
                        type="button"
                        aria-label={`Remover equipamento ${i + 1}${item.nome ? `, ${item.nome}` : ""}`}
                        onClick={() => removeEquipamento(i)}
                        className="mb-0.5 rounded p-1 text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addEquipamento}
                  className="flex items-center gap-1 text-sm text-[var(--ds-color-action-primary)] hover:underline"
                >
                  <Plus className="h-4 w-4" /> Adicionar equipamento
                </button>
              </div>
            )}

            {currentStep === 4 && (
              <div className="space-y-3">
                {form.materiais_recebidos.map((item, i) => (
                  <div
                    key={item.__rowKey}
                    className="grid grid-cols-1 items-end gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] p-3 sm:grid-cols-2 lg:grid-cols-4"
                  >
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Descrição
                      </label>
                      <input
                        type="text"
                        aria-label={`Descrição do material ${i + 1}`}
                        value={item.descricao}
                        onChange={(e) =>
                          updateMaterial(i, "descricao", e.target.value)
                        }
                        className={formInputSmClassName}
                        placeholder="Ex: Cimento CP-II"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Unidade
                      </label>
                      <input
                        type="text"
                        aria-label={`Unidade do material ${i + 1}`}
                        value={item.unidade}
                        onChange={(e) =>
                          updateMaterial(i, "unidade", e.target.value)
                        }
                        className={formInputSmClassName}
                        placeholder="sc, m³, kg"
                      />
                    </div>
                    <div className="flex items-end gap-1">
                      <div className="flex-1">
                        <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                          Quantidade
                        </label>
                        <input
                          type="number"
                          aria-label={`Quantidade do material ${i + 1}${item.descricao ? `, ${item.descricao}` : ""}`}
                          value={item.quantidade}
                          min={0}
                          onChange={(e) =>
                            updateMaterial(
                              i,
                              "quantidade",
                              Number(e.target.value),
                            )
                          }
                          className={formInputSmClassName}
                        />
                      </div>
                      <button
                        type="button"
                        aria-label={`Remover material ${i + 1}${item.descricao ? `, ${item.descricao}` : ""}`}
                        onClick={() => removeMaterial(i)}
                        className="mb-0.5 rounded p-1 text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addMaterial}
                  className="flex items-center gap-1 text-sm text-[var(--ds-color-action-primary)] hover:underline"
                >
                  <Plus className="h-4 w-4" /> Adicionar material
                </button>
              </div>
            )}

            {currentStep === 5 && (
              <div className="space-y-3">
                {form.servicos_executados.map((item, i) => (
                  <RdoActivityEditorCard
                    key={item.__rowKey}
                    activityIndex={i}
                    item={item}
                    pendingPhotos={getPendingActivityPhotos(i)}
                    totalPhotoCount={(item.fotos?.length ?? 0) + getPendingActivityPhotos(i).length}
                    formInputClassName={formInputClassName}
                    onRemoveActivity={() => removeServico(i)}
                    onUpdateDescription={(value) =>
                      updateServico(i, "descricao", value)
                    }
                    onUpdatePercentual={(value) =>
                      updateServico(i, "percentual_concluido", value)
                    }
                    onUpdateObservacao={(value) =>
                      updateServico(i, "observacao", value)
                    }
                    onAddPhotos={(files) => onAddActivityPhotos(i, files)}
                    onRemoveGovernedPhoto={(photoIndex, photo) =>
                      onRemoveActivityPhoto(i, photoIndex, photo)
                    }
                    onRemovePendingPhoto={(photoIndex, previewUrl) =>
                      onRemoveActivityPhoto(i, photoIndex, previewUrl)
                    }
                    resolveActivityPhotoSrc={resolveActivityPhotoSrc}
                  />
                ))}
                <button
                  type="button"
                  onClick={addServico}
                  className="flex items-center gap-1 text-sm text-[var(--ds-color-action-primary)] hover:underline"
                >
                  <Plus className="h-4 w-4" /> Adicionar serviço
                </button>
              </div>
            )}

            {currentStep === 6 && (
              <div className="space-y-4">
                {form.ocorrencias.map((item, i) => (
                  <div
                    key={item.__rowKey}
                    className="grid gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)] p-3 md:grid-cols-[180px_minmax(0,1fr)_120px_auto]"
                  >
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Tipo
                      </label>
                      <select
                        aria-label={`Tipo da ocorrência ${i + 1}`}
                        value={item.tipo}
                        onChange={(e) =>
                          updateOcorrencia(i, "tipo", e.target.value)
                        }
                        className={formInputSmClassName}
                      >
                        <option value="acidente">Acidente</option>
                        <option value="incidente">Incidente</option>
                        <option value="visita">Visita</option>
                        <option value="paralisacao">Paralisação</option>
                        <option value="outro">Outro</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Descrição
                      </label>
                      <input
                        type="text"
                        aria-label={`Descrição da ocorrência ${i + 1}`}
                        value={item.descricao}
                        onChange={(e) =>
                          updateOcorrencia(i, "descricao", e.target.value)
                        }
                        className={formInputSmClassName}
                        placeholder="Descreva a ocorrência"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[var(--ds-color-text-secondary)]">
                        Hora
                      </label>
                      <input
                        type="time"
                        aria-label={`Hora da ocorrência ${i + 1}`}
                        value={item.hora ?? ""}
                        onChange={(e) =>
                          updateOcorrencia(i, "hora", e.target.value)
                        }
                        className={formInputSmClassName}
                      />
                    </div>
                    <div className="flex items-end justify-end">
                      <button
                        type="button"
                        aria-label={`Remover ocorrência ${i + 1}${item.descricao ? `, ${item.descricao}` : ""}`}
                        onClick={() => removeOcorrencia(i)}
                        className="rounded p-1 text-[var(--ds-color-danger)] hover:bg-[color:var(--ds-color-danger)]/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addOcorrencia}
                  className="flex items-center gap-1 text-sm text-[var(--ds-color-action-primary)] hover:underline"
                >
                  <Plus className="h-4 w-4" /> Adicionar ocorrência
                </button>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] p-4">
                    <label className="flex items-center gap-2 text-sm font-medium text-[var(--ds-color-text-primary)]">
                      <input
                        type="checkbox"
                        checked={form.houve_acidente}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            houve_acidente: e.target.checked,
                          }))
                        }
                      />
                      Houve acidente
                    </label>
                    <label className="flex items-center gap-2 text-sm font-medium text-[var(--ds-color-text-primary)]">
                      <input
                        type="checkbox"
                        checked={form.houve_paralisacao}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            houve_paralisacao: e.target.checked,
                          }))
                        }
                      />
                      Houve paralisação
                    </label>
                    <div>
                      <label
                        htmlFor="rdo-motivo-paralisacao"
                        className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                      >
                        Motivo da paralisação
                      </label>
                      <input
                        id="rdo-motivo-paralisacao"
                        type="text"
                        value={form.motivo_paralisacao}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            motivo_paralisacao: e.target.value,
                          }))
                        }
                        className={formInputClassName}
                        placeholder="Se aplicável..."
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label
                        htmlFor="rdo-observacoes"
                        className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                      >
                        Observações
                      </label>
                      <textarea
                        id="rdo-observacoes"
                        value={form.observacoes}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            observacoes: e.target.value,
                          }))
                        }
                        rows={5}
                        className={formInputClassName}
                        placeholder="Observações relevantes do dia..."
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="rdo-programa-amanha"
                        className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--ds-color-text-secondary)]"
                      >
                        Programa para amanhã
                      </label>
                      <textarea
                        id="rdo-programa-amanha"
                        value={form.programa_servicos_amanha}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            programa_servicos_amanha: e.target.value,
                          }))
                        }
                        rows={4}
                        className={formInputClassName}
                        placeholder="Serviços planejados para o próximo dia..."
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ModalBody>

        <ModalFooter className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] px-4 py-2 text-sm text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] hover:text-[var(--ds-color-text-primary)] motion-safe:transition-colors"
          >
            Cancelar
          </button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {currentStep > 0 && (
              <button
                type="button"
                onClick={() => setCurrentStep((step) => step - 1)}
                className="flex items-center gap-1 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] px-3 py-2 text-sm text-[var(--ds-color-text-secondary)] hover:bg-[color:var(--ds-color-surface-muted)] motion-safe:transition-colors"
              >
                <ChevronLeft className="h-4 w-4" /> Anterior
              </button>
            )}
            {currentStep < steps.length - 1 ? (
              <button
                type="button"
                onClick={() => setCurrentStep((step) => step + 1)}
                className="flex items-center gap-1 rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ds-color-action-primary-hover)] motion-safe:transition-colors"
              >
                Próximo <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  data-offline-action="write"
                  onClick={() => onSave({ printAfterSave: true })}
                  disabled={saving}
                  className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] px-5 py-2 text-sm font-medium text-[var(--ds-color-text-primary)] hover:bg-[color:var(--ds-color-surface-muted)] disabled:opacity-50 motion-safe:transition-colors"
                >
                  {saving
                    ? "Salvando..."
                    : editingId
                      ? "Salvar e imprimir"
                      : "Criar e imprimir"}
                </button>
                <button
                  type="button"
                  data-offline-action="write"
                  onClick={() => onSave()}
                  disabled={saving}
                  className="rounded-[var(--ds-radius-md)] bg-[var(--ds-color-action-primary)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--ds-color-action-primary-hover)] disabled:opacity-50 motion-safe:transition-colors"
                >
                  {saving
                    ? "Salvando..."
                    : editingId
                      ? "Salvar alterações"
                      : "Criar RDO"}
                </button>
              </>
            )}
          </div>
        </ModalFooter>
    </ModalFrame>
  );
}
