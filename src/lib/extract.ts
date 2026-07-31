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
 */

import { bedrock, MODEL_ID } from "./aws";
import { DOC_TYPES, type DocTypeDef } from "./schemas";
import type { LlmExtraction } from "./types";

/**
 * Build the response schema from the doc-type config. Because the schema is
 * generated, adding a field in schemas.ts automatically teaches the model
 * about it — the two can't drift apart.
 */
function buildResponseSchema() {
  const allFieldKeys = Array.from(
    new Set(DOC_TYPES.flatMap((t) => t.fields.map((f) => f.key))),
  );

  const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

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
          "One entry per field you were asked for. Include every requested field, using a null value if it is genuinely absent from the document.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "value", "confidence", "sourceText"],
          properties: {
            key: { type: "string", enum: allFieldKeys },
            value: {
              ...nullableString,
              description:
                "The normalised value. Dates as YYYY-MM-DD. Money as digits and a decimal point only, no currency symbols or thousands separators.",
            },
            confidence: {
              type: "number",
              description:
                "0 to 1. Your confidence that this is the correct value for this field. Be honest — a low score routes the field to a human, which is the desired outcome when you are unsure.",
            },
            sourceText: {
              ...nullableString,
              description:
                "The exact substring of the document text you read this value from, copied verbatim. Null only if the value was inferred rather than read.",
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

2. Extract the fields listed for the type you chose. Return an entry for every field of that type — use a null value for fields genuinely not present on the document. Do not return fields belonging to other document types.

Rules:
- Copy the exact substring you read each value from into sourceText. Do not paraphrase it, reformat it, or reconstruct it from memory. If you cannot point at the text, set sourceText to null and lower your confidence.
- Never guess a value to fill a gap. A null with an honest explanation is more useful to us than a plausible invention, because a human reviews every low-confidence field anyway.
- The OCR may contain errors. If a value looks garbled, extract what is there and lower the confidence rather than silently correcting it.
- Normalise dates to YYYY-MM-DD and money to plain digits with a decimal point.

${ocrText}`;
}

export async function extractFields(ocrText: string): Promise<LlmExtraction> {
  const response = await bedrock.messages.create({
    model: MODEL_ID,
    max_tokens: 8000,
    // Extraction is a well-scoped task with the answer sitting in the context,
    // so low effort is both cheaper and faster with no measurable accuracy
    // cost here. Raise this if you add reasoning-heavy validation rules.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: buildResponseSchema() },
    },
    messages: [{ role: "user", content: buildPrompt(ocrText) }],
  });

  // Safety classifiers can decline a request; that arrives as a 200 with an
  // empty content array, so check before indexing into it.
  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to process this document.");
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Model returned no text content.");
  }

  return JSON.parse(textBlock.text) as LlmExtraction;
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
