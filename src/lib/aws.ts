/**
 * One place where every AWS client is constructed.
 *
 * Credentials are resolved by the default AWS provider chain — env vars, then
 * `~/.aws/credentials`, then SSO, then (once deployed) the Lambda execution
 * role. There is deliberately no key handling in this file: when this app
 * moves to Lambda in phase 5, nothing here changes.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TextractClient } from "@aws-sdk/client-textract";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

export const REGION = process.env.AWS_REGION ?? "us-east-1";

/**
 * Resolved lazily, on purpose.
 *
 * Reading these at module scope would throw while the route module is still
 * being imported — before any handler's try/catch exists — and the framework
 * would serve an HTML error page instead of our JSON. Calling them inside a
 * handler keeps a missing variable on the same path as every other failure.
 */
export const bucket = () => requireEnv("IDP_BUCKET");
export const table = () => requireEnv("IDP_TABLE");

/**
 * Bedrock model id. Bedrock prefixes Anthropic model ids with `anthropic.`.
 * Override with BEDROCK_MODEL_ID to trade cost for capability.
 */
export const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-opus-5";

/** Bedrock is not enabled in every region; let it be set independently. */
export const BEDROCK_REGION = process.env.BEDROCK_REGION ?? REGION;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Run ./infra/bootstrap.sh, copy the block it prints into .env.local, ` +
        `then restart the dev server (Next only reads .env.local at startup).`,
    );
  }
  return value;
}

// Clients are cheap to hold onto and reuse their connection pools, so we
// create them once per process rather than per request.
export const s3 = new S3Client({ region: REGION });
export const textract = new TextractClient({ region: REGION });
// The Mantle client speaks the Messages API against Bedrock. (The plain
// `AnthropicBedrock` client is the legacy InvokeModel path — same models,
// older request shape.)
export const bedrock = new AnthropicBedrockMantle({ awsRegion: BEDROCK_REGION });

export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  {
    // DynamoDB has no concept of "empty string" or "undefined"; strip them so
    // optional fields round-trip cleanly.
    marshallOptions: { removeUndefinedValues: true },
  },
);
