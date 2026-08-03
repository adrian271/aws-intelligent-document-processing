/**
 * Stage 2 of the pipeline: classification + structured extraction.
 *
 * Textract tells us what characters are on the page. It does not know that
 * "Amount Due" and "Balance Payable" are the same field, or that this page is
 * an invoice rather than a receipt. That semantic step is what the model does.
 *
 * Two things make this trustworthy rather than a black box:
 *
 *  1. Structured output. The response is constrained to a JSON Schema built
 *     from schemas.ts, so we never parse free text and never get a field we
 *     didn't ask for.
 *  2. Grounding. We require the model to return the verbatim `sourceText` it
 *     read each value from, and we check that text actually appears in the OCR
 *     output. A value the model invented cannot survive that check — this is
 *     the concrete defence against hallucinated fields.
 *
 * The model call itself lives in providers.ts, so this file is the same
 * regardless of which Bedrock model is doing the work.
 */

import { MODEL_ID } from "./aws";
import { generateStructured } from "./providers";
import { DOC_TYPES, type DocTypeDef } from "./schemas";
import type { LlmExtraction } from "./types";

/**
 * Build the response schema from the doc-type config. Because the schema is
 * generated, adding a field in schemas.ts automatically teaches the model
 * about it — the two can't drift apart.
 *
 * The schema is deliberately plain: objects, arrays, strings, numbers and
 * enums only. `anyOf`/nullable types are supported by some Bedrock models and
 * silently mishandled by others, so absence is represented as an empty string
 * and normalised back to null in code.
 */
