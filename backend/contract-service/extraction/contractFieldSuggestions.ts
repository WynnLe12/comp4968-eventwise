import { PDF_TEXT_LIMITS, PdfTextError, type PdfTextResult } from "./pdfTextTypes";

export type SuggestedField = "vendorName" | "totalAmount" | "depositAmount" | "dueDate";
export interface SourceEvidence { pageNumber: number; lineNumber: number; text: string }
export interface ContractFieldSuggestions {
  provider: "pdf-labels-v1";
  reviewRequired: true;
  fields: Record<SuggestedField, string | null>;
  evidence: Partial<Record<SuggestedField, SourceEvidence[]>>;
  warnings: { field: SuggestedField | null; code: "CONFLICTING_VALUES" | "AMBIGUOUS_VALUE" | "VENDOR_FROM_HEADER" | "PARTIAL_TEXT" }[];
}
interface Line extends SourceEvidence {}
interface Candidate { value: string; evidence: SourceEvidence }
const money = /^(?:(?:CAD|USD)\s*)?(?:(?:CA|US|C)?\$\s*)?((?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?)(?:\s*(?:CAD|USD))?$/i;

function parseMoney(raw: string): string | null {
  const match = money.exec(raw.trim());
  if (!match) return null;
  const [whole, fraction = ""] = match[1].replace(/,/g, "").split(".");
  if (!/^(0|[1-9][0-9]{0,9})$/.test(whole)) return null;
  return whole + "." + fraction.padEnd(2, "0");
}
const monthNames = [
  ["jan", "january"], ["feb", "february"], ["mar", "march"], ["apr", "april"], ["may"], ["jun", "june"],
  ["jul", "july"], ["aug", "august"], ["sep", "sept", "september"], ["oct", "october"], ["nov", "november"], ["dec", "december"],
];
function parseDate(raw: string): string | null {
  const value = raw.trim().replace(/\.$/, "");
  let iso = value;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso)) {
    const monthFirst = /^([A-Za-z]+)\.?\s+([0-9]{1,2})(?:,\s*|\s+)([0-9]{4})$/.exec(value);
    const dayFirst = /^([0-9]{1,2})\s+([A-Za-z]+)\.?\s+([0-9]{4})$/.exec(value);
    if (!monthFirst && !dayFirst) return null;
    const month = (monthFirst ? monthFirst[1] : dayFirst![2]).toLowerCase();
    const index = monthNames.findIndex(names => names.includes(month));
    if (index < 0) return null;
    const day = monthFirst ? monthFirst[2] : dayFirst![1];
    iso = (monthFirst ? monthFirst[3] : dayFirst![3]) + "-" + String(index + 1).padStart(2, "0") + "-" + day.padStart(2, "0");
  }
  const date = new Date(iso + "T00:00:00Z");
  return iso.slice(0, 4) >= "1000" && Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}
function businessName(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 150 || !/[A-Za-z]{2}/.test(value) || /[@$]|https?:\/\//i.test(value) ||
      /^(?:invoice|contract|receipt|statement|bill\s+to|customer|client|payment|due\s+date|event\s+date|description|sample|from|to|vendor|supplier)(?:\b|:)/i.test(value)) return null;
  return value;
}

