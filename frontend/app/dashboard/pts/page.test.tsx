import { render, screen, waitFor } from '@testing-library/react';
import PtsPage from './page';

const usePts = jest.fn();
const useAuth = jest.fn();

jest.mock('./hooks/usePts', () => ({
  usePts: () => usePts(),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuth(),
}));

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock('@/components/layout', () => ({
  ListPageLayout: ({ actions, children }: { actions: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <div>{actions}</div>
      {children}
    </div>
  ),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    leftIcon: _leftIcon,
    ...props
  }: {
    children: React.ReactNode;
    leftIcon?: React.ReactNode;
  }) => (
    <button {...props}>{children}</button>
  ),
  buttonVariants: () => '',
}));

jest.mock('@/components/PaginationControls', () => ({
  PaginationControls: () => null,
}));

jest.mock('@/components/ui/state', () => ({
  ErrorState: () => null,
  InlineLoadingState: () => null,
}));

jest.mock('./components/PtsFilters', () => ({
  PtsFilters: () => null,
}));

jest.mock('./components/PtsTable', () => ({
  PtsTable: () => null,
}));

jest.mock('./components/PtsInsights', () => ({
  PtsInsights: () => null,
}));

jest.mock('./components/PtApprovalRulesPanel', () => ({
  PtApprovalRulesPanel: () => null,
}));

jest.mock('./components/PtClosureModal', () => ({
  PtClosureModal: () => null,
}));

jest.mock('./components/PtRejectModal', () => ({
  PtRejectModal: () => null,
}));

jest.mock('@/components/ui/confirm-modal', () => ({
  ConfirmModal: () => null,
}));

jest.mock('@/lib/download-excel', () => ({
  downloadExcel: jest.fn(),
}));

jest.mock('@/services/companiesService', () => ({
  companiesService: {
    findAll: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('@/services/ptsService', () => ({
  ptsService: {
    listStoredFiles: jest.fn(),
    getPdfAccess: jest.fn(),
    downloadWeeklyBundle: jest.fn(),
  },
}));

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('@/components/StoredFilesPanel', () => ({
  StoredFilesPanel: () => null,
}));

function makeUsePtsValue() {
  return {
    loading: false,
    loadError: null,
    searchTerm: '',
    setSearchTerm: jest.fn(),
    statusFilter: '',
    setStatusFilter: jest.fn(),
    insights: [],
    page: 1,
    setPage: jest.fn(),
    total: 0,
    lastPage: 1,
    isMailModalOpen: false,
    setIsMailModalOpen: jest.fn(),
    selectedDoc: null,
    setSelectedDoc: jest.fn(),
    filteredPts: [],
    approvalRules: null,
    approvalRulesLoading: false,
    overviewMetrics: null,
    approvingId: null,
    rejectingId: null,
    rejectTargetId: null,
    setRejectTargetId: jest.fn(),
    finalizingId: null,
    approvalIssuesById: {},
    approvalReviewLoadingId: null,
    approvalReviewById: {},
    approvalChecklistById: {},
    dismissApprovalIssue: jest.fn(),
    dismissApprovalReview: jest.fn(),
    updateApprovalChecklist: jest.fn(),
    handleDelete: jest.fn(),
    confirmDelete: jest.fn(),
    confirmDeleteId: null,
    setConfirmDeleteId: jest.fn(),
    deleteLoading: false,
    handleDownloadPdf: jest.fn(),
    handleSendEmail: jest.fn(),
    handlePrint: jest.fn(),
    handlePrepareApproval: jest.fn(),
    handleApprove: jest.fn(),
    handleReject: jest.fn(),
    confirmReject: jest.fn(),
    handleFinalize: jest.fn(),
    closingPt: null,
    setClosingPt: jest.fn(),
    confirmFinalize: jest.fn(),
    loadPts: jest.fn(),
    handleEmitGovernedPdf: jest.fn(),
    emittingPdfId: null,
  };
}

describe('PtsPage', () => {
  beforeEach(() => {
    localStorage.clear();
    usePts.mockReturnValue(makeUsePtsValue());
    useAuth.mockReturnValue({
      user: { id: 'user-1', company_id: 'company-1' },
      hasPermission: () => true,
    });
  });

  it('não anuncia rascunho pertencente a outro usuário da mesma empresa', async () => {
    localStorage.setItem('gst.pt.wizard.draft.company-1.user-2', '{}');

    render(<PtsPage />);

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Retomar rascunho' })).not.toBeInTheDocument();
    });
  });
});
