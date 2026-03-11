# AuthChain — CLAUDE.md

## Project Overview

AuthChain is a serverless Web3 authentication gateway with integrated RAG (Retrieval-Augmented Generation) capabilities. It implements [EIP-4361 Sign-In With Ethereum (SIWE)](https://eips.ethereum.org/EIPS/eip-4361) to authenticate users via their Ethereum wallets, issues JWT session tokens, and provides AI-powered document Q&A backed by AWS Bedrock and PostgreSQL with pgvector.

The project is deployed entirely on AWS using the Serverless Application Model (SAM). There are two Lambda functions: the main API handler and a JWT authorizer.

---

## Key Commands

### Install Dependencies

```bash
npm install          # Root dependencies (jsonwebtoken, siwe, aws-sdk)
cd src && npm install  # Lambda runtime dependencies (bedrock, s3, pg, pdf-parse, mammoth)
```

### Build

```bash
sam build
```

### Deploy (Local)

```bash
export JWT_SECRET="<strong-random-secret-38+-chars>"
./deploy.sh
```

The script wraps `sam build && sam deploy`. Optional env vars:

| Variable      | Default        | Description                  |
|---------------|----------------|------------------------------|
| `STACK_NAME`  | `siwe-infra`   | CloudFormation stack name    |
| `STAGE_NAME`  | `prod`         | API Gateway stage            |
| `AWS_REGION`  | `us-east-1`    | Target AWS region            |

### Deploy (CI/CD)

Pushing to `main` triggers `.github/workflows/deploy.yaml`, which authenticates via OIDC and runs `sam build && sam validate && sam deploy`.

### Validate SAM Template

```bash
sam validate
```

### Invoke Locally

```bash
sam local invoke AuthHandler --event events/sample.json
```

### Test Endpoints (manual)

```bash
# 1. Get nonce
curl -X POST https://<ApiBaseUrl>/siwe/nonce

# 2. Verify signed SIWE message
curl -X POST https://<ApiBaseUrl>/siwe/verify \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"...","preparedMessage":"...","signature":"..."}'

# 3. Access protected endpoint
curl https://<ApiBaseUrl>/siwe/me \
  -H "Authorization: Bearer <jwt>"

# 4. RAG ingest
curl -X POST https://<ApiBaseUrl>/ingest \
  -H "Authorization: Bearer <admin-jwt>"

# 5. RAG chat
curl -X POST https://<ApiBaseUrl>/chat \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"question":"What does the document say about X?"}'
```

---

## Architecture Summary

```
User (dApp / Browser)
       │
       ▼
AWS API Gateway (HTTP API)
  ├── /siwe/nonce   (open)   ──► Lambda handler ──► DynamoDB (nonce store)
  ├── /siwe/verify  (open)   ──► Lambda handler ──► DynamoDB + JWT sign
  ├── /siwe/me      (auth)   ──┐
  ├── /siwe/session (auth)   ──┤
  ├── /ingest       (auth)   ──┤  Lambda Authorizer ──► JWT verify
  └── /chat         (auth)   ──┘
                                       │
                             Lambda handler
                              ├── S3 (document source)
                              ├── Bedrock (embeddings + LLM + guardrails)
                              └── PostgreSQL/pgvector (vector store)
```

- **Two Lambda functions**: `AuthHandler` (main) and `SIWEAuthorizer` (JWT gate)
- **DynamoDB** stores one-time nonces with TTL (5 min default)
- **PostgreSQL + pgvector** stores document embeddings for semantic search
- **Bedrock** provides embeddings (Titan) and text generation (Claude)
- **S3** is the document source for RAG ingestion
- **ARM64 / Graviton** runtime for cost savings
- **X-Ray** tracing enabled on all Lambda functions

---

## Important Files and Their Roles

| File | Role |
|------|------|
| `src/index.mjs` | Main Lambda handler — routes requests to SIWE auth or RAG endpoints |
| `src/authorizer.mjs` | Lambda authorizer — validates JWT Bearer tokens, returns IAM policy |
| `template.yaml` | AWS SAM template — defines all AWS resources (Lambda, API GW, DynamoDB, IAM) |
| `deploy.sh` | Local deployment wrapper around `sam build && sam deploy` |
| `.github/workflows/deploy.yaml` | CI/CD pipeline — OIDC auth, SAM build + deploy on push to main |
| `src/package.json` | Lambda runtime dependencies (Bedrock, S3, pg, pdf-parse, mammoth) |
| `package.json` | Root package (siwe, jsonwebtoken, aws-sdk for local dev) |

---

## Environment Variables and Secrets

All variables are set as Lambda environment variables via SAM parameters or inline in `template.yaml`.

### Required

| Variable | Source | Description |
|----------|--------|-------------|
| `JWT_SECRET` | SAM parameter / GitHub Secret | HMAC-256 secret for HS256 JWT signing — must be 38+ chars |
| `TABLE_NAME` | SAM output injected at deploy | DynamoDB nonce table name |
| `DATABASE_URL` | Must be set manually | PostgreSQL connection string: `postgres://user:pass@host:5432/db` |
| `BEDROCK_MODEL_ID` | Must be set manually | Bedrock model for generation, e.g. `anthropic.claude-3-sonnet-20240229-v1:0` |

### Optional (with defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `BEDROCK_EMBED_MODEL_ID` | `amazon.titan-embed-text-v1` | Embedding model |
| `EMBED_DIM` | `1536` | Embedding vector dimension |
| `EMBED_NORMALIZE` | `true` | Normalize embedding vectors |
| `DEFAULT_TOP_K` | `6` | Top-K chunks returned from vector search |
| `MAX_CONTEXT_CHARS` | `12000` | Max chars fed to LLM context window |
| `CHUNK_SIZE` | `1200` | Document chunk size in characters |
| `CHUNK_OVERLAP` | `200` | Sliding window overlap between chunks |
| `MAX_INGEST_FILES` | `50` | Max S3 files processed per `/ingest` call |
| `GUARDRAIL_ID` | `5o1zncxdyabz` | Bedrock guardrail ID for content filtering |
| `GUARDRAIL_VERSION` | `1` | Bedrock guardrail version |
| `JWT_ISSUER` | `siwe-api` | JWT `iss` claim |
| `JWT_AUDIENCE` | `siwe-client` | JWT `aud` claim |
| `JWT_TTL_SECONDS` | `3600` | JWT expiry (1 hour) |

### Secrets Management Pattern

- `JWT_SECRET` is passed as a SAM parameter (`--parameter-overrides JwtSecret=...`) and stored as a CloudFormation parameter.
- In CI/CD, it comes from a GitHub repository secret (`JWT_SECRET`).
- All other sensitive values (e.g. `DATABASE_URL`) should be stored in AWS Secrets Manager or SSM Parameter Store and referenced in `template.yaml` — **they are not currently wired up** and must be added manually.

---

## Gotchas and Known Issues

### 1. JWT_SECRET Strength
The `deploy.sh` script enforces that `JWT_SECRET` is set but does not validate entropy. Use `openssl rand -base64 48` to generate a strong secret.

### 2. DATABASE_URL Not in SAM Template
The `DATABASE_URL` environment variable is consumed in `src/index.mjs` but is **not declared** in `template.yaml` as a parameter. It must be added to the Lambda environment block in `template.yaml` before RAG features will work.

### 3. pgvector Extension Required
The PostgreSQL database must have the `pgvector` extension installed and the `rag_documents` / `rag_chunks` tables created manually. There is no migration script in the repo.

### 4. CORS Allows All Origins
`AllowOrigins: "'*'"` in `template.yaml`. Restrict this to your dApp domain in production.

### 5. Authorizer Returns IAM Policy
The Lambda authorizer returns a full IAM policy document (`Allow`/`Deny`), not a simple boolean. If the authorizer format is wrong, API Gateway returns a 500. See `src/authorizer.mjs`.

### 6. Feature-Based Authorization Tiers
- `siwe` feature tokens: standard JWT validation only
- `admin` feature tokens: additionally require nonce validation (stricter)
- The `feature` claim in the JWT payload controls which path is taken in the authorizer.

### 7. Nonce One-Time Use
Nonces are deleted from DynamoDB immediately after successful SIWE verification. Replaying a nonce returns a 401.

### 8. ARM64 Runtime
`Architectures: [arm64]` is set in `template.yaml`. Any Lambda layers or native binaries must also be ARM64-compatible.

### 9. No Test Suite
There are no automated tests. Validation relies on `sam validate` in CI and manual curl testing.

### 10. GitHub Actions OIDC Role
The CI/CD pipeline uses account `239571291755` and role `teamweave-github-actions-sam-deployer`. If deploying from a fork or different account, this IAM role ARN must be updated in `deploy.yaml`.
