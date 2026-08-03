import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, bucket } from "@/lib/aws";
import { getDocument, updateDocument } from "@/lib/store";
import { validate } from "@/lib/validate";
import { toErrorResponse } from "@/lib/errors";
import type { Correction, DocStatus, ExtractedField } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const doc = await getDocument(id);
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Short-lived read URL so the reviewer can see the original next to the
    // extracted values. The bucket itself stays private.
    const previewUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket(), Key: doc.s3Key }),
      { expiresIn: 900 },
    );

    return NextResponse.json({ document: doc, previewUrl });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * The human-in-the-loop endpoint: apply corrections and/or record a decision.
 *
 * A corrected field jumps to confidence 1 with source "human" — that's the
 * whole point of review. Every change is appended to `corrections`, which is
 * both the audit trail and, in a real deployment, your training signal for
 * finding fields the extractor is chronically bad at.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const doc = await getDocument(id);
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = (await request.json()) as {
      fields?: Record<string, string | null>;
      docType?: string;
      decision?: "approve" | "reject";
      reviewer?: string;
    };

    const now = new Date().toISOString();
    const corrections: Correction[] = [...doc.corrections];
    let fields: ExtractedField[] = doc.fields;

    if (body.fields) {
      fields = doc.fields.map((field) => {
        if (!(field.key in body.fields!)) return field;

        const next = body.fields![field.key];
        const normalised = next?.trim() ? next.trim() : null;
        if (normalised === field.value) return field;

        corrections.push({ fieldKey: field.key, from: field.value, to: normalised, at: now });

        return {
          ...field,
          value: normalised,
          confidence: normalised ? 1 : 0,
          source: "human" as const,
          needsReview: false,
        };
      });
    }

    const docType = body.docType ?? doc.docType;

    // Re-run the rules over the corrected values — fixing one field can clear
    // an arithmetic exception attached to another.
    const exceptions = validate(docType, fields);

    let status: DocStatus = doc.status;
    let reviewedBy = doc.reviewedBy;
    let reviewedAt = doc.reviewedAt;

    if (body.decision === "approve") {
      const blocking = exceptions.filter((e) => e.severity === "error");
      if (blocking.length > 0) {
        return NextResponse.json(
          {
            error: "Cannot approve while blocking exceptions remain.",
            exceptions: blocking,
          },
          { status: 409 },
        );
      }
      status = "approved";
      reviewedBy = body.reviewer ?? "reviewer";
      reviewedAt = now;
    } else if (body.decision === "reject") {
      status = "rejected";
      reviewedBy = body.reviewer ?? "reviewer";
      reviewedAt = now;
    }

    const updated = await updateDocument(id, {
      fields,
      docType,
      exceptions,
      corrections,
      status,
      reviewedBy,
      reviewedAt,
    });

    return NextResponse.json({ document: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
