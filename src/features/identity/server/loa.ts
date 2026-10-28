import { PageSizes, PDFDocument, type PDFFont, rgb, StandardFonts } from "pdf-lib";

import { MANDATE_ACTION_LABELS, type MandateAction } from "../schemas/mandate";

export interface LoaInput {
  /** Signing date in Asia/Singapore, already formatted. */
  signedDate: string;
  providerName: string;
  delegateName: string;
  serviceType: string;
  /** Vault placeholder tokens; the stored PDF never holds real values. */
  fullNameToken: string;
  nricToken: string;
  accountToken: string;
  actions: MandateAction[];
  /** Expiry date, already formatted. */
  expiresDate: string;
  typedName: string;
  /** Signing timestamp, already formatted. */
  signedAt: string;
  mandateId: string;
}

/** LOA content lines in the order spec 0001 requires. */
export function buildLoaLines(input: LoaInput): string[] {
  return [
    "Letter of Authorisation",
    input.signedDate,
    `To: ${input.providerName}`,
    `I, ${input.fullNameToken}, holder of identification ${input.nricToken}, authorise ${input.delegateName} to act on my behalf for the following account only: ${input.accountToken}, service type ${input.serviceType}.`,
    ...input.actions.map((action) => `- ${MANDATE_ACTION_LABELS[action]}`),
    `This authorisation does not permit opening, upgrading or changing any other service. It expires on ${input.expiresDate}.`,
    input.typedName,
    "Signed electronically",
    input.signedAt,
    `Mandate reference: ${input.mandateId}`,
  ];
}

/** Render the lines as an A4 PDF. The typed name prints in italics. */
export async function renderLoaPdf(lines: string[], signatureName: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const [width, height] = PageSizes.A4;
  const margin = 56;
  const maxWidth = width - margin * 2;
  let page = doc.addPage([width, height]);
  let y = height - margin;
  lines.forEach((line, index) => {
    const font = index === 0 ? bold : line === signatureName ? italic : regular;
    const size = index === 0 ? 16 : 11;
    for (const wrapped of wrapLine(line, font, size, maxWidth)) {
      if (y < margin + size) {
        page = doc.addPage([width, height]);
        y = height - margin;
      }
      page.drawText(wrapped, { x: margin, y, font, size, color: rgb(0, 0, 0) });
      y -= size * 1.5;
    }
    y -= 4;
  });
  return doc.save();
}

function wrapLine(line: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = line.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}
