import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { handleApiError } from '@/lib/error-handler';

interface UseFormSubmitOptions {
  successMessage?: string | ((result: unknown) => string | undefined | null);
  redirectTo?: string;
  onSuccess?: (result: unknown) => void;
  skipRedirect?: (result: unknown) => boolean;
  context?: string;
}

export function useFormSubmit<T>(
  submitFn: (data: T) => Promise<unknown>,
  options?: UseFormSubmitOptions
) {
  const [loading, setLoading] = useState(false);
  const submittingRef = useRef(false);
  const router = useRouter();

  const handleSubmit = async (data: T) => {
    if (submittingRef.current) {
      return undefined;
    }

    submittingRef.current = true;
    setLoading(true);
    try {
      const result = await submitFn(data);
      const successMessage =
        typeof options?.successMessage === 'function'
          ? options.successMessage(result)
          : options?.successMessage;

      toast.success(successMessage || 'Salvo com sucesso!');
      
      if (options?.onSuccess) {
        options.onSuccess(result);
      }

      const shouldSkipRedirect = options?.skipRedirect?.(result) ?? false;

      if (options?.redirectTo && !shouldSkipRedirect) {
        router.push(options.redirectTo);
        router.refresh();
      }
      return result;
    } catch (error) {
      handleApiError(error, options?.context || 'Formulário');
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  return { handleSubmit, loading };
}
