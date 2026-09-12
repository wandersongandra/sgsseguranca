'use client';

import { useCallback, useRef, useState } from 'react';
import { handleApiError } from '@/lib/error-handler';

export type WorkflowAction = 'approve' | 'reject' | 'reopen';

export interface UseApprovalWorkflowReturn {
  acting: WorkflowAction | null;
  execute: (action: WorkflowAction, fn: () => Promise<void>, label?: string) => Promise<void>;
}

const DEFAULT_LABELS: Record<WorkflowAction, string> = {
  approve: 'Aprovação',
  reject: 'Reprovação',
  reopen: 'Reabertura',
};

export function useApprovalWorkflow(): UseApprovalWorkflowReturn {
  const [acting, setActing] = useState<WorkflowAction | null>(null);
  const actingRef = useRef(false);

  const execute = useCallback(async (action: WorkflowAction, fn: () => Promise<void>, label?: string) => {
    if (actingRef.current) return;
    actingRef.current = true;
    setActing(action);
    try {
      await fn();
    } catch (err) {
      handleApiError(err, label ?? DEFAULT_LABELS[action]);
    } finally {
      actingRef.current = false;
      setActing(null);
    }
  }, []);

  return { acting, execute };
}
