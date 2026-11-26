export const PDF_TEXT_LIMITS = {
  bytes: 10 * 1024 * 1024,
  pages: 50,
  characters: 200000,
  timeoutMs: 10000,
} as const;

export const PDF_TEXT_ERRORS = {
  INVALID_PDF: "This file could not be read as a PDF. Enter the contract details manually.",
  PDF_TOO_LARGE: "Choose a PDF up to 10 MB, or enter the details manually.",
  PDF_PAGE_LIMIT: "This PDF has more than 50 pages. Enter the contract details manually.",
  PDF_TEXT_LIMIT: "This PDF contains too much text to extract. Enter the contract details manually.",
  PDF_TIMEOUT: "Reading the PDF took too long. Enter the details manually or try another file.",
  PDF_PASSWORD_REQUIRED: "This PDF is password protected. Use an unlocked copy or enter the details manually.",
  PDF_NO_TEXT: "No selectable text was found. Scanned PDFs need manual entry until OCR is available.",
  PDF_READ_FAILED: "The PDF could not be read. Enter the contract details manually.",
} as const;
export type PdfTextErrorCode = keyof typeof PDF_TEXT_ERRORS;
export class PdfTextError extends Error {
  constructor(public readonly code: PdfTextErrorCode) { super(PDF_TEXT_ERRORS[code]); this.name = "PdfTextError"; }
}
export interface PdfPageText { pageNumber: number; text: string }
export interface PdfTextResult {
  pageCount: number;
  pages: PdfPageText[];
  text: string;
  /** A PDF can mix selectable text with scans. Never imply all pages were read. */
  emptyPageNumbers: number[];
}
export type PdfWorkerReply = { ok: true; result: PdfTextResult } | { ok: false; code: PdfTextErrorCode };
