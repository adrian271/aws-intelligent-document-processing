#!/usr/bin/env bash
#
# Deletes everything bootstrap.sh created. The inverse of that script, and
# deliberately noisier: it prints what it found and makes you type the account
# id before anything is destroyed.
#
#   - S3 bucket      emptied (including versions) then deleted
#   - DynamoDB table deleted, along with its GSI
#
# Not touched, because neither is ours to remove and neither costs anything:
#   - Bedrock model agreements (account-level; billed per token, not per
#     subscription). Cancel via AWS Marketplace > Manage subscriptions if you
#     really want them gone.
#   - Textract. It creates no resources at all — you call it, you pay per page.
#
# Usage:  ./infra/teardown.sh [region]

set -euo pipefail

REGION="${1:-${AWS_REGION:-us-east-1}}"
TABLE="${IDP_TABLE:-idp-documents}"

echo "==> Checking credentials"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "    account $ACCOUNT_ID, region $REGION"

BUCKET="${IDP_BUCKET:-idp-documents-${ACCOUNT_ID}-${REGION}}"

# --- Survey before destroying ------------------------------------------------
#
# Show the blast radius first. Deleting a bucket is irreversible and there is no
# undo for a DynamoDB table without a backup, so the confirmation below is worth
# the friction.
echo
echo "==> The following will be PERMANENTLY DELETED:"

BUCKET_EXISTS=0
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  BUCKET_EXISTS=1
  OBJECTS="$(aws s3api list-objects-v2 --bucket "$BUCKET" \
    --query 'length(Contents)' --output text 2>/dev/null || echo 0)"
  [ "$OBJECTS" = "None" ] && OBJECTS=0
  echo "    S3 bucket       $BUCKET ($OBJECTS objects)"
else
  echo "    S3 bucket       $BUCKET — not found, skipping"
fi

TABLE_EXISTS=0
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  TABLE_EXISTS=1
  ITEMS="$(aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" \
    --query 'Table.ItemCount' --output text)"
  # ItemCount is updated roughly every six hours, so it is a hint, not a count.
  echo "    DynamoDB table  $TABLE (~$ITEMS items)"
else
  echo "    DynamoDB table  $TABLE — not found, skipping"
fi

if [ "$BUCKET_EXISTS" = "0" ] && [ "$TABLE_EXISTS" = "0" ]; then
  echo
  echo "==> Nothing to do."
  exit 0
fi

echo
read -r -p "Type the account id ($ACCOUNT_ID) to confirm: " CONFIRM
if [ "$CONFIRM" != "$ACCOUNT_ID" ]; then
  echo "    Aborted, nothing deleted."
  exit 1
fi

# --- S3 ----------------------------------------------------------------------
if [ "$BUCKET_EXISTS" = "1" ]; then
  echo
  echo "==> Emptying $BUCKET"
  aws s3 rm "s3://$BUCKET" --recursive --region "$REGION" >/dev/null

  # A bucket with versioning ever enabled keeps non-current versions and delete
  # markers that `s3 rm` leaves behind, and the bucket delete then fails with a
  # bare BucketNotEmpty. Clear them explicitly.
  VERSIONS="$(aws s3api list-object-versions --bucket "$BUCKET" --region "$REGION" \
    --output json --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' 2>/dev/null || echo '{}')"
  if [ "$(echo "$VERSIONS" | grep -c '"Key"')" -gt 0 ]; then
    echo "    removing non-current versions"
    aws s3api delete-objects --bucket "$BUCKET" --region "$REGION" \
      --delete "$VERSIONS" >/dev/null
  fi

  MARKERS="$(aws s3api list-object-versions --bucket "$BUCKET" --region "$REGION" \
    --output json --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' 2>/dev/null || echo '{}')"
  if [ "$(echo "$MARKERS" | grep -c '"Key"')" -gt 0 ]; then
    echo "    removing delete markers"
    aws s3api delete-objects --bucket "$BUCKET" --region "$REGION" \
      --delete "$MARKERS" >/dev/null
  fi

  echo "==> Deleting bucket $BUCKET"
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
  echo "    deleted"
fi

# --- DynamoDB ----------------------------------------------------------------
if [ "$TABLE_EXISTS" = "1" ]; then
  echo
  echo "==> Deleting table $TABLE"
  aws dynamodb delete-table --table-name "$TABLE" --region "$REGION" >/dev/null
  aws dynamodb wait table-not-exists --table-name "$TABLE" --region "$REGION"
  echo "    deleted (the byCreatedAt GSI goes with it)"
fi

cat <<EOF

==> Done. The account is back to where it started, except for:

  - Bedrock model agreements, which cost nothing to hold. Remove them at
    https://console.aws.amazon.com/marketplace/home#/subscriptions
  - CloudWatch log groups, if you ever deployed to Lambda (this POC did not).

Re-create everything with: ./infra/bootstrap.sh $REGION
EOF
