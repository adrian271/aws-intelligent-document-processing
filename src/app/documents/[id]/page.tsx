import { notFound } from "next/navigation";
import Link from "next/link";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, BUCKET } from "@/lib/aws";
import { getDocument } from "@/lib/store";
import { ReviewScreen } from "@/components/ReviewScreen";

export const dynamic = "force-dynamic";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const document = await getDocument(id);
  if (!document) notFound();

  const previewUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: document.s3Key }),
    { expiresIn: 900 },
  );

  return (
    <>
      <p style={{ marginTop: 0 }}>
        <Link href="/">← All documents</Link>
      </p>
      <ReviewScreen document={document} previewUrl={previewUrl} />
    </>
  );
}
