'use client';

import dynamic from 'next/dynamic';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Mail, Printer, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { InlineLoadingState } from '@/components/ui/state';
import {
  didsService,
  type Did,
  type DidPdfAccess,
  type DidMutationInput,
} from '@/services/didsService';
import { getFormErrorMessage } from '@/lib/error-handler';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';
import { usePermissions } from '@/hooks/usePermissions';
import { Permission } from '@/lib/permissions';
import { isAdminGeralAccount } from '@/lib/auth-session-state';
import { getDidReadOnlyReason } from '../../app/dashboard/dids/didMeta';
import { didSchema, type DidFormData } from '../../app/dashboard/dids/didForm.schema';
import { useDidCatalogs } from '../../app/dashboard/dids/useDidCatalogs';
import {
  DidContextSection,
  DidFormPageShell,
  DidOperationalSection,
  DidParticipantsSection,
} from '../../app/dashboard/dids/components/DidFormSections';
import { openPdfForPrint } from '@/lib/print-utils';
import { base64ToPdfBlob, base64ToPdfFile } from '@/lib/pdf/pdfFile';

const SendMailModal = dynamic(
  () => import('@/components/SendMailModal').then((module) => module.SendMailModal),
  { ssr: false },
);
const loadDidPdfGenerator = () => import('@/lib/pdf/didGenerator');

type DidFormProps = {
  id?: string;
};

function getInitialCompanyId() {
  const selectedTenantCompanyId = selectedTenantStore.get()?.companyId || null;
  const sessionCompanyId = sessionStore.get()?.companyId || null;
  return selectedTenantCompanyId || sessionCompanyId || '';
}

