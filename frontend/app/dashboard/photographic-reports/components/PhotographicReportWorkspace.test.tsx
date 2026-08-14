import { render, screen } from "@testing-library/react";
import type { PhotographicReport } from "@/services/photographicReportsService";
import { photographicReportsService } from "@/services/photographicReportsService";
import { PhotographicReportWorkspace } from "./PhotographicReportWorkspace";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  // O workspace lê o passo inicial do wizard via query string; sem este mock o
  // render quebra com "useSearchParams is not a function".
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

jest.mock("@/services/photographicReportsService", () => ({
  photographicReportsService: {
    findOne: jest.fn(),
  },
}));

const report: PhotographicReport = {
  id: "report-1",
  company_id: "company-1",
  client_id: null,
  project_id: null,
  client_name: "Cliente teste",
  project_name: "Projeto teste",
  unit_name: null,
  location: null,
  activity_type: "Inspeção",
  report_tone: "Positivo",
  area_status: "Loja aberta",
  shift: "Diurno",
  start_date: "2026-07-15",
  end_date: null,
  start_time: "08:00",
  end_time: "17:00",
  responsible_name: "Responsável",
  responsible_registration_type: null,
  responsible_registration_number: null,
  responsible_registration_state: null,
  art_number: null,
  contractor_company: "Contratada",
  applicable_nrs: null,
  inspection_methodology: null,
  scope_and_limitations: null,
  general_observations: null,
  ai_summary: null,
  final_conclusion: null,
  status: "Rascunho",
  created_by: "user-1",
  created_at: "2026-07-15T08:00:00.000Z",
  updated_at: "2026-07-15T08:00:00.000Z",
  day_count: 0,
  image_count: 1,
  export_count: 0,
  last_exported_at: null,
  verification_code: null,
  final_pdf_hash_sha256: null,
  pdf_generated_at: null,
  days: [],
  exports: [],
  images: [
    {
      id: "image-1",
      report_id: "report-1",
      report_day_id: null,
      image_url: "/uploads/foto-inspecao.jpg",
      download_url: null,
      image_order: 7,
      manual_caption: null,
      ai_title: null,
      ai_description: null,
      ai_positive_points: null,
      ai_technical_assessment: null,
      ai_condition_classification: null,
      ai_recommendations: null,
      photo_conditions: null,
      is_nonconformity: false,
      recommended_action: null,
      action_deadline: null,
      action_responsible: null,
      original_name: null,
      mime_type: null,
      file_size_bytes: null,
      hash_sha256: null,
      captured_at: null,
      latitude: null,
      longitude: null,
      accuracy_m: null,
      exif_datetime: null,
      integrity_flags: null,
      created_at: "2026-07-15T08:00:00.000Z",
      updated_at: "2026-07-15T08:00:00.000Z",
    },
  ],
};

describe("PhotographicReportWorkspace accessibility", () => {
  it("identifica o botão de excluir pelo índice da foto", async () => {
    jest.mocked(photographicReportsService.findOne).mockResolvedValue(report);

    render(<PhotographicReportWorkspace mode="edit" reportId="report-1" />);

    expect(
      await screen.findByRole("button", { name: "Excluir foto 07" }),
    ).toBeInTheDocument();
  });
});
