import { NextResponse } from "next/server";

/**
 * Turn an AWS SDK failure into something a human can act on.
 *
 * The three errors you actually hit while setting this up are expired
 * credentials, a missing table/bucket, and Bedrock model access not being
 * enabled. Each has a specific fix, so each gets a specific message rather
 * than a generic 500 that sends you to the server logs.
 */
export function toErrorResponse(err: unknown): NextResponse {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);

  if (name === "CredentialsProviderError" || /credential|expired|security token/i.test(message)) {
    return NextResponse.json(
      {
        error:
          "AWS credentials are missing or expired. Authenticate (e.g. `aws sso login`) and reload.",
        detail: message,
      },
      { status: 401 },
    );
  }

  if (name === "ResourceNotFoundException" || name === "NoSuchBucket") {
    return NextResponse.json(
      {
        error:
          "The S3 bucket or DynamoDB table does not exist. Run infra/bootstrap.sh and check .env.local.",
        detail: message,
      },
      { status: 503 },
    );
  }

  if (name === "AccessDeniedException" || name === "AccessDenied") {
    return NextResponse.json(
      {
        error:
          "AWS denied the request. Check the IAM policy in the README, and that Bedrock model access is enabled for your account and region.",
        detail: message,
      },
      { status: 403 },
    );
  }

  if (/Missing required environment variable/.test(message)) {
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ error: message }, { status: 500 });
}
