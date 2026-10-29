/**
 * Brand colour tokens: the single source of truth for every colour in the product.
 *
 * Values come from DESIGN.md (Ink and cut). `make tokens` generates
 * src/styles/generated/tokens.css from this file; never edit that file by hand.
 * `make contrast` fails any pair below its WCAG 2.2 minimum in either theme.
 * Coral #D85A30 is for `cut` and `ring` only; text-bearing accent is #B4461F / #E8774F.
 */
export interface ThemeValues {
  light: string;
  dark: string;
}

export const tokens = {
  background: { light: "#FAF8F3", dark: "#14171F" },
  foreground: { light: "#1B1F2A", dark: "#F2EFE8" },
  card: { light: "#FFFFFF", dark: "#1C2029" },
  "card-foreground": { light: "#1B1F2A", dark: "#F2EFE8" },
  popover: { light: "#FFFFFF", dark: "#1C2029" },
  "popover-foreground": { light: "#1B1F2A", dark: "#F2EFE8" },
  primary: { light: "#1B1F2A", dark: "#F2EFE8" },
  "primary-foreground": { light: "#FAF8F3", dark: "#14171F" },
  secondary: { light: "#F5F3ED", dark: "#252A35" },
  "secondary-foreground": { light: "#1B1F2A", dark: "#F2EFE8" },
  muted: { light: "#F5F3ED", dark: "#252A35" },
  "muted-foreground": { light: "#6B6F7A", dark: "#A3A7B1" },
  accent: { light: "#B4461F", dark: "#E8774F" },
  "accent-foreground": { light: "#FFFFFF", dark: "#14171F" },
  destructive: { light: "#B42318", dark: "#F28B82" },
  "destructive-foreground": { light: "#FFFFFF", dark: "#14171F" },
  border: { light: "#E3DFD5", dark: "#2E333F" },
  input: { light: "#E3DFD5", dark: "#2E333F" },
  ring: { light: "#D85A30", dark: "#E8774F" },
  cut: { light: "#D85A30", dark: "#E8774F" },
  "chart-1": { light: "#1B1F2A", dark: "#F2EFE8" },
  "chart-2": { light: "#6B6F7A", dark: "#A3A7B1" },
  "chart-3": { light: "#B4461F", dark: "#E8774F" },
  "chart-4": { light: "#A39E90", dark: "#5A606D" },
  "chart-5": { light: "#D85A30", dark: "#8A8F9B" },
  sidebar: { light: "#FAF8F3", dark: "#1C2029" },
  "sidebar-foreground": { light: "#1B1F2A", dark: "#F2EFE8" },
  "sidebar-primary": { light: "#1B1F2A", dark: "#F2EFE8" },
  "sidebar-primary-foreground": { light: "#FAF8F3", dark: "#14171F" },
  "sidebar-accent": { light: "#F5F3ED", dark: "#252A35" },
  "sidebar-accent-foreground": { light: "#1B1F2A", dark: "#F2EFE8" },
  "sidebar-border": { light: "#E3DFD5", dark: "#2E333F" },
  "sidebar-ring": { light: "#D85A30", dark: "#E8774F" },
  // Case status colours: the dot and border of a status badge and the progress line.
  "case-draft": { light: "#6B6F7A", dark: "#A3A7B1" },
  "case-discovery": { light: "#3F5FBF", dark: "#7C9CF5" },
  "case-pre-flight-audit": { light: "#3F5FBF", dark: "#7C9CF5" },
  "case-awaiting-mandate": { light: "#9A6700", dark: "#E0A23A" },
  "case-channel-planning": { light: "#9A6700", dark: "#E0A23A" },
  "case-executing": { light: "#2563EB", dark: "#60A5FA" },
  "case-receipt-acquisition": { light: "#2563EB", dark: "#60A5FA" },
  "case-awaiting-verification": { light: "#0F766E", dark: "#2DD4BF" },
  "case-succeeded": { light: "#1F7A3D", dark: "#4ADE80" },
  "case-failed": { light: "#B42318", dark: "#F28B82" },
  "case-withdrawn": { light: "#6B6F7A", dark: "#A3A7B1" },
  "case-disputed": { light: "#C2410C", dark: "#FB923C" },
} as const satisfies Record<string, ThemeValues>;

export type TokenName = keyof typeof tokens;

export interface ContrastPair {
  /** Token drawn as text or the meaningful foreground. */
  foreground: TokenName;
  /** Token it is drawn on. */
  background: TokenName;
  /** Minimum WCAG contrast ratio: 4.5 for text, 3.0 for large text and UI. */
  minimum: number;
}

/** Every pair `make contrast` checks in both themes. */
const contrastPairs: ContrastPair[] = [
  { foreground: "foreground", background: "background", minimum: 4.5 },
  { foreground: "card-foreground", background: "card", minimum: 4.5 },
  { foreground: "popover-foreground", background: "popover", minimum: 4.5 },
  { foreground: "primary-foreground", background: "primary", minimum: 4.5 },
  { foreground: "secondary-foreground", background: "secondary", minimum: 4.5 },
  { foreground: "muted-foreground", background: "background", minimum: 4.5 },
  { foreground: "muted-foreground", background: "muted", minimum: 4.5 },
  { foreground: "accent-foreground", background: "accent", minimum: 4.5 },
  { foreground: "destructive-foreground", background: "destructive", minimum: 4.5 },
  { foreground: "accent", background: "background", minimum: 4.5 },
  { foreground: "destructive", background: "background", minimum: 4.5 },
  { foreground: "sidebar-foreground", background: "sidebar", minimum: 4.5 },
  { foreground: "sidebar-primary-foreground", background: "sidebar-primary", minimum: 4.5 },
  { foreground: "sidebar-accent-foreground", background: "sidebar-accent", minimum: 4.5 },
  { foreground: "cut", background: "background", minimum: 3 },
  { foreground: "ring", background: "background", minimum: 3 },
  { foreground: "case-draft", background: "background", minimum: 3 },
  { foreground: "case-discovery", background: "background", minimum: 3 },
  { foreground: "case-pre-flight-audit", background: "background", minimum: 3 },
  { foreground: "case-awaiting-mandate", background: "background", minimum: 3 },
  { foreground: "case-channel-planning", background: "background", minimum: 3 },
  { foreground: "case-executing", background: "background", minimum: 3 },
  { foreground: "case-receipt-acquisition", background: "background", minimum: 3 },
  { foreground: "case-awaiting-verification", background: "background", minimum: 3 },
  { foreground: "case-succeeded", background: "background", minimum: 3 },
  { foreground: "case-failed", background: "background", minimum: 3 },
  { foreground: "case-withdrawn", background: "background", minimum: 3 },
  // The dispute warning label is drawn as text in this colour.
  { foreground: "case-disputed", background: "background", minimum: 4.5 },
];

const hexPattern = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;

/** Relative luminance of a #RRGGBB colour, following the WCAG definition. */
function relativeLuminance(color: string): number {
  const match = hexPattern.exec(color);
  if (!match) throw new Error(`Token value is not #RRGGBB: ${color}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => {
    const v = Number.parseInt(part ?? "", 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #RRGGBB colours, from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

export interface PairResult extends ContrastPair {
  theme: "light" | "dark";
  ratio: number;
  pass: boolean;
}

/** Check every contrast pair in both themes. */
export function checkContrastPairs(): PairResult[] {
  const results: PairResult[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const pair of contrastPairs) {
      const ratio = contrastRatio(tokens[pair.foreground][theme], tokens[pair.background][theme]);
      results.push({ ...pair, theme, ratio, pass: ratio >= pair.minimum });
    }
  }
  return results;
}