export function DidForm({ id }: DidFormProps) {
  const router = useRouter();
  const { hasPermission } = usePermissions();
  const canManageDids = hasPermission(Permission.CAN_MANAGE_DIDS);
  const [fetching, setFetching] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentDid, setCurrentDid] = useState<Did | null>(null);
  const [isMailModalOpen, setIsMailModalOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{
    name: string;
    filename: string;
    base64?: string;
    storedDocument?: {
      documentId: string;
      documentType: string;
    };
  } | null>(null);
  const isAdminGeral = isAdminGeralAccount(sessionStore.get());

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isValid, isSubmitting },
  } = useForm<DidFormData>({
    resolver: zodResolver(didSchema),
    mode: 'onBlur',
    defaultValues: {
      titulo: '',
      descricao: '',
      data: new Date().toISOString().split('T')[0],
      turno: '',
      frente_trabalho: '',
      atividade_principal: '',
      atividades_planejadas: '',
      riscos_operacionais: '',
      controles_planejados: '',
      epi_epc_aplicaveis: '',
      observacoes: '',
      company_id: getInitialCompanyId(),
      site_id: '',
      responsavel_id: '',
      participants: [],
    },
  });

  const selectedCompanyId = watch('company_id');
  const selectedSiteId = watch('site_id');
  const selectedResponsibleId = watch('responsavel_id');
  const selectedParticipantIds = watch('participants') || [];
  const selectedTurno = watch('turno');
  const selectedTitle = watch('titulo');
  const selectedMainActivity = watch('atividade_principal');
  const initialCompanyId = useMemo(() => getInitialCompanyId(), []);
  const { companies, filteredSites, filteredUsers } = useDidCatalogs({
    selectedCompanyId,
    selectedSiteId,
    selectedResponsibleId,
    selectedParticipantIds,
    initialCompanyId,
    isAdminGeral,
    setValue,
  });

  const isReadOnly =
    Boolean(currentDid?.pdf_file_key) || currentDid?.status === 'arquivado';
  const readOnlyMessage = getDidReadOnlyReason(currentDid);
  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) || null,
    [companies, selectedCompanyId],
  );
  const selectedSite = useMemo(
    () => filteredSites.find((site) => site.id === selectedSiteId) || null,
    [filteredSites, selectedSiteId],
  );

  const buildDidFilename = (did: Did) =>
    `DID_${String(did.titulo || did.id).replace(/\s+/g, '_')}.pdf`;

  const buildDidForFinalPdf = (did: Did): Did => ({
    ...did,
    status:
      did.status === 'arquivado'
        ? 'arquivado'
        : did.status === 'rascunho'
          ? 'alinhado'
          : 'executado',
  });

  const generateLocalDidPdfBase64 = async (did: Did) => {
    const freshDid = await didsService.findOne(did.id);
    const { generateDidPdf } = await loadDidPdfGenerator();
    const base64 = await generateDidPdf(buildDidForFinalPdf(freshDid), {
      save: false,
      output: 'base64',
      draftWatermark: false,
    });

    if (!base64) {
      throw new Error('Falha ao gerar o PDF do Início do Dia.');
    }

    return String(base64);
  };

  const canUseReadOnlyPdfAction =
    Boolean(currentDid?.pdf_file_key) ||
    (canManageDids && currentDid?.status === 'arquivado');

  const ensureReadOnlyGovernedPdf = async (): Promise<DidPdfAccess> => {
    if (!currentDid) {
      throw new Error('DID não carregado.');
    }

    const existingAccess = await didsService.getPdfAccess(currentDid.id);
    if (existingAccess.hasFinalPdf) {
      return existingAccess;
    }

    if (!canManageDids || currentDid.status !== 'arquivado') {
      throw new Error(
        'Este DID não possui PDF final governado disponível.',
      );
    }

    const base64 = await generateLocalDidPdfBase64(currentDid);
    const file = base64ToPdfFile(base64, buildDidFilename(currentDid));
    const attachResult = await didsService.attachFile(currentDid.id, file);
    setCurrentDid((did) =>
      did
        ? {
            ...did,
            pdf_file_key: attachResult.fileKey,
            pdf_folder_path: attachResult.folderPath,
            pdf_original_name: attachResult.originalName,
          }
        : did,
    );

    if (attachResult.degraded) {
      toast.warning(attachResult.message);
    } else {
      toast.success(attachResult.message);
    }

    return didsService.getPdfAccess(currentDid.id);
  };

  const handlePrintArchivedPdf = async () => {
    try {
      const access = await ensureReadOnlyGovernedPdf();
      if (access.availability === 'ready' && access.url) {
        openPdfForPrint(access.url, () => {
          toast.info('Pop-up bloqueado. O PDF foi aberto na mesma aba.');
        });
        return;
      }

      if (access.message) {
        toast.warning(access.message);
      }

      const didForPdf = currentDid || (await didsService.findOne(access.didId));
      const base64 = await generateLocalDidPdfBase64(didForPdf);
      const fileUrl = URL.createObjectURL(base64ToPdfBlob(base64));
      openPdfForPrint(fileUrl, () => {
        toast.info('Pop-up bloqueado. O PDF foi aberto na mesma aba.');
      });
      setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000);
    } catch (error) {
      toast.error(
        getFormErrorMessage(error, {
          fallback: 'Não foi possível preparar a impressão do DID.',
        }),
      );
    }
  };

  const handleEmailArchivedPdf = async () => {
    try {
      const access = await ensureReadOnlyGovernedPdf();
      if (!currentDid) {
        throw new Error('DID não carregado.');
      }

      if (!access.hasFinalPdf) {
        toast.warning(
          access.message ||
            'O PDF final governado deste DID ainda não está disponível para envio.',
        );
        return;
      }

      if (access.availability !== 'ready' && access.message) {
        toast.warning(
          `${access.message} O envio oficial continuará usando o PDF final governado do DID.`,
        );
      }

      setSelectedDoc({
        name: `DID - ${currentDid.titulo}`,
        filename: access.originalName || buildDidFilename(currentDid),
        storedDocument: {
          documentId: currentDid.id,
          documentType: 'DID',
        },
      });
      setIsMailModalOpen(true);
    } catch (error) {
      toast.error(
        getFormErrorMessage(error, {
          fallback: 'Não foi possível preparar o envio por e-mail do DID.',
        }),
      );
    }
  };

  useEffect(() => {
    async function loadData() {
      try {
        if (!id) {
          return;
        }

        const did = await didsService.findOne(id);
        setCurrentDid(did);
        reset({
          titulo: did.titulo,
          descricao: did.descricao || '',
          data: String(did.data).slice(0, 10),
          turno: did.turno || '',
          frente_trabalho: did.frente_trabalho || '',
          atividade_principal: did.atividade_principal,
          atividades_planejadas: did.atividades_planejadas,
          riscos_operacionais: did.riscos_operacionais,
          controles_planejados: did.controles_planejados,
          epi_epc_aplicaveis: did.epi_epc_aplicaveis || '',
          observacoes: did.observacoes || '',
          company_id: did.company_id,
          site_id: did.site_id,
          responsavel_id: did.responsavel_id,
          participants: (did.participants || []).map((participant) => participant.id),
        });
      } catch (error) {
        toast.error(
          getFormErrorMessage(error, {
            fallback:
              'Nao foi possivel carregar os dados do Diálogo do Início do Dia.',
          }),
        );
      } finally {
        setFetching(false);
      }
    }

    void loadData();
  }, [id, reset]);

  const toggleParticipant = (userId: string) => {
    const current = selectedParticipantIds || [];
    const next = current.includes(userId)
      ? current.filter((item) => item !== userId)
      : [...current, userId];

    setValue('participants', next, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  };

  const handleCompanyChange = (companyId: string) => {
    if (isAdminGeral && companyId) {
      const company = companies.find((item) => item.id === companyId);
      selectedTenantStore.set({
        companyId,
        companyName: company?.razao_social || 'Empresa selecionada',
      });
    }
    setValue('company_id', companyId, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    setValue('site_id', '', { shouldValidate: true });
    setValue('responsavel_id', '', { shouldValidate: true });
    setValue('participants', [], { shouldValidate: true });
  };

  const onSubmit = async (data: DidFormData) => {
    const payload: DidMutationInput = {
      ...data,
      descricao: data.descricao || undefined,
      turno: data.turno || undefined,
      frente_trabalho: data.frente_trabalho || undefined,
      epi_epc_aplicaveis: data.epi_epc_aplicaveis || undefined,
      observacoes: data.observacoes || undefined,
    };

    try {
      setSaving(true);

      if (id) {
        await didsService.update(id, payload);
        toast.success('Diálogo do Início do Dia atualizado com sucesso.');
      } else {
        await didsService.create(payload);
        toast.success('Diálogo do Início do Dia criado com sucesso.');
      }

      router.push('/dashboard/dids');
      router.refresh();
    } catch (error) {
      toast.error(
        getFormErrorMessage(error, {
          badRequest:
            'Nao foi possivel salvar o documento. Revise os campos obrigatorios.',
          forbidden:
            'Voce nao tem permissao para salvar o Diálogo do Início do Dia.',
          notFound: 'Registro nao encontrado.',
          fallback:
            'Nao foi possivel salvar o Diálogo do Início do Dia.',
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  if (!canManageDids) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-[color:var(--ds-color-danger)]/20 bg-[color:var(--ds-color-danger)]/8 px-5 py-4 text-sm text-[var(--ds-color-danger)]"
      >
        <p className="font-semibold">Acesso bloqueado</p>
        <p className="mt-1 text-[color:var(--ds-color-danger)]/90">
          Voce nao tem permissao para criar ou editar Dialogos do Inicio do Dia.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mx-auto max-w-6xl pb-16">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState
            label={id ? 'Carregando DID' : 'Preparando DID'}
          />
        </div>
      ) : null}

      <DidFormPageShell
        id={id}
        isReadOnly={isReadOnly}
        readOnlyMessage={readOnlyMessage}
        currentStatus={currentDid?.status}
        selectedTurno={selectedTurno}
        selectedCompanyName={
          selectedCompany?.razao_social || currentDid?.company?.razao_social
        }
        selectedSiteName={selectedSite?.nome || currentDid?.site?.nome}
        participantCount={selectedParticipantIds.length}
        selectedMainActivity={
          selectedMainActivity || currentDid?.atividade_principal
        }
        selectedTitle={selectedTitle}
        onBack={() => router.push('/dashboard/dids')}
        saving={saving}
        isSubmitting={isSubmitting}
        extraActions={
          id && isReadOnly ? (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handlePrintArchivedPdf()}
                disabled={!canUseReadOnlyPdfAction}
              >
                <Printer className="h-4 w-4" />
                Imprimir PDF
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleEmailArchivedPdf()}
                disabled={!canUseReadOnlyPdfAction}
              >
                <Mail className="h-4 w-4" />
                Enviar por e-mail
              </Button>
            </>
          ) : null
        }
        footer={
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-[var(--ds-color-text-primary)]">
                DID com leitura mais clara e preenchimento mais direto
              </p>
              <p className="text-sm text-[var(--ds-color-text-muted)]">
                Revise equipe, atividade e observações antes de salvar.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => router.push('/dashboard/dids')}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                size="lg"
                className="w-full sm:w-auto"
                loading={saving || isSubmitting}
                disabled={isReadOnly || !isValid}
              >
                {!saving && !isSubmitting ? <Save className="h-4 w-4" /> : null}
                {id ? 'Salvar alterações' : 'Salvar DID'}
              </Button>
            </div>
          </div>
        }
      >
        <DidContextSection
          register={register}
          errors={errors}
          companies={companies}
          filteredSites={filteredSites}
          filteredUsers={filteredUsers}
          isAdminGeral={isAdminGeral}
          companyLabel={
            selectedCompany?.razao_social ||
            currentDid?.company?.razao_social ||
            null
          }
          selectedCompanyId={selectedCompanyId}
          handleCompanyChange={handleCompanyChange}
        />
        <DidOperationalSection register={register} errors={errors} />
        <DidParticipantsSection
          selectedCompanyId={selectedCompanyId}
          filteredUsers={filteredUsers}
          selectedParticipantIds={selectedParticipantIds}
          toggleParticipant={toggleParticipant}
          participantsError={errors.participants?.message}
        />
      </DidFormPageShell>

      {selectedDoc ? (
        <SendMailModal
          isOpen={isMailModalOpen}
          onClose={() => {
            setIsMailModalOpen(false);
            setSelectedDoc(null);
          }}
          documentName={selectedDoc.name}
          filename={selectedDoc.filename}
          base64={selectedDoc.base64}
          storedDocument={selectedDoc.storedDocument}
        />
      ) : null}
    </form>
  );
}