function buildResponseSchema(): Record<string, unknown> {
  const allFieldKeys = Array.from(
    new Set(DOC_TYPES.flatMap((t) => t.fields.map((f) => f.key))),
  );

  return {
    type: "object",
    additionalProperties: false,
    required: ["docType", "docTypeConfidence", "docTypeReasoning", "fields", "tables"],
    properties: {
      docType: {
        type: "string",
        enum: [...DOC_TYPES.map((t) => t.key), "unknown"],
        description: "Which document type this page is.",
      },
      docTypeConfidence: {
        type: "number",
        description: "0 to 1. How sure you are of the classification.",
      },
      docTypeReasoning: {
        type: "string",
        description: "One sentence on what made you pick that type.",
      },
      fields: {
        type: "array",
        description:
          "One entry per field you were asked for. Include every requested field, using an empty string if it is genuinely absent from the document.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "value", "confidence", "sourceText"],
          properties: {
            key: { type: "string", enum: allFieldKeys },
            value: {
              type: "string",
              description:
                "The normalised value, or an empty string if absent. Dates as YYYY-MM-DD. Money as digits and a decimal point only, no currency symbols or thousands separators.",
            },
            confidence: {
              type: "number",
              description:
                "0 to 1. Your confidence that this is the correct value for this field. Be honest — a low score routes the field to a human, which is the desired outcome when you are unsure.",
            },
            sourceText: {
              type: "string",
              description:
                "The exact substring of the document text you read this value from, copied verbatim. Empty string only if the value was inferred rather than read.",
            },
          },
        },
      },
      tables: {
        type: "array",
        description: "Line-item tables, if the document has any.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "headers", "rows"],
          properties: {
            name: { type: "string" },
            headers: { type: "array", items: { type: "string" } },
            rows: {
              type: "array",
              items: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  };
}

function buildPrompt(ocrText: string): string {
  const typeCatalogue = DOC_TYPES.map((t) => {
    const fields = t.fields
      .map((f) => `    - ${f.key} (${f.type}${f.required ? ", required" : ""}): ${f.hint}`)
      .join("\n");
    return `  ${t.key} — ${t.label}\n    ${t.description}\n${fields}`;
  }).join("\n\n");

  return `You are the extraction stage of a document processing pipeline. Below is the OCR output for a single document, including any form fields and tables the OCR engine detected on its own.

Do two things:

1. Classify the document as one of these types (or "unknown" if none fit):

${typeCatalogue}

2. Extract the fields listed for the type you chose. Return an entry for every field of that type — use an empty string for fields genuinely not present on the document. Do not return fields belonging to other document types.

Rules:
- Copy the exact substring you read each value from into sourceText. Do not paraphrase it, reformat it, or reconstruct it from memory. If you cannot point at the text, leave sourceText empty and lower your confidence.
- Never guess a value to fill a gap. An empty value with an honest confidence is more useful to us than a plausible invention, because a human reviews every low-confidence field anyway.
- The OCR may contain errors. If a value looks garbled, extract what is there and lower the confidence rather than silently correcting it.
- Normalise dates to YYYY-MM-DD and money to plain digits with a decimal point.

${ocrText}`;
}

/** Treat blank strings as absent — see the schema note above. */
const orNull = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export async function extractFields(ocrText: string): Promise<LlmExtraction> {
  const raw = (await generateStructured(
    buildPrompt(ocrText),
    buildResponseSchema(),
  ).catch((err) => {
    throw explainBedrockError(err);
  })) as Partial<LlmExtraction>;

  // Normalise defensively: a schema constrains shape, but a model can still
  // return a number where we expect a string, or omit an optional array.
  return {
    docType: typeof raw.docType === "string" ? raw.docType : "unknown",
    docTypeConfidence: clamp01(raw.docTypeConfidence),
    docTypeReasoning: orNull(raw.docTypeReasoning) ?? "",
    fields: (Array.isArray(raw.fields) ? raw.fields : []).map((f) => ({
      key: String(f?.key ?? ""),
      value: orNull(f?.value),
      confidence: clamp01(f?.confidence),
      sourceText: orNull(f?.sourceText),
    })),
    tables: (Array.isArray(raw.tables) ? raw.tables : []).map((t) => ({
      name: String(t?.name ?? ""),
      headers: (t?.headers ?? []).map(String),
      rows: (t?.rows ?? []).map((r) => (Array.isArray(r) ? r.map(String) : [])),
    })),
  };
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Bedrock reports "you haven't done the paperwork" as a generic 403 with a
 * JSON body, which lands in the review UI as an unreadable blob. Anthropic
 * models additionally require a one-time use-case form that no amount of
 * IAM policy will substitute for, so name that explicitly.
 */
function explainBedrockError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);

  if (/not available for this account|permission_error|AccessDenied|403/.test(raw)) {
    return new Error(
      `Bedrock denied access to ${MODEL_ID}. For Anthropic models this is ` +
        `almost always the one-time use-case form rather than an IAM problem: ` +
        `Bedrock console → Model access → Modify model access → select an ` +
        `Anthropic model → Submit use case details. Check with ` +
        `"aws bedrock get-use-case-for-model-access --region <region>". ` +
        `To use a different model instead, set BEDROCK_MODEL_ID in .env.local ` +
        `(e.g. amazon.nova-pro-v1:0) and restart.`,
    );
  }

  if (/could not be found|ResourceNotFound|ValidationException|404/.test(raw)) {
    return new Error(
      `Bedrock rejected the model id "${MODEL_ID}" in this region: ${raw.slice(0, 200)}`,
    );
  }

  return err instanceof Error ? err : new Error(raw);
}

/**
 * Does the model's claimed source text actually appear in the OCR output?
 *
 * Normalising away whitespace, case and punctuation avoids false alarms from
 * trivial reformatting while still catching a value that was never on the page.
 */
export function isGrounded(sourceText: string | null, ocrText: string): boolean {
  if (!sourceText) return false;
  const normalise = (s: string) => s.toLowerCase().replace(/[\s\p{P}]/gu, "");
  const needle = normalise(sourceText);
  if (needle.length === 0) return false;
  return normalise(ocrText).includes(needle);
}

export function docTypeFor(key: string): DocTypeDef | undefined {
  return DOC_TYPES.find((t) => t.key === key);
}
