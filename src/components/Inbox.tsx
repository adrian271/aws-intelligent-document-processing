"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { DocumentRecord } from "@/lib/types";

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Uploaded",
  processing: "Processing",
  needs_review: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
  failed: "Failed",
};

export function Inbox() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      if (!res.ok) {
        // The API classifies AWS failures (expired credentials, missing
        // table, Bedrock access) into actionable messages — show them rather
        // than sending the reader to the server logs.
        throw new Error(data.error ?? "Could not load documents.");
      }
      setDocuments((data as { documents: DocumentRecord[] }).documents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Upload is three steps: register the document, PUT the bytes straight to S3
   * with the presigned URL, then trigger the pipeline. Keeping them separate
   * means a failure at any step leaves a document row you can retry from.
   */
  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(`Uploading ${file.name}…`);

      try {
        const registerRes = await fetch("/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          }),
        });

        if (!registerRes.ok) {
          const { error: message } = await registerRes.json();
          throw new Error(message ?? "Failed to register document");
        }

        const { document, uploadUrl } = (await registerRes.json()) as {
          document: DocumentRecord;
          uploadUrl: string;
        };

        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "content-type": file.type },
          body: file,
        });
        if (!putRes.ok) {
          throw new Error(
            "S3 rejected the upload. If this is a CORS error, re-run infra/bootstrap.sh.",
          );
        }

        setBusy(`Extracting ${file.name}… (OCR + model, ~10-30s)`);
        await refresh();

        const processRes = await fetch(`/api/documents/${document.id}/process`, {
          method: "POST",
        });
        if (!processRes.ok) {
          const { error: message } = await processRes.json();
          throw new Error(message ?? "Processing failed");
        }

        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) await upload(file);
    },
    [upload],
  );

  const pending = documents.filter((d) => d.status === "needs_review").length;

  return (
    <>
      <div className="panel">
        <h2>Ingest</h2>
        <div
          className={`dropzone${dragOver ? " over" : ""}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFiles(e.dataTransfer.files);
          }}
        >
          {busy ? (
            <strong>{busy}</strong>
          ) : (
            <>
              <strong>Drop a document here</strong>
              <div style={{ marginTop: 4 }}>
                or click to browse — single-page PDF, PNG, JPEG or TIFF
              </div>
            </>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept="application/pdf,image/png,image/jpeg,image/tiff"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {error && (
          <div className="exception error err-box" style={{ marginTop: 12 }}>
            <span className="code">ERROR</span>
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="spread" style={{ marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>Documents</h2>
          <span className="muted">
            {pending > 0 ? `${pending} awaiting review` : "nothing awaiting review"}
          </span>
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="muted">
            No documents yet. Drop an invoice or receipt above to run the pipeline.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Status</th>
                <th>Exceptions</th>
                <th>Time</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const errors = doc.exceptions.filter((e) => e.severity === "error").length;
                const warnings = doc.exceptions.length - errors;
                return (
                  <tr key={doc.id}>
                    <td>
                      <Link href={`/documents/${doc.id}`}>{doc.filename}</Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {new Date(doc.createdAt).toLocaleString()}
                      </div>
                    </td>
                    <td>
                      {doc.docType ? (
                        <span className="tag">{doc.docType.replace(/_/g, " ")}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${doc.status}`}>
                        {STATUS_LABEL[doc.status] ?? doc.status}
                      </span>
                    </td>
                    <td>
                      {doc.exceptions.length === 0 ? (
                        <span className="muted">clean</span>
                      ) : (
                        <span>
                          {errors > 0 && (
                            <span style={{ color: "var(--err)" }}>{errors} error</span>
                          )}
                          {errors > 0 && warnings > 0 && <span className="muted">, </span>}
                          {warnings > 0 && (
                            <span style={{ color: "var(--warn)" }}>{warnings} warning</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="muted">
                      {doc.processingMs ? `${(doc.processingMs / 1000).toFixed(1)}s` : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link href={`/documents/${doc.id}`}>
                        {doc.status === "needs_review" ? "Review →" : "Open →"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
