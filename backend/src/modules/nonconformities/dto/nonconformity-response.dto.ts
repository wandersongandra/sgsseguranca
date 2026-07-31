import { Exclude, Expose, Type } from 'class-transformer';
import { SiteResponseDto } from '../../sites/dto/site-response.dto';
import { CompanyResponseDto } from '../../companies/dto/company-response.dto';

// SECURITY: do not expose raw internal storage keys in nonconformity responses.
// Use dedicated governed access endpoints (GET /:id/pdf , /:id/attachments/:index/access)
// which intentionally return temporary signed URLs + the fileKey ONLY for those access paths
// (to allow clients to fetch the content securely).
// pdf_file_key / pdf_folder_path / pdf_original_name are stored internally for governance
// but MUST be stripped from all main API JSON outputs (find, list, create, update, etc.).
// Attachments (anexos) in main responses contain ONLY governed references (gst:nc-attachment:...).
// Never expose raw fileKey (or decoded keys) in the primary NonConformity responses.
// Follows exact pattern from checklists/dto/checklist-response.dto.ts

@Exclude()
export class NonConformityResponseDto {
  @Expose() id: string;
  @Expose() company_id: string;
  @Expose() site_id?: string;
  @Expose() codigo_nc: string;
  @Expose() tipo: string;
  @Expose() tipo_categoria?: string | null;
  @Expose() tipo_subcategoria?: string | null;
  @Expose() data_identificacao: Date;
  @Expose() local_setor_area: string;
  @Expose() atividade_envolvida: string;
  @Expose() responsavel_area: string;
  @Expose() auditor_responsavel: string;
  @Expose() classificacao?: string[];
  @Expose() descricao: string;
  @Expose() evidencia_observada: string;
  @Expose() condicao_insegura: string;
  @Expose() ato_inseguro?: string;
  @Expose() requisito_nr: string;
  @Expose() requisito_nr_categoria?: string | null;
  @Expose() requisito_item: string;
  @Expose() requisito_procedimento?: string;
  @Expose() requisito_politica?: string;
  @Expose() risco_perigo: string;
  @Expose() risco_categoria?: string | null;
  @Expose() risco_fonte?: string | null;
  @Expose() risco_associado: string;
  @Expose() risco_consequencias?: string[];
  @Expose() risco_nivel: string;
  @Expose() causa?: string[];
  @Expose() causa_categoria?: string | null;
  @Expose() causa_fator_humano?: boolean | null;
  @Expose() causa_fator_equipamento?: boolean | null;
  @Expose() causa_fator_processo?: boolean | null;
  @Expose() causa_fator_ambiente?: boolean | null;
  @Expose() causa_fator_gerencial?: boolean | null;
  @Expose() causa_outro?: string;
  @Expose() evidencia_descricao_foto?: string | null;
  @Expose() evidencia_foto1_key?: string | null;
  @Expose() evidencia_foto2_key?: string | null;
  @Expose() evidencia_foto3_key?: string | null;
  @Expose() verificacao_descricao_foto?: string | null;
  @Expose() verificacao_foto1_key?: string | null;
  @Expose() verificacao_foto2_key?: string | null;
  @Expose() verificacao_foto3_key?: string | null;
  @Expose() acao_imediata_descricao?: string;
  @Expose() acao_imediata_data?: Date;
  @Expose() acao_imediata_responsavel?: string;
  @Expose() acao_imediata_status?: string;
  @Expose() acao_definitiva_descricao?: string;
  @Expose() acao_definitiva_prazo?: Date;
  @Expose() acao_definitiva_responsavel?: string;
  @Expose() acao_definitiva_recursos?: string;
  @Expose() acao_definitiva_data_prevista?: Date;
  @Expose() acao_preventiva_medidas?: string;
  @Expose() acao_preventiva_treinamento?: string;
  @Expose() acao_preventiva_revisao_procedimento?: string;
  @Expose() acao_preventiva_melhoria_processo?: string;
  @Expose() acao_preventiva_epc_epi?: string;
  @Expose() verificacao_resultado?: string;
  @Expose() verificacao_evidencias?: string;
  @Expose() verificacao_data?: Date;
  @Expose() verificacao_responsavel?: string;
  @Expose() status: string;
  @Expose() closed_at?: Date | null;
  @Expose() resolved_by?: string | null;
  @Expose() observacoes_gerais?: string;
  @Expose() anexos?: string[];
  @Expose() assinatura_responsavel_area?: string;
  @Expose() assinatura_tecnico_auditor?: string;
  @Expose() assinatura_gestao?: string;
  @Expose() checklist_id?: string | null;
  @Expose() created_at: Date;
  @Expose() updated_at: Date;

  @Expose()
  @Type(() => CompanyResponseDto)
  company?: CompanyResponseDto;

  @Expose()
  @Type(() => SiteResponseDto)
  site?: SiteResponseDto;
}
