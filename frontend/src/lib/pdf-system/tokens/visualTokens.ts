export type PdfRgb = [number, number, number];

export type PdfTone = {
  pageBg: PdfRgb;
  surface: PdfRgb;
  surfaceMuted: PdfRgb;
  border: PdfRgb;
  borderStrong: PdfRgb;
  textPrimary: PdfRgb;
  textSecondary: PdfRgb;
  textMuted: PdfRgb;
  brand: PdfRgb;
  brandStrong: PdfRgb;
  brandOn: PdfRgb;
  success: PdfRgb;
  warning: PdfRgb;
  danger: PdfRgb;
  info: PdfRgb;
};

export const baseTone: PdfTone = {
  pageBg: [255, 255, 255],
  surface: [255, 255, 255],
  surfaceMuted: [247, 249, 252],
  border: [214, 220, 228],
  borderStrong: [148, 163, 184],
  textPrimary: [15, 23, 42],
  textSecondary: [51, 65, 85],
  textMuted: [100, 116, 139],
  brand: [31, 78, 121],
  brandStrong: [16, 32, 51],
  brandOn: [255, 255, 255],
  success: [22, 101, 52],
  warning: [180, 83, 9],
  danger: [185, 28, 28],
  info: [31, 78, 121],
};

export type PdfTypography = {
  headingLg: number;
  headingMd: number;
  headingSm: number;
  body: number;
  bodySm: number;
  caption: number;
};

export const typography: PdfTypography = {
  headingLg: 15,
  headingMd: 11.2,
  headingSm: 9.2,
  body: 9.4,
  bodySm: 8.4,
  caption: 7.1,
};

export type PdfSpacing = {
  pageMargin: number;
  blockGap: number;
  sectionGap: number;
  inset: number;
  radius: number;
};

export const spacing: PdfSpacing = {
  pageMargin: 15,
  blockGap: 4.5,
  sectionGap: 7,
  inset: 4.5,
  radius: 1.4,
};
