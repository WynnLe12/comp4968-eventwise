import { parentPort, workerData } from "node:worker_threads";
import { PDF_TEXT_LIMITS, PdfTextError, type PdfTextResult, type PdfWorkerReply } from "./pdfTextTypes";

interface TextReader {
  read(): Promise<{ done: boolean; value?: { items: { str?: string; hasEOL?: boolean }[] } }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}
interface TextPage {
  streamTextContent(options: Record<string, unknown>): { getReader(): TextReader };
  cleanup(): void;
}
interface TextDocument {
  numPages: number;
  getPage(page: number): Promise<TextPage>;
  loadingTask: { destroy(): Promise<void> };
}
// Only text APIs are used. The optional native canvas package is not needed at runtime.
interface PdfLibrary { getDocumentProxy(data: Uint8Array, options: Record<string, unknown>): Promise<TextDocument> }

async function read(): Promise<PdfTextResult> {
  const { getDocumentProxy } = require("unpdf") as PdfLibrary;
  const pdf = await getDocumentProxy(workerData as Uint8Array, {
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    maxImageSize: 0, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    useWorkerFetch: false, verbosity: 0,
  });
  try {
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new PdfTextError("INVALID_PDF");
    if (pdf.numPages > PDF_TEXT_LIMITS.pages) throw new PdfTextError("PDF_PAGE_LIMIT");
    const pages: PdfTextResult["pages"] = [], emptyPageNumbers: number[] = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      const chunks: string[] = [];
      let completed = false;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) { completed = true; break; }
          for (const item of result.value?.items ?? []) {
            if (typeof item.str !== "string") continue;
            const value = item.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "") + (item.hasEOL ? "\n" : " ");
            characterCount += value.length;
            if (characterCount > PDF_TEXT_LIMITS.characters) throw new PdfTextError("PDF_TEXT_LIMIT");
            chunks.push(value);
          }
        }
      } finally {
        if (!completed) await reader.cancel().catch(() => undefined);
        reader.releaseLock(); page.cleanup();
      }
      const text = chunks.join("").replace(/[ \t]+\n/g, "\n").trim();
      if (!/[\p{L}\p{N}]/u.test(text)) emptyPageNumbers.push(pageNumber);
      pages.push({ pageNumber, text });
      characterCount += 2;
      if (characterCount > PDF_TEXT_LIMITS.characters) throw new PdfTextError("PDF_TEXT_LIMIT");
    }
    if (emptyPageNumbers.length === pdf.numPages) throw new PdfTextError("PDF_NO_TEXT");
    return { pageCount: pdf.numPages, pages, text: pages.map(page => page.text).join("\n\n"), emptyPageNumbers };
  } finally { await pdf.loadingTask.destroy(); }
}

if (parentPort) {
  const port = parentPort;
  void read().then(result => port.postMessage({ ok: true, result } satisfies PdfWorkerReply), error => {
    const code = error instanceof PdfTextError ? error.code : error instanceof Error && error.name === "PasswordException" ? "PDF_PASSWORD_REQUIRED" : "PDF_READ_FAILED";
    port.postMessage({ ok: false, code } satisfies PdfWorkerReply);
  });
}
