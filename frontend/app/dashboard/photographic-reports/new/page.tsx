import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { PhotographicReportWorkspace } from "../components/PhotographicReportWorkspace";

function FallbackLoader() {
  return (
    <div className="flex min-h-[320px] items-center justify-center text-[var(--ds-color-text-muted)]">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  );
}

export default function NewPhotographicReportPage() {
  return (
    <Suspense fallback={<FallbackLoader />}>
      <PhotographicReportWorkspace mode="create" />
    </Suspense>
  );
}
