import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { PDF_TEXT_ERRORS, PDF_TEXT_LIMITS, PdfTextError, type PdfTextResult, type PdfWorkerReply } from "./pdfTextTypes";
export { PDF_TEXT_LIMITS, PdfTextError, type PdfTextResult } from "./pdfTextTypes";

/** A disposable worker keeps PDF parsing off the Lambda request thread and enforces a hard timeout. */
export async function extractPdfText(bytes: Uint8Array, timeoutMs: number = PDF_TEXT_LIMITS.timeoutMs): Promise<PdfTextResult> {
  if (bytes.byteLength > PDF_TEXT_LIMITS.bytes) throw new PdfTextError("PDF_TOO_LARGE");
  if (!bytes.byteLength || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new PdfTextError("INVALID_PDF");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PDF_TEXT_LIMITS.timeoutMs) throw new Error("Invalid PDF timeout configuration.");
  const data = Uint8Array.from(bytes);
  let worker: Worker;
  try {
    worker = new Worker(join(__dirname, "pdfTextWorker.js"), {
      workerData: data, transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true, stderr: true,
    });
  } catch { throw new PdfTextError("PDF_READ_FAILED"); }
  // Do not forward parser diagnostics; they can contain document text or metadata.
  worker.stdout?.resume(); worker.stderr?.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (failure?: PdfTextError, result?: PdfTextResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate().then(() => {
        if (failure) reject(failure); else resolve(result!);
      }, () => reject(new PdfTextError("PDF_READ_FAILED")));
    };
    const timer = setTimeout(() => finish(new PdfTextError("PDF_TIMEOUT")), timeoutMs);
    worker.once("message", (reply: PdfWorkerReply) => {
      if (reply?.ok && reply.result) finish(undefined, reply.result);
      else finish(new PdfTextError(reply?.ok === false && Object.hasOwn(PDF_TEXT_ERRORS, reply.code) ? reply.code : "PDF_READ_FAILED"));
    });
    worker.once("error", () => finish(new PdfTextError("PDF_READ_FAILED")));
    worker.once("exit", () => { if (!settled) finish(new PdfTextError("PDF_READ_FAILED")); });
  });
}
