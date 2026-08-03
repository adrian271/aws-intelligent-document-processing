"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfidenceBar } from "./ConfidenceBar";
import { fetchJson } from "@/lib/fetchJson";
import type { DocumentRecord } from "@/lib/types";

const SOURCE_LABEL: Record<string, string> = {
  textract: "OCR",
  llm: "model",
  llm_inferred: "inferred",
  human: "human",
};

export function ReviewScreen({
  document: initial,
  previewUrl,
}: {
  document: DocumentRecord;
  previewUrl: string;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState(initial);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = Object.keys(edits).length > 0;
  const blocking = doc.exceptions.filter((e) => e.severity === "error");

  async function send(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const data = await fetchJson<{ document: DocumentRecord }>(
        `/api/documents/${doc.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      setDoc(data.document);
      setEdits({});
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reprocess() {
    setBusy(true);
    setError(null);
    try {
      const data = await fetchJson<{ document: DocumentRecord }>(
        `/api/documents/${doc.id}/process`,
        { method: "POST" },
      );
      setDoc(data.document);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const isImage = doc.contentType.startsWith("image/");

  return (
    <>
      <div className="panel spread">
        <div>
          <strong>{doc.filename}</strong>
          <div className="row muted" style={{ fontSize: 12, marginTop: 4 }}>
            <span className={`badge ${doc.status}`}>{doc.status.replace(/_/g, " ")}</span>
            {doc.docType && <span className="tag">{doc.docType.replace(/_/g, " ")}</span>}
            {doc.docTypeConfidence !== null && (
              <span>classified at {(doc.docTypeConfidence * 100).toFixed(0)}%</span>
            )}
            {doc.processingMs && <span>{(doc.processingMs / 1000).toFixed(1)}s</span>}
            {doc.reviewedAt && (
              <span>
                reviewed by {doc.reviewedBy} on {new Date(doc.reviewedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        <div className="row">
          <button onClick={() => void reprocess()} disabled={busy}>
            Re-run pipeline
          </button>
          <button
            className="danger"
            onClick={() => void send({ decision: "reject" })}
            disabled={busy || doc.status === "rejected"}
          >
            Reject
          </button>
          <button
            className="primary"
            onClick={() =>
              void send({ fields: edits, decision: "approve", reviewer: "local" })
            }
            disabled={busy || blocking.length > 0 || doc.status === "approved"}
            title={
              blocking.length > 0
                ? "Resolve the blocking exceptions first"
                : "Approve this document"
            }
          >
            {dirty ? "Save & approve" : "Approve"}
          </button>
        </div>
      </div>

      {error && (
        <div className="exception error err-box">
          <span className="code">ERROR</span>
          <span>{error}</span>
        </div>
      )}

      {doc.status === "failed" && doc.error && (
        <div className="panel err-box">
          <h2 style={{ color: "var(--err)" }}>Pipeline failed</h2>
          <p style={{ margin: 0 }}>{doc.error}</p>
        </div>
      )}

      {doc.exceptions.length > 0 && (
        <div className="panel">
          <h2>Exceptions — {doc.exceptions.length}</h2>
          {doc.exceptions.map((ex, i) => (
            <div key={`${ex.code}-${i}`} className={`exception ${ex.severity}`}>
              <span className="code">{ex.code}</span>
              <span>{ex.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="split">
        <div>
          <div className="panel">
            <h2>Extracted fields</h2>
            {doc.fields.length === 0 ? (
              <p className="muted">
                Nothing extracted yet. Run the pipeline to populate this.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "24%" }}>Field</th>
                    <th>Value</th>
                    <th style={{ width: 150 }}>Confidence</th>
                    <th style={{ width: 80 }}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.fields.map((field) => {
                    const current = edits[field.key] ?? field.value ?? "";
                    return (
                      <tr key={field.key}>
                        <td>
                          {field.label}
                          {field.required && (
                            <span style={{ color: "var(--err)" }} title="Required"> *</span>
                          )}
                        </td>
                        <td>
                          <input
                            type="text"
                            className={field.needsReview ? "flagged" : ""}
                            value={current}
                            placeholder="—"
                            onChange={(e) =>
                              setEdits((prev) => ({ ...prev, [field.key]: e.target.value }))
                            }
                          />
                          {field.sourceText && field.source !== "human" && (
                            <div
                              className="muted"
                              style={{ fontSize: 11, marginTop: 3 }}
                              title="Verbatim text the model says it read this from"
                            >
                              read from: “{field.sourceText}”
                            </div>
                          )}
                        </td>
                        <td>
                          <ConfidenceBar value={edits[field.key] !== undefined ? 1 : field.confidence} />
                          {field.ocrConfidence !== null && (
                            <div className="muted" style={{ fontSize: 11 }}>
                              OCR {(field.ocrConfidence * 100).toFixed(0)}%
                            </div>
                          )}
                        </td>
                        <td>
                          <span className="tag">
                            {edits[field.key] !== undefined
                              ? "human"
                              : SOURCE_LABEL[field.source] ?? field.source}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {dirty && (
              <div className="row" style={{ marginTop: 14 }}>
                <button onClick={() => void send({ fields: edits })} disabled={busy}>
                  Save corrections
                </button>
                <button onClick={() => setEdits({})} disabled={busy}>
                  Discard
                </button>
                <span className="muted">
                  {Object.keys(edits).length} field(s) edited
                </span>
              </div>
            )}
          </div>

          {doc.tables.map((table, i) => (
            <div className="panel" key={i}>
              <h2>{table.name}</h2>
              <table>
                <thead>
                  <tr>
                    {table.headers.map((h, j) => (
                      <th key={j}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {doc.corrections.length > 0 && (
            <div className="panel">
              <h2>Audit trail</h2>
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Was</th>
                    <th>Became</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.corrections.map((c, i) => (
                    <tr key={i}>
                      <td>{c.fieldKey}</td>
                      <td className="muted">{c.from ?? "—"}</td>
                      <td>{c.to ?? "—"}</td>
                      <td className="muted">{new Date(c.at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {doc.rawText && (
            <div className="panel">
              <h2>OCR text</h2>
              <pre className="raw">{doc.rawText}</pre>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Source document</h2>
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="preview img" src={previewUrl} alt={doc.filename} />
          ) : (
            <iframe className="preview" src={previewUrl} title={doc.filename} />
          )}
        </div>
      </div>
    </>
  );
}
