import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The AWS SDK and Anthropic SDK are Node-only; keep them out of the bundle
  // that gets traced into the serverless output.
  serverExternalPackages: [
    "@aws-sdk/client-s3",
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/client-textract",
    "@anthropic-ai/bedrock-sdk",
  ],
};

export default nextConfig;
