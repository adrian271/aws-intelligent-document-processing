/**
 * Stage 1 of the pipeline: OCR.
 *
 * Textract returns a flat list of BLOCKs joined by Relationship edges — it is
 * a graph, not a document. Everything in this file is the work of walking that
 * graph into three useful shapes:
 *
 *   - `text`      flat reading order, for the model and for reviewer search
 *   - `keyValues` form fields Textract detected on its own (with confidence)
 *   - `tables`    reconstructed grids
 *
 * Textract's per-block Confidence is a genuine OCR confidence: how sure it is
 * that it read those characters correctly. It says nothing about whether the
 * value is the right one for the field — that's what stage 2 is for.
 */

import { AnalyzeDocumentCommand, type Block } from "@aws-sdk/client-textract";
import { textract, BUCKET } from "./aws";

export interface KeyValue {
  key: string;
  value: string;
  /** 0..1. The lower of the key block's and value block's OCR confidence. */
  confidence: number;
}

export interface OcrTable {
  headers: string[];
  rows: string[][];
  confidence: number;
}

export interface OcrResult {
  text: string;
  keyValues: KeyValue[];
  tables: OcrTable[];
  pageCount: number;
}

export async function analyzeDocument(s3Key: string): Promise<OcrResult> {
  let res;
  try {
    res = await textract.send(
      new AnalyzeDocumentCommand({
        Document: { S3Object: { Bucket: BUCKET, Name: s3Key } },
        // FORMS gives key/value pairs, TABLES gives grids. Each feature is
        // billed separately, so only ask for what the schema actually needs.
        FeatureTypes: ["FORMS", "TABLES"],
      }),
    );
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "UnsupportedDocumentException") {
      throw new Error(
        "Textract rejected this file. The synchronous AnalyzeDocument API " +
          "handles single-page PDFs and PNG/JPEG/TIFF images only — " +
          "multi-page PDFs need the asynchronous StartDocumentAnalysis flow.",
      );
    }
    throw err;
  }

  const blocks = res.Blocks ?? [];
  const byId = new Map<string, Block>();
  for (const b of blocks) if (b.Id) byId.set(b.Id, b);

  return {
    text: extractText(blocks),
    keyValues: extractKeyValues(blocks, byId),
    tables: extractTables(blocks, byId),
    pageCount: blocks.filter((b) => b.BlockType === "PAGE").length,
  };
}

/** Follow a relationship edge and resolve child blocks. */
function children(block: Block, byId: Map<string, Block>, type = "CHILD"): Block[] {
  const rel = block.Relationships?.find((r) => r.Type === type);
  if (!rel?.Ids) return [];
  return rel.Ids.map((id) => byId.get(id)).filter((b): b is Block => Boolean(b));
}

/** Concatenate the WORD/SELECTION_ELEMENT children of a block into a string. */
function blockText(block: Block, byId: Map<string, Block>): string {
  return children(block, byId)
    .map((child) => {
      if (child.BlockType === "WORD") return child.Text ?? "";
      if (child.BlockType === "SELECTION_ELEMENT") {
        return child.SelectionStatus === "SELECTED" ? "[x]" : "[ ]";
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractText(blocks: Block[]): string {
  return blocks
    .filter((b) => b.BlockType === "LINE" && b.Text)
    .map((b) => b.Text as string)
    .join("\n");
}

/**
 * FORMS output arrives as KEY_VALUE_SET blocks: a KEY block points at its
 * VALUE block through a VALUE relationship, and each points at its WORDs.
 */
function extractKeyValues(blocks: Block[], byId: Map<string, Block>): KeyValue[] {
  const out: KeyValue[] = [];

  for (const block of blocks) {
    if (block.BlockType !== "KEY_VALUE_SET") continue;
    if (!block.EntityTypes?.includes("KEY")) continue;

    const key = blockText(block, byId).trim();
    if (!key) continue;

    const [valueBlock] = children(block, byId, "VALUE");
    const value = valueBlock ? blockText(valueBlock, byId).trim() : "";

    // Take the weaker of the two confidences — a perfectly-read key attached
    // to a badly-read value is still a badly-read pair.
    const confidence = Math.min(
      (block.Confidence ?? 0) / 100,
      (valueBlock?.Confidence ?? block.Confidence ?? 0) / 100,
    );

    out.push({ key: key.replace(/:$/, ""), value, confidence });
  }

  return out;
}

function extractTables(blocks: Block[], byId: Map<string, Block>): OcrTable[] {
  const tables: OcrTable[] = [];

  for (const block of blocks) {
    if (block.BlockType !== "TABLE") continue;

    const cells = children(block, byId).filter((c) => c.BlockType === "CELL");
    if (cells.length === 0) continue;

    const maxRow = Math.max(...cells.map((c) => c.RowIndex ?? 0));
    const maxCol = Math.max(...cells.map((c) => c.ColumnIndex ?? 0));

    const grid: string[][] = Array.from({ length: maxRow }, () =>
      Array.from({ length: maxCol }, () => ""),
    );

    for (const cell of cells) {
      const r = (cell.RowIndex ?? 1) - 1;
      const c = (cell.ColumnIndex ?? 1) - 1;
      if (grid[r]) grid[r][c] = blockText(cell, byId).trim();
    }

    // Textract doesn't reliably tag a header row, so we take row 0 by
    // convention and let the reviewer correct it if that's wrong.
    const [headers = [], ...rows] = grid;

    tables.push({
      headers,
      rows,
      confidence: (block.Confidence ?? 0) / 100,
    });
  }

  return tables;
}

/**
 * Render OCR output as the text we hand to the model. Giving it both the flat
 * text *and* Textract's structured guesses measurably improves extraction over
 * either alone — the key/value pairs anchor the model, the raw text lets it
 * recover from Textract's mistakes.
 */
export function formatForPrompt(ocr: OcrResult): string {
  const parts: string[] = [];

  parts.push("<document_text>", ocr.text, "</document_text>");

  if (ocr.keyValues.length > 0) {
    parts.push(
      "",
      "<detected_form_fields>",
      ...ocr.keyValues.map(
        (kv) => `${kv.key}: ${kv.value}  (ocr_confidence=${kv.confidence.toFixed(2)})`,
      ),
      "</detected_form_fields>",
    );
  }

  ocr.tables.forEach((table, i) => {
    parts.push(
      "",
      `<detected_table index="${i}">`,
      table.headers.join(" | "),
      ...table.rows.map((r) => r.join(" | ")),
      "</detected_table>",
    );
  });

  return parts.join("\n");
}
