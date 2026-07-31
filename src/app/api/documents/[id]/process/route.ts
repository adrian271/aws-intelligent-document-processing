import { NextResponse } from "next/server";
import { getDocument } from "@/lib/store";
import { processDocument } from "@/lib/pipeline";
import { toErrorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// OCR plus a model call comfortably exceeds the default budget on a cold page.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/**
 * Run the pipeline synchronously and return the finished document.
 *
 * Synchronous is the right call for a POC: one request, one visible result,
 * no queue to reason about. It is also the first thing you would replace —
 * see "Scaling past the POC" in the README.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const doc = await getDocument(id);
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (doc.status === "processing") {
      return NextResponse.json(
        { error: "This document is already being processed." },
        { status: 409 },
      );
    }

    const processed = await processDocument(doc);
    return NextResponse.json({ document: processed });
  } catch (err) {
    return toErrorResponse(err);
  }
}
