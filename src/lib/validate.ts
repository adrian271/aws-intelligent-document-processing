/**
 * Stage 3: validation rules and exception generation.
 *
 * Confidence scores tell you how sure the machine is. Validation rules tell you
 * whether the answer is *coherent* — a set of fields can each be extracted with
 * 0.99 confidence and still be wrong together, e.g. a total that doesn't equal
 * subtotal plus tax. Both signals feed the same review queue.
 */

import { getDocType, CONFIDENCE_THRESHOLD } from "./schemas";
import type { DocException, ExtractedField } from "./types";

const money = (fields: ExtractedField[], key: string): number | null => {
  const raw = fields.find((f) => f.key === key)?.value;
  if (!raw) return null;
  const n = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const value = (fields: ExtractedField[], key: string): string | null =>
  fields.find((f) => f.key === key)?.value ?? null;

export function validate(
  docType: string | null,
  fields: ExtractedField[],
): DocException[] {
  const exceptions: DocException[] = [];
  const type = getDocType(docType);

  if (type.key === "unknown") {
    exceptions.push({
      code: "UNCLASSIFIED",
      message:
        "Could not confidently classify this document. Pick a type manually or add it to schemas.ts.",
      severity: "error",
    });
  }

  // --- Rule 1: required fields must be present -----------------------------
  for (const def of type.fields) {
    if (!def.required) continue;
    const field = fields.find((f) => f.key === def.key);
    if (!field?.value) {
      exceptions.push({
        code: "MISSING_REQUIRED_FIELD",
        message: `${def.label} is required but was not found.`,
        fieldKey: def.key,
        severity: "error",
      });
    }
  }

  // --- Rule 2: anything the machine isn't sure about -----------------------
  for (const field of fields) {
    if (field.value && field.confidence < CONFIDENCE_THRESHOLD) {
      exceptions.push({
        code: "LOW_CONFIDENCE",
        message: `${field.label} was extracted with ${(field.confidence * 100).toFixed(0)}% confidence, below the ${(CONFIDENCE_THRESHOLD * 100).toFixed(0)}% threshold.`,
        fieldKey: field.key,
        severity: "warning",
      });
    }
  }

  // --- Rule 3: dates must parse and be plausible ---------------------------
  for (const def of type.fields.filter((f) => f.type === "date")) {
    const raw = value(fields, def.key);
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) {
      exceptions.push({
        code: "INVALID_DATE",
        message: `${def.label} ("${raw}") is not a valid date.`,
        fieldKey: def.key,
        severity: "error",
      });
    } else if (parsed > Date.now() + 1000 * 60 * 60 * 24 * 365) {
      exceptions.push({
        code: "IMPLAUSIBLE_DATE",
        message: `${def.label} is more than a year in the future.`,
        fieldKey: def.key,
        severity: "warning",
      });
    }
  }

  // --- Rule 4: the arithmetic has to work ----------------------------------
  const subtotal = money(fields, "subtotal");
  const tax = money(fields, "tax");
  const tip = money(fields, "tip");
  const total = money(fields, "total");

  if (subtotal !== null && total !== null) {
    const expected = subtotal + (tax ?? 0) + (tip ?? 0);
    if (Math.abs(expected - total) > 0.011) {
      exceptions.push({
        code: "TOTAL_MISMATCH",
        message: `Subtotal ${subtotal.toFixed(2)} + tax ${(tax ?? 0).toFixed(2)}${
          tip !== null ? ` + tip ${tip.toFixed(2)}` : ""
        } = ${expected.toFixed(2)}, but the total reads ${total.toFixed(2)}.`,
        fieldKey: "total",
        severity: "error",
      });
    }
  }

  if (total !== null && total < 0) {
    exceptions.push({
      code: "NEGATIVE_TOTAL",
      message: "Total is negative — this may be a credit note rather than an invoice.",
      fieldKey: "total",
      severity: "warning",
    });
  }

  // --- Rule 5: invoice dates must precede their due date -------------------
  const invoiceDate = value(fields, "invoiceDate");
  const dueDate = value(fields, "dueDate");
  if (invoiceDate && dueDate) {
    const a = Date.parse(invoiceDate);
    const b = Date.parse(dueDate);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b < a) {
      exceptions.push({
        code: "DUE_BEFORE_ISSUE",
        message: "Due date falls before the invoice date.",
        fieldKey: "dueDate",
        severity: "error",
      });
    }
  }

  // --- Rule 6: values the model could not point at in the source -----------
  for (const field of fields) {
    if (field.value && field.source === "llm_inferred") {
      exceptions.push({
        code: "UNGROUNDED_VALUE",
        message: `${field.label} could not be traced to any text on the page. Verify it against the document before approving.`,
        fieldKey: field.key,
        severity: "warning",
      });
    }
  }

  return exceptions;
}

/** A document is clean enough to auto-approve only if nothing flagged it. */
export function canAutoApprove(
  fields: ExtractedField[],
  exceptions: DocException[],
): boolean {
  return exceptions.length === 0 && fields.every((f) => !f.needsReview);
}
