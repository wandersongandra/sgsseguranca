'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { machinesService } from '@/services/machinesService';
import { companiesService, Company } from '@/services/companiesService';
import { useForm } from 'react-hook-form';
import type { FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { getFormErrorMessage } from '@/lib/error-handler';
import { logger } from '@/lib/logger';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ErrorState, InlineLoadingState } from '@/components/ui/state';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/form-field';
import { StatusPill } from '@/components/ui/status-pill';
import { PageHeader } from '@/components/layout';
import { cn } from '@/lib/utils';

const machineSchema = z.object({
  nome: z.string().min(3, 'O nome deve ter pelo menos 3 caracteres'),
  descricao: z.string().optional(),
  placa: z.string().optional(),
  horimetro_atual: z.number().min(0, 'O horímetro deve ser maior ou igual a zero'),
  company_id: z.string().min(1, 'Selecione uma empresa'),
});

type MachineFormData = z.infer<typeof machineSchema>;

interface MachineFormProps {
  id?: string;
}

export function MachineForm({ id }: MachineFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors, isValid, isSubmitting },
  } = useForm<MachineFormData>({
    resolver: zodResolver(machineSchema),
    mode: 'onBlur',
    reValidateMode: 'onBlur',
    defaultValues: {
      nome: '',
      descricao: '',
      placa: '',
      horimetro_atual: 0,
      company_id: '',
    },
  });

  useEffect(() => {
    async function loadData() {
      try {
        const companiesData = await companiesService.findAll();
        setCompanies(companiesData);

        if (id) {
          const machineData = await machinesService.findOne(id);
          reset({
            nome: machineData.nome,
            descricao: machineData.descricao || '',
            placa: machineData.placa || '',
            horimetro_atual: machineData.horimetro_atual || 0,
            company_id: machineData.company_id,
          });
        }
      } catch (error) {
        logger.error('Erro ao carregar dados:', error);
        toast.error('Erro ao carregar dados para o formulário.');
        router.push('/dashboard/machines');
      } finally {
        setFetching(false);
      }
    }

    loadData();
  }, [id, reset, router]);

  async function onSubmit(data: MachineFormData) {
    try {
      setLoading(true);
      setSubmitError(null);
      if (id) {
        await machinesService.update(id, data);
        toast.success('Máquina atualizada com sucesso!');
      } else {
        await machinesService.create(data);
        toast.success('Máquina cadastrada com sucesso!');
      }
      router.push('/dashboard/machines');
      router.refresh();
    } catch (error) {
      logger.error('Erro ao salvar máquina:', error);
      const errorMessage = getFormErrorMessage(error, {
        badRequest: 'Dados inválidos. Revise os campos obrigatórios.',
        unauthorized: 'Sessão expirada. Faça login novamente.',
        forbidden: 'Você não tem permissão para salvar máquinas.',
        server: 'Erro interno do servidor ao salvar máquina.',
        fallback: 'Erro ao salvar máquina. Tente novamente.',
      });
      setSubmitError(errorMessage);
      toast.error('Erro ao salvar máquina. Verifique os dados e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  const onInvalid = (formErrors: FieldErrors<MachineFormData>) => {
    if (formErrors.company_id) {
      setFocus('company_id');
    } else if (formErrors.nome) {
      setFocus('nome');
    } else if (formErrors.horimetro_atual) {
      setFocus('horimetro_atual');
    }
    toast.error('Revise os campos obrigatórios antes de salvar.');
  };

  return (
    <div className="ds-form-page mx-auto max-w-4xl space-y-6">
      {fetching ? (
        <div className="rounded-[var(--ds-radius-xl)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] p-6 shadow-[var(--ds-shadow-sm)]">
          <InlineLoadingState
            label={id ? 'Carregando máquina' : 'Preparando cadastro de máquina'}
          />
        </div>
      ) : null}

      <PageHeader
        eyebrow="Cadastro de máquinas"
        title={id ? 'Editar máquina' : 'Nova máquina'}
        description="Cadastre dados operacionais, identificação e empresa responsável pelo equipamento."
        icon={
          <Link
            href="/dashboard/machines"
            className="rounded-full p-2 text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-primary-subtle)] hover:text-[var(--ds-color-text-primary)]"
            title="Voltar"
            aria-label="Voltar para a lista de máquinas"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="info">Máquina</StatusPill>
            <StatusPill tone={id ? 'warning' : 'success'}>
              {id ? 'Edição' : 'Novo cadastro'}
            </StatusPill>
          </div>
        }
      />

      <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-6">
        {submitError ? (
          <ErrorState
            compact
            title="Falha ao salvar máquina"
            description={submitError}
          />
        ) : null}

        <Card tone="default" padding="lg">
          <CardHeader>
            <CardTitle>Identificação e vínculo</CardTitle>
            <CardDescription>
              Defina a empresa dona do registro e a identificação principal da máquina.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <FormField
              label="Empresa"
              htmlFor="company_id"
              required
              description="Toda máquina precisa estar vinculada a uma empresa do tenant."
              error={errors.company_id?.message}
              className="md:col-span-2"
            >
              <Select
                id="company_id"
                {...register('company_id')}
                aria-invalid={errors.company_id ? 'true' : undefined}
              >
                <option value="">Selecione uma empresa</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.razao_social}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="Nome da Máquina"
              htmlFor="nome"
              required
              description="Use um nome claro para facilitar checklist, verificação e rastreabilidade."
              error={errors.nome?.message}
              className="md:col-span-2"
            >
              <Input
                id="nome"
                type="text"
                {...register('nome')}
                aria-invalid={errors.nome ? 'true' : undefined}
                placeholder="Ex: Escavadeira Caterpillar"
              />
            </FormField>

            <FormField
              label="Placa / Identificação"
              htmlFor="placa"
              description="Opcional. Pode ser placa, patrimônio ou código interno."
            >
              <Input
                id="placa"
                type="text"
                {...register('placa')}
                placeholder="Ex: ABC-1234"
              />
            </FormField>

            <FormField
              label="Horímetro Atual"
              htmlFor="horimetro_atual"
              required
              description="Informe o acumulado atual para manutenção e rastreabilidade operacional."
              error={errors.horimetro_atual?.message}
            >
              <Input
                id="horimetro_atual"
                type="number"
                step="0.1"
                {...register('horimetro_atual', { valueAsNumber: true })}
                aria-invalid={errors.horimetro_atual ? 'true' : undefined}
                placeholder="Ex: 1542.7"
              />
            </FormField>
          </CardContent>
        </Card>

        <Card tone="default" padding="lg">
          <CardHeader>
            <CardTitle>Detalhamento técnico</CardTitle>
            <CardDescription>
              Inclua observações operacionais relevantes para manutenção, verificação e mobilização.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              label="Descrição"
              htmlFor="descricao"
              description="Opcional. Use este campo para informações relevantes sobre uso, modelo ou condição."
            >
              <Textarea
                id="descricao"
                rows={4}
                {...register('descricao')}
                placeholder="Opcional"
              />
            </FormField>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3 border-t border-[var(--ds-color-border-subtle)] pt-6 sm:flex-row sm:justify-end">
          <Link
            href="/dashboard/machines"
            className={cn(buttonVariants({ variant: 'outline' }), 'justify-center')}
          >
            Cancelar
          </Link>
          <Button
            type="submit"
            disabled={loading || isSubmitting || !isValid}
            className="justify-center"
          >
            <Save className="mr-2 h-4 w-4" />
            {id ? 'Salvar alterações' : 'Criar máquina'}
          </Button>
        </div>
      </form>
    </div>
  );
}
