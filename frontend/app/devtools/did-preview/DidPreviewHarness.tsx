'use client';

import { useMemo, useState } from 'react';
import { FileSearch, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DidContextSection,
  DidFormPageShell,
  DidOperationalSection,
  DidParticipantsSection,
} from '../../dashboard/dids/components/DidFormSections';
import { base64ToPdfBlob } from '@/lib/pdf/pdfFile';
import { generateDidPdf } from '@/lib/pdf/didGenerator';
import type { Did } from '@/services/didsService';
import type { User } from '@/services/usersService';

type DidPreviewState = {
  titulo: string;
  data: string;
  turno: string;
  company_id: string;
  site_id: string;
  responsavel_id: string;
  frente_trabalho: string;
  descricao: string;
  atividade_principal: string;
  atividades_planejadas: string;
  riscos_operacionais: string;
  controles_planejados: string;
  epi_epc_aplicaveis: string;
  observacoes: string;
  participants: string[];
};

const companies = [{ id: 'company-1', razao_social: 'Empresa Teste' }];
const allSites = [{ id: 'site-1', nome: 'Obra Norte', company_id: 'company-1' }];
const previewTimestamp = '2026-04-15T07:00:00.000Z';

const allUsers: User[] = [
  {
    id: 'user-1',
    nome: 'Responsável',
    email: 'responsavel@empresa.test',
    cpf: '00000000001',
    funcao: 'Técnica SST',
    role: 'USER',
    company_id: 'company-1',
    site_id: 'site-1',
    profile_id: 'profile-1',
    created_at: previewTimestamp,
    updated_at: previewTimestamp,
  },
  {
    id: 'user-2',
    nome: 'Equipe Campo',
    email: 'equipe.campo@empresa.test',
    cpf: '00000000002',
    funcao: 'Montador',
    role: 'USER',
    company_id: 'company-1',
    site_id: 'site-1',
    profile_id: 'profile-1',
    created_at: previewTimestamp,
    updated_at: previewTimestamp,
  },
  {
    id: 'user-3',
    nome: 'Supervisor',
    email: 'supervisor@empresa.test',
    cpf: '00000000003',
    funcao: 'Supervisor',
    role: 'USER',
    company_id: 'company-1',
    site_id: 'site-1',
    profile_id: 'profile-1',
    created_at: previewTimestamp,
    updated_at: previewTimestamp,
  },
  {
    id: 'user-4',
    nome: 'Apoio Corporativo',
    email: 'apoio@empresa.test',
    cpf: '00000000004',
    funcao: 'Apoio SST',
    role: 'USER',
    company_id: 'company-1',
    site_id: undefined,
    profile_id: 'profile-1',
    created_at: previewTimestamp,
    updated_at: previewTimestamp,
  },
];

const initialState: DidPreviewState = {
  titulo: 'DID Operacional',
  data: '2026-04-15',
  turno: 'manha',
  company_id: 'company-1',
  site_id: 'site-1',
  responsavel_id: 'user-1',
  frente_trabalho: 'Frente A',
  descricao: 'Alinhamento do turno com foco em segurança e sequência operacional.',
  atividade_principal: 'Montagem da linha',
  atividades_planejadas: 'Montar a estrutura principal e revisar pontos críticos.',
  riscos_operacionais: 'Carga suspensa, circulação de equipamentos e piso irregular.',
  controles_planejados: 'Isolamento, sinalização, conferência pré-início e DDS inicial.',
  epi_epc_aplicaveis: 'Capacete, luva, colete e cones.',
  observacoes: 'Reforçar comunicação por rádio durante movimentação.',
  participants: ['user-2'],
};

