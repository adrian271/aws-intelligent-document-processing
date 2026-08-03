import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, bucket } from "@/lib/aws";
import { listDocuments, putDocument } from "@/lib/store";
import { toErrorResponse } from "@/lib/errors";
import type { DocumentRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
];

export async function GET() {
  try {
    const documents = await listDocuments();
    return NextResponse.json({ documents });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Register a document and hand back a presigned PUT URL.
 *
 * The browser uploads straight to S3 rather than through this app. That keeps
 * large files out of the function's memory and off its request-size limit —
 * the same reason you'd do it in production, and the reason bootstrap.sh has
 * to configure CORS on the bucket.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    filename?: string;
    contentType?: string;
    sizeBytes?: number;
  };

  const { filename, contentType, sizeBytes } = body;

  if (!filename || !contentType) {
    return NextResponse.json(
      { error: "filename and contentType are required" },
      { status: 400 },
    );
  }

  if (!ALLOWED_TYPES.includes(contentType)) {
    return NextResponse.json(
      { error: `Unsupported file type ${contentType}. Allowed: ${ALLOWED_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  const id = randomUUID();
  const s3Key = `uploads/${id}/${sanitise(filename)}`;
  const now = new Date().toISOString();

  const doc: DocumentRecord = {
    id,
    filename,
    contentType,
    s3Key,
    sizeBytes: sizeBytes ?? null,
    status: "uploaded",
    createdAt: now,
    updatedAt: now,
    docType: null,
    docTypeConfidence: null,
    fields: [],
    tables: [],
    exceptions: [],
    rawText: null,
    processingMs: null,
    error: null,
    corrections: [],
    reviewedBy: null,
    reviewedAt: null,
  };

  try {
    await putDocument(doc);

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket(), Key: s3Key, ContentType: contentType }),
      { expiresIn: 300 },
    );

    return NextResponse.json({ document: doc, uploadUrl }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** S3 keys tolerate most characters, but predictable keys are easier to debug. */
function sanitise(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}
