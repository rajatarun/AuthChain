#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-siwe-infra}"
STAGE_NAME="${STAGE_NAME:-prod}"

if ! command -v sam >/dev/null 2>&1; then
  echo "SAM CLI not found. Install: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html"
  exit 1
fi

if [ -z "${JWT_SECRET:-}" ]; then
  echo "Set JWT_SECRET env var first (strong random string). Example:"
  echo "  export JWT_SECRET="$(python3 - <<'PY'
import secrets; print(secrets.token_urlsafe(48))
PY)""
  exit 1
fi

npm install
sam build

sam deploy   --stack-name "$STACK_NAME"   --region "$REGION"   --capabilities CAPABILITY_IAM   --parameter-overrides StageName="$STAGE_NAME" JwtSecret="$JWT_SECRET"   --resolve-s3   --no-fail-on-empty-changeset

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME"   --query 'Stacks[0].Outputs' --output table
