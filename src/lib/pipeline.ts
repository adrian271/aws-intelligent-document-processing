/**
 * The pipeline, end to end.
 *
 *   S3 object
 *     -> Textract          OCR: characters, form fields, tables  (+ OCR confidence)
 *     -> Claude on Bedrock classification + field mapping        (+ model confidence)
 *     -> grounding check   did the model actually read that?     (+ hallucination guard)
 *     -> confidence fusion one number per field
 *     -> validation rules  is the result internally coherent?
 *     -> DynamoDB          needs_review | approved | failed
 *
 * It runs inline in a request handler because that is the clearest way to read
 * it. See the README for what to change when documents get bigger than that.
 */

import { analyzeDocument, formatForPrompt, type KeyValue } from "./textract";
import { extractFields, isGrounded } from "./extract";
import { getDocType, CONFIDENCE_THRESHOLD } from "./schemas";
import { validate, canAutoApprove } from "./validate";
import { updateDocument } from "./store";
import type { DocumentRecord, ExtractedField, FieldSource } from "./types";

export async function processDocument(doc: DocumentRecord): Promise<DocumentRecord> {
  const startedAt = Date.now();
  await updateDocument(doc.id, { status: "processing", error: null });

  try {
    // --- 1. OCR ------------------------------------------------------------
    const ocr = await analyzeDocument(doc.s3Key);

    // --- 2. Classify + extract --------------------------------------------
    const llm = await extractFields(formatForPrompt(ocr));
    const type = getDocType(llm.docType);

    // Ground against everything Textract saw, not just flat reading order.
    // On a multi-column page, reading order interleaves the columns, so a
    // value the model correctly read from a right-hand block is not
    // contiguous in `ocr.text` and would be wrongly rejected. Textract's
    // key/value pairs and table cells preserve the grouping that reading
    // order destroys, so include them in the corpus.
    const groundingCorpus = [
      ocr.text,
      ...ocr.keyValues.map((kv) => `${kv.key} ${kv.value}`),
      ...ocr.tables.flatMap((t) => [t.headers.join(" "), ...t.rows.map((r) => r.join(" "))]),
    ].join("\n");

    // --- 3 & 4. Ground each value, then fuse confidences -------------------
    const fields: ExtractedField[] = type.fields.map((def) => {
      const raw = llm.fields.find((f) => f.key === def.key);
      const grounded = isGrounded(raw?.sourceText ?? null, groundingCorpus);
      const ocrConfidence = matchOcrConfidence(raw?.sourceText ?? null, ocr.keyValues);

      const { confidence, source } = fuseConfidence({
        modelConfidence: raw?.confidence ?? 0,
        ocrConfidence,
        grounded,
        hasValue: Boolean(raw?.value),
      });

      return {
        key: def.key,
        label: def.label,
        value: raw?.value ?? null,
        confidence,
        ocrConfidence,
        sourceText: raw?.sourceText ?? null,
        source,
        needsReview: Boolean(raw?.value) && confidence < CONFIDENCE_THRESHOLD,
        required: def.required,
      };
    });

    // --- 5. Validate -------------------------------------------------------
    const exceptions = validate(type.key, fields);

    // Missing required fields are review items too, even with no value to score.
    for (const field of fields) {
      if (field.required && !field.value) field.needsReview = true;
    }

    const tables = llm.tables.map((t, i) => ({
      name: t.name || `Table ${i + 1}`,
      headers: t.headers,
      rows: t.rows,
      confidence: ocr.tables[i]?.confidence ?? 0,
    }));

    const status = canAutoApprove(fields, exceptions) ? "approved" : "needs_review";

    const updated = await updateDocument(doc.id, {
      status,
      docType: type.key === "unknown" ? null : type.key,
      docTypeConfidence: llm.docTypeConfidence,
      fields,
      tables,
      exceptions,
      rawText: ocr.text,
      processingMs: Date.now() - startedAt,
      error: null,
    });

    return updated ?? doc;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await updateDocument(doc.id, {
      status: "failed",
      error: message,
      processingMs: Date.now() - startedAt,
    });
    return updated ?? doc;
  }
}

/**
 * If the model's source text lines up with a form field Textract detected, we
 * get a real OCR confidence for that specific value. When it doesn't, we have
 * no character-level signal and fall back to the model's own score.
 */
function matchOcrConfidence(
  sourceText: string | null,
  keyValues: KeyValue[],
): number | null {
  if (!sourceText) return null;
  const normalise = (s: string) => s.toLowerCase().replace(/[\s\p{P}]/gu, "");
  const needle = normalise(sourceText);
  if (!needle) return null;

  // Match against the most *specific* pair rather than the first one that
  // happens to overlap. Two traps here, both of which silently poison every
  // field if you get them wrong:
  //
  //  - An empty candidate must be skipped. `"anything".includes("")` is true,
  //    so a form field Textract detected but couldn't read a value for would
  //    otherwise match every field on the page and hand its (low) confidence
  //    to all of them.
  //  - Longest match wins. Short values like a currency code appear inside
  //    many longer strings, so first-match would attach the wrong confidence.
  let best: KeyValue | null = null;
  let bestLength = 0;

  for (const kv of keyValues) {
    const value = normalise(kv.value);
    if (value.length === 0) continue;

    const pair = normalise(`${kv.key}${kv.value}`);
    if (!pair.includes(needle) && !needle.includes(value)) continue;

    if (value.length > bestLength) {
      best = kv;
      bestLength = value.length;
    }
  }

  return best ? best.confidence : null;
}

/**
 * Combine the two independent signals into the one number the UI shows.
 *
 * The rule is deliberately pessimistic: a field is only as trustworthy as its
 * weakest link. Perfect OCR of the wrong number and a confident model reading
 * smudged characters are both failures, and taking the minimum catches both.
 */
function fuseConfidence(input: {
  modelConfidence: number;
  ocrConfidence: number | null;
  grounded: boolean;
  hasValue: boolean;
}): { confidence: number; source: FieldSource } {
  const { modelConfidence, ocrConfidence, grounded, hasValue } = input;

  if (!hasValue) return { confidence: 0, source: "llm" };

  // Not traceable to the page: the model produced this from inference or from
  // nothing at all. Cap it hard so it always reaches a human.
  if (!grounded) {
    return { confidence: Math.min(modelConfidence, 0.5), source: "llm_inferred" };
  }

  if (ocrConfidence !== null) {
    return {
      confidence: Math.min(modelConfidence, ocrConfidence),
      source: "textract",
    };
  }

  // Grounded in the raw text but not in a detected form field — slightly less
  // certain than a clean key/value match, so apply a small penalty.
  return { confidence: modelConfidence * 0.95, source: "llm" };
}