/** Suggests values from labels only. It never assigns DB IDs, changes drafts, or records payments. */
export function suggestContractFields(source: PdfTextResult): ContractFieldSuggestions {
  if (source.pages.length > PDF_TEXT_LIMITS.pages) throw new PdfTextError("PDF_PAGE_LIMIT");
  if (source.pages.reduce((sum, page) => sum + page.text.length, 0) > PDF_TEXT_LIMITS.characters) throw new PdfTextError("PDF_TEXT_LIMIT");
  const lines: Line[] = source.pages.flatMap(page => page.text.split(/\r?\n/).map((text, index) => ({
    pageNumber: page.pageNumber, lineNumber: index + 1, text: text.replace(/\u00a0/g, " ").trim(),
  }))).filter(line => line.text);
  const result: ContractFieldSuggestions = {
    provider: "pdf-labels-v1", reviewRequired: true,
    fields: { vendorName: null, totalAmount: null, depositAmount: null, dueDate: null }, evidence: {}, warnings: [],
  };
  const candidates: Record<SuggestedField, Candidate[]> = { vendorName: [], totalAmount: [], depositAmount: [], dueDate: [] };
  const invalid = new Set<SuggestedField>();
  const totalsDue: Candidate[] = [], payments: (string | null)[] = [];
  let hasExplicitTotal = false, hasVendorLabel = false, invalidTotalDue = false;
  const addWarning = (field: SuggestedField | null, code: ContractFieldSuggestions["warnings"][number]["code"]) => {
    if (!result.warnings.some(warning => warning.field === field && warning.code === code)) result.warnings.push({ field, code });
  };
  function labelled(index: number, raw: string) {
    const line = lines[index], next = lines[index + 1];
    const following = !raw.trim() && next?.pageNumber === line.pageNumber ? next : null;
    return { raw: following ? following.text : raw.trim(), evidence: {
      pageNumber: line.pageNumber, lineNumber: line.lineNumber,
      text: (line.text + (following ? "\n" + following.text : "")).slice(0, 500),
    } };
  }
  function collect(field: SuggestedField, value: string | null, evidence: SourceEvidence) {
    if (value === null) { invalid.add(field); addWarning(field, "AMBIGUOUS_VALUE"); }
    else candidates[field].push({ value, evidence });
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].text;
    const vendor = /^(?:vendor(?:\s+name)?|supplier(?:\s+name)?|service\s+provider|from)\s*(?::\s*(.*))?$/i.exec(line);
    if (vendor) {
      hasVendorLabel = true;
      const value = labelled(index, vendor[1] ?? "");
      collect("vendorName", businessName(value.raw), value.evidence);
    }
    const paid = /^(?:amount\s+paid|payments?\s+received|total\s+paid|deposit\s+(?:paid|received))\s*(?::|=)?\s*(.*)$/i.exec(line);
    if (paid) payments.push(parseMoney(labelled(index, paid[1]).raw));
    const dueTotal = /^total\s+due(?:\s*\([A-Za-z]{3}\))?\s*(?::|=)?\s*(.*)$/i.exec(line);
    if (dueTotal) {
      const value = labelled(index, dueTotal[1]), parsed = parseMoney(value.raw);
      if (parsed === null) invalidTotalDue = true; else totalsDue.push({ value: parsed, evidence: value.evidence });
    } else if (!/^total\s+(?:tax|paid|balance|savings|discount)\b/i.test(line)) {
      const total = /^(?:grand\s+total|contract\s+(?:total|amount)|total\s+contract\s+(?:amount|price)|total\s+amount|invoice\s+total|total(?:\s*\([A-Za-z]{3}\))?)(?:\s*[:=]\s*|\s+|$)(.*)$/i.exec(line);
      if (total) {
        hasExplicitTotal = true;
        const value = labelled(index, total[1]);
        collect("totalAmount", parseMoney(value.raw), value.evidence);
      }
    }
    if (!/^deposit\s+(?:paid|received|refunded|remaining|balance|payments?)\b/i.test(line)) {
      const deposit = /^(?:deposit(?:\s+(?:required|amount|due))?|required\s+deposit)(?:\s*[:=]\s*|\s+|$)(.*)$/i.exec(line);
      if (deposit) {
        const value = labelled(index, deposit[1]);
        collect("depositAmount", parseMoney(value.raw), value.evidence);
      }
    }
    const due = /^(?:payment\s+due\s+date|final\s+payment\s+due(?:\s+date)?|due\s+date|payment\s+due|balance\s+due\s+date)(?:\s*[:=]\s*|\s+|$)(.*)$/i.exec(line)
      ?? /^due\s*[:=]\s*(.*)$/i.exec(line)
      ?? /^(?:full\s+)?payment\s+due\s+(.+)$/i.exec(line)
      ?? /^(?:payment\s+terms\s*:\s*)?(?:full\s+)?payment\s+(?:is\s+)?(?:due\s+)?by\s+(.+)$/i.exec(line);
    if (due) {
      const value = labelled(index, due[1]);
      collect("dueDate", parseDate(value.raw), value.evidence);
    }
  }
  // TOTAL DUE can mean a remaining balance. Only use it without another total when explicitly unpaid.
  if (!hasExplicitTotal && (totalsDue.length || invalidTotalDue)) {
    if (invalidTotalDue || !payments.length || payments.some(value => value !== "0.00")) {
      invalid.add("totalAmount"); addWarning("totalAmount", "AMBIGUOUS_VALUE");
    } else candidates.totalAmount.push(...totalsDue);
  }
  if (!hasVendorLabel && lines[0]?.pageNumber === 1) {
    const header = businessName(lines[0].text);
    if (header && /&|\b(?:ltd|inc|llc|studio|events|florist|design|catering|photography|sound|bakery)\b/i.test(header)) {
      candidates.vendorName.push({ value: header, evidence: { ...lines[0], text: lines[0].text.slice(0, 500) } });
      addWarning("vendorName", "VENDOR_FROM_HEADER");
    }
  }
  for (const field of Object.keys(candidates) as SuggestedField[]) {
    const values = new Set(candidates[field].map(candidate => candidate.value));
    if (values.size > 1) { addWarning(field, "CONFLICTING_VALUES"); continue; }
    if (!invalid.has(field) && values.size === 1) {
      result.fields[field] = candidates[field][0].value;
      result.evidence[field] = candidates[field].map(candidate => candidate.evidence);
    }
  }
  if (result.fields.totalAmount !== null && result.fields.depositAmount !== null &&
      BigInt(result.fields.depositAmount.replace(".", "")) > BigInt(result.fields.totalAmount.replace(".", ""))) {
    result.fields.depositAmount = null; delete result.evidence.depositAmount; addWarning("depositAmount", "AMBIGUOUS_VALUE");
  }
  if (source.emptyPageNumbers.length) addWarning(null, "PARTIAL_TEXT");
  return result;
}
