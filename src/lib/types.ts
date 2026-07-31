/**
 * The shared vocabulary for the whole pipeline.
 *
 * The important idea in an IDP system is that *every* extracted value carries
 * provenance and a confidence score, so a human reviewer can tell at a glance
 * which values to trust and which to check. Nothing here is ever "just a string".
 */

export type DocStatus =
  | "uploaded" // file is in S3, nothing has looked at it yet
  | "processing" // OCR + extraction in flight
  | "needs_review" // machine is done; a human has to sign off
  | "approved" // human accepted (possibly after corrections)
  | "rejected" // human rejected the document outright
  | "failed"; // pipeline blew up; see `error`

/** Where a value came from. Drives the badge in the review UI. */
export type FieldSource =
  | "textract" // OCR read it directly out of a key/value pair
  | "llm" // the model located it in the OCR text
  | "llm_inferred" // the model derived it rather than reading it verbatim
  | "human"; // a reviewer typed it

export interface ExtractedField {
  key: string;
  label: string;
  value: string | null;
  /** 0..1, after combining OCR confidence, model confidence and grounding. */
  confidence: number;
  /** Raw Textract confidence (0..1) for the block this value was traced to. */
  ocrConfidence: number | null;
  /** What the model claims it read the value out of. Used for grounding. */
  sourceText: string | null;
  source: FieldSource;
  /** True when confidence is below threshold or a rule flagged it. */
  needsReview: boolean;
  required: boolean;
}

export interface ExtractedTable {
  name: string;
  headers: string[];
  rows: string[][];
  confidence: number;
}

export type ExceptionSeverity = "error" | "warning";

/**
 * An exception is a machine-detected reason a human must look at this
 * document. Exceptions are the queue that reviewers actually work from.
 */
export interface DocException {
  code: string;
  message: string;
  fieldKey?: string;
  severity: ExceptionSeverity;
}

export interface DocumentRecord {
  id: string;
  filename: string;
  contentType: string;
  s3Key: string;
  sizeBytes: number | null;

  status: DocStatus;
  createdAt: string;
  updatedAt: string;

  /** Key from DOC_TYPES, or null before classification. */
  docType: string | null;
  docTypeConfidence: number | null;

  fields: ExtractedField[];
  tables: ExtractedTable[];
  exceptions: DocException[];

  /** Flat OCR text. Kept so the reviewer can search the source. */
  rawText: string | null;

  processingMs: number | null;
  error: string | null;

  /** Audit trail: which fields a human changed, and when. */
  corrections: Correction[];
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface Correction {
  fieldKey: string;
  from: string | null;
  to: string | null;
  at: string;
}

/** Shape the LLM is constrained to return. See lib/extract.ts. */
export interface LlmExtraction {
  docType: string;
  docTypeConfidence: number;
  docTypeReasoning: string;
  fields: Array<{
    key: string;
    value: string | null;
    confidence: number;
    sourceText: string | null;
  }>;
  tables: Array<{
    name: string;
    headers: string[];
    rows: string[][];
  }>;
}
