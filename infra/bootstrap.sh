#!/usr/bin/env bash
#
# Creates the two AWS resources this POC needs and prints the .env.local to use.
#
#   - S3 bucket      stores uploaded documents; CORS-enabled for presigned PUTs
#   - DynamoDB table one item per document, plus a GSI for newest-first listing
#
# Both sit inside the always-free tier at POC volume. Safe to re-run: every
# step is a no-op if the resource already exists.
#
# Usage:  ./infra/bootstrap.sh [region]

set -euo pipefail

REGION="${1:-${AWS_REGION:-us-east-1}}"
TABLE="${IDP_TABLE:-idp-documents}"

echo "==> Checking credentials"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "    account $ACCOUNT_ID, region $REGION"

# Bucket names are globally unique, so scope it with the account id.
BUCKET="${IDP_BUCKET:-idp-documents-${ACCOUNT_ID}-${REGION}}"

# --- S3 ---------------------------------------------------------------------
echo "==> S3 bucket: $BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "    already exists"
else
  if [ "$REGION" = "us-east-1" ]; then
    # us-east-1 is the one region that rejects a LocationConstraint.
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  echo "    created"
fi

echo "    blocking public access"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# The browser PUTs directly to S3 using a presigned URL, so the bucket itself
# has to allow the cross-origin request. Tighten AllowedOrigins before you
# expose this anywhere real.
echo "    setting CORS for presigned uploads"
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedOrigins": ["http://localhost:3000"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}'

echo "    enabling default encryption"
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Uploaded documents are disposable in a POC; expire them so the free tier
# storage allowance never fills up.
echo "    setting 30-day expiry on uploads/"
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-poc-uploads",
      "Status": "Enabled",
      "Filter": {"Prefix": "uploads/"},
      "Expiration": {"Days": 30}
    }]
  }'

# --- DynamoDB ---------------------------------------------------------------
echo "==> DynamoDB table: $TABLE"
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "    already exists"
else
  # PAY_PER_REQUEST means no provisioned capacity to forget about and no
  # standing charge — at POC volume this stays inside the always-free tier.
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --region "$REGION" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions \
      AttributeName=id,AttributeType=S \
      AttributeName=gsi1pk,AttributeType=S \
      AttributeName=gsi1sk,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --global-secondary-indexes '[{
      "IndexName": "byCreatedAt",
      "KeySchema": [
        {"AttributeName": "gsi1pk", "KeyType": "HASH"},
        {"AttributeName": "gsi1sk", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }]' >/dev/null
  echo "    created, waiting for ACTIVE"
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
fi

# --- Bedrock preflight ------------------------------------------------------
echo "==> Bedrock model access"
if aws bedrock list-foundation-models --region "$REGION" \
     --query "modelSummaries[?contains(modelId, 'anthropic')].modelId" \
     --output text 2>/dev/null | grep -q anthropic; then
  echo "    Anthropic models visible in $REGION"
else
  echo "    WARNING: could not list Anthropic models in $REGION."
  echo "    Enable model access in the Bedrock console:"
  echo "    https://console.aws.amazon.com/bedrock/home?region=$REGION#/modelaccess"
fi

# --- Output -----------------------------------------------------------------
cat <<EOF

==> Done. Write this to .env.local:

AWS_REGION=$REGION
IDP_BUCKET=$BUCKET
IDP_TABLE=$TABLE
BEDROCK_REGION=$REGION
# BEDROCK_MODEL_ID=anthropic.claude-opus-5
# CONFIDENCE_THRESHOLD=0.85

Then: npm run dev
EOF
