import type { PdfContext } from "../core/types";
import {
  authorizationSemanticColors,
  complianceSemanticColors,
  riskSemanticColors,
  type AuthorizationLevel,
  type ComplianceLevel,
  type RiskLevel,
} from "../tokens/pdfSemantics";

type StatusBadgeKind = "risk" | "compliance" | "authorization";

type StatusBadgeOptions = {
  kind: StatusBadgeKind;
  value: RiskLevel | ComplianceLevel | AuthorizationLevel;
};

function colorFor(options: StatusBadgeOptions) {
  if (options.kind === "risk")
    return riskSemanticColors[options.value as RiskLevel];
  if (options.kind === "compliance")
    return complianceSemanticColors[options.value as ComplianceLevel];
  return authorizationSemanticColors[options.value as AuthorizationLevel];
}

export function drawStatusBadge(
  ctx: PdfContext,
  options: StatusBadgeOptions,
  x: number,
  y: number,
  width = 34,
  height = 7,
) {
  const { doc, theme } = ctx;
  doc.setFillColor(...colorFor(options));
  doc.rect(x, y, width, height, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(theme.typography.caption);
  doc.setTextColor(...theme.tone.brandOn);
  doc.text(String(options.value).toUpperCase(), x + width / 2, y + 4.6, {
    align: "center",
  });
}