export function DidPreviewHarness() {
  const [values, setValues] = useState<DidPreviewState>(initialState);
  const [readOnly, setReadOnly] = useState(false);
  const [openingPdf, setOpeningPdf] = useState(false);

  const filteredSites = useMemo(
    () => allSites.filter((site) => site.company_id === values.company_id),
    [values.company_id],
  );
  const filteredUsers = useMemo(
    () =>
      allUsers.filter(
        (user) =>
          user.company_id === values.company_id &&
          (!values.site_id || user.site_id === values.site_id || !user.site_id),
      ),
    [values.company_id, values.site_id],
  );

  const selectedCompany = companies.find(
    (company) => company.id === values.company_id,
  );
  const selectedSite = filteredSites.find((site) => site.id === values.site_id);
  const selectedResponsible =
    filteredUsers.find((user) => user.id === values.responsavel_id) || null;
  const selectedParticipants = filteredUsers.filter((user) =>
    values.participants.includes(user.id),
  );

  const previewDid = useMemo<Did>(
    () => ({
      id: 'preview-did',
      titulo: values.titulo,
      descricao: values.descricao,
      data: values.data,
      turno: values.turno,
      frente_trabalho: values.frente_trabalho,
      atividade_principal: values.atividade_principal,
      atividades_planejadas: values.atividades_planejadas,
      riscos_operacionais: values.riscos_operacionais,
      controles_planejados: values.controles_planejados,
      epi_epc_aplicaveis: values.epi_epc_aplicaveis,
      observacoes: values.observacoes,
      company_id: values.company_id,
      site_id: values.site_id,
      responsavel_id: values.responsavel_id,
      participants: selectedParticipants,
      status: readOnly ? 'arquivado' : 'executado',
      created_at: '2026-04-15T07:15:00.000Z',
      updated_at: '2026-04-15T07:45:00.000Z',
      company: selectedCompany
        ? { id: selectedCompany.id, razao_social: selectedCompany.razao_social }
        : undefined,
      site: selectedSite ? { id: selectedSite.id, nome: selectedSite.nome } : undefined,
      responsavel: selectedResponsible
        ? { id: selectedResponsible.id, nome: selectedResponsible.nome }
        : undefined,
    }),
    [
      readOnly,
      selectedCompany,
      selectedParticipants,
      selectedResponsible,
      selectedSite,
      values,
    ],
  );

  const register = (name: string) => ({
    name,
    value: values[name as keyof DidPreviewState] as string,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) => {
      const nextValue = event.target.value;
      setValues((current) => ({ ...current, [name]: nextValue }));
    },
  });

  const handleCompanyChange = (companyId: string) => {
    setValues((current) => ({
      ...current,
      company_id: companyId,
      site_id: '',
      responsavel_id: '',
      participants: [],
    }));
  };

  const toggleParticipant = (userId: string) => {
    setValues((current) => ({
      ...current,
      participants: current.participants.includes(userId)
        ? current.participants.filter((id) => id !== userId)
        : [...current.participants, userId],
    }));
  };

  const handleOpenPdfPreview = async () => {
    try {
      setOpeningPdf(true);
      const base64 = await generateDidPdf(previewDid, {
        save: false,
        output: 'base64',
        draftWatermark: false,
      });

      if (!base64) {
        return;
      }

      const fileUrl = URL.createObjectURL(base64ToPdfBlob(String(base64)));
      window.open(fileUrl, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000);
    } finally {
      setOpeningPdf(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--component-shell-backdrop)] px-4 py-6 md:px-6">
      <div className="mx-auto mb-4 flex max-w-6xl items-center gap-3">
        <Button
          type="button"
          variant={readOnly ? 'warning' : 'secondary'}
          onClick={() => setReadOnly((current) => !current)}
        >
          {readOnly ? 'Desbloquear visual' : 'Simular somente leitura'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={openingPdf}
          onClick={() => void handleOpenPdfPreview()}
        >
          {!openingPdf ? <FileSearch className="h-4 w-4" /> : null}
          Abrir PDF de amostra
        </Button>
      </div>

      <DidFormPageShell
        id="preview-did"
        isReadOnly={readOnly}
        readOnlyMessage={
          readOnly
            ? 'Este Diálogo do Início do Dia já possui PDF final governado e não aceita edição.'
            : null
        }
        currentStatus={readOnly ? 'executado' : 'alinhado'}
        selectedTurno={values.turno}
        selectedCompanyName={selectedCompany?.razao_social}
        selectedSiteName={selectedSite?.nome}
        participantCount={values.participants.length}
        selectedMainActivity={values.atividade_principal}
        selectedTitle={values.titulo}
        onBack={() => undefined}
        saving={false}
        isSubmitting={false}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary">
              Cancelar
            </Button>
            <Button type="button" disabled={readOnly}>
              <Save className="h-4 w-4" />
              Salvar DID
            </Button>
          </div>
        }
      >
        <DidContextSection
          register={register}
          errors={{}}
          companies={companies}
          filteredSites={filteredSites}
          filteredUsers={filteredUsers}
          isAdminGeral={false}
          companyLabel={selectedCompany?.razao_social}
          selectedCompanyId={values.company_id}
          handleCompanyChange={handleCompanyChange}
        />
        <DidOperationalSection register={register} errors={{}} />
        <DidParticipantsSection
          selectedCompanyId={values.company_id}
          filteredUsers={filteredUsers}
          selectedParticipantIds={values.participants}
          toggleParticipant={toggleParticipant}
        />
      </DidFormPageShell>
    </div>
  );
}
