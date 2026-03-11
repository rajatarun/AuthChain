# AuthChain — Architecture Documentation

## System Overview

AuthChain is a serverless Web3 authentication and AI document Q&A platform deployed on AWS. It provides two distinct functional domains:

1. **SIWE Authentication** — Implements [EIP-4361 Sign-In With Ethereum](https://eips.ethereum.org/EIPS/eip-4361), allowing users to authenticate with their Ethereum wallets (MetaMask, WalletConnect, etc.) and receive short-lived JWT session tokens.

2. **RAG Pipeline** — A Retrieval-Augmented Generation system that ingests documents from S3, embeds them with Amazon Bedrock Titan, stores vectors in PostgreSQL (pgvector), and answers natural-language questions using a Bedrock LLM (Claude) with guardrails.

Both domains share a single AWS Lambda execution environment and API Gateway endpoint, differentiated by route prefix (`/siwe/*` vs `/ingest`, `/chat`).

---

## Component Descriptions

### 1. API Gateway (HTTP API)

- AWS HTTP API (v2) — lower latency and cost than REST API
- Configures CORS with wildcard origin (`*`)
- Routes all traffic to two Lambda functions:
  - **`AuthHandler`** — main business logic
  - **`SIWEAuthorizer`** — JWT gate (Lambda authorizer)
- Anonymous routes: `POST /siwe/nonce`, `POST /siwe/verify`
- Protected routes: `GET /siwe/me`, `GET /siwe/session`, `POST /ingest`, `POST /chat`

### 2. SIWEAuthorizer Lambda (`src/authorizer.mjs`)

- Runs before protected route handlers
- Extracts `Authorization: Bearer <token>` header
- Verifies JWT signature using `HS256` + `JWT_SECRET`
- Checks `iss`, `aud`, expiry claims
- Feature-gated authorization:
  - `feature: "siwe"` — standard JWT validation only
  - `feature: "admin"` — additionally validates nonce claim (stricter replay protection)
- Returns an IAM policy document (`Allow` or `Deny`) to API Gateway
- Logs the full decoded token payload for debugging (X-Ray compatible)

### 3. AuthHandler Lambda (`src/index.mjs`)

Main handler, routes on `event.routeKey`:

#### SIWE Endpoints

| Route | Auth | Description |
|-------|------|-------------|
| `POST /siwe/nonce` | None | Generates a UUID nonce + sessionId, stores in DynamoDB with TTL |
| `POST /siwe/verify` | None | Verifies SIWE message + Ethereum signature, deletes nonce, issues JWT |
| `GET /siwe/me` | JWT | Returns address and JWT metadata from token |
| `GET /siwe/session` | JWT | Returns decoded session payload |

#### RAG Endpoints

| Route | Auth | Description |
|-------|------|-------------|
| `POST /ingest` | JWT (admin) | Lists S3 objects, extracts text, chunks, embeds, upserts to PostgreSQL |
| `POST /chat` | JWT | Embeds question, vector-searches PostgreSQL, generates answer via Bedrock |

### 4. DynamoDB — Nonce Store

- Single table, configurable name via `TABLE_NAME` env var
- Schema: `sessionId` (PK), `nonce`, `expiresAt` (TTL attribute)
- TTL auto-expires nonces after ~5 minutes (managed by DynamoDB)
- Nonces are deleted immediately after successful SIWE verification (one-time use)

### 5. Amazon Bedrock

Three Bedrock API operations are used:

| Operation | Model | Purpose |
|-----------|-------|---------|
| `InvokeModel` (embeddings) | `amazon.titan-embed-text-v1` (default) | Embed document chunks and user queries |
| `InvokeModel` (generation) | Configurable via `BEDROCK_MODEL_ID` | Generate answers from retrieved context |
| `ApplyGuardrail` | Guardrail ID `5o1zncxdyabz` | Content safety filtering on inputs and outputs |

### 6. Amazon S3 — Document Source

- Stores source documents (PDF, DOCX, TXT, MD, JSON, CSV)
- The `/ingest` endpoint lists and reads up to `MAX_INGEST_FILES` (default 50) objects
- Documents are never written back to S3 — it is read-only from the Lambda perspective

### 7. PostgreSQL + pgvector — Vector Store

- Stores document metadata and embedding vectors
- Two tables:
  - `rag_documents`: `doc_id`, `title`, `doc_type`, `source`, `tags`
  - `rag_chunks`: `doc_id`, `chunk_id`, `content`, `embedding` (vector)
- Similarity search uses cosine distance (`<=>` operator from pgvector)
- Connected via `DATABASE_URL` environment variable
- Must have `pgvector` extension installed — **no migration script is included**

### 8. AWS CloudFormation / SAM

- Infrastructure defined in `template.yaml`
- SAM transforms handle Lambda packaging, API Gateway wiring, and IAM role creation
- Configurable parameters: `StageName`, `JwtSecret`
- CloudFormation outputs: `ApiBaseUrl`, `NoncesTableName`, `FunctionName`, `AuthorizerFunctionArn`

### 9. GitHub Actions CI/CD

- Defined in `.github/workflows/deploy.yaml`
- Triggered on push to `main` or manual dispatch
- Uses OIDC (GitHub → AWS IAM) — no long-lived credentials stored
- Pipeline: checkout → Node 20 setup → SAM setup → AWS auth → npm install → sam build → sam validate → sam deploy

---

## Data Flow Through the System

### SIWE Authentication Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                        SIWE Auth Flow                              │
│                                                                    │
│  Browser/dApp                                                      │
│      │                                                             │
│      │  POST /siwe/nonce                                           │
│      ├──────────────────────► API Gateway ──► Lambda              │
│      │                                            │               │
│      │  { sessionId, nonce, ttl }                 │               │
│      │◄──────────────────────────────────────     │               │
│      │                              DynamoDB ◄────┘               │
│      │                         (store nonce + TTL)                │
│      │                                                             │
│      │  [User signs EIP-4361 message with wallet]                  │
│      │                                                             │
│      │  POST /siwe/verify                                          │
│      │  { sessionId, preparedMessage, signature }                  │
│      ├──────────────────────► API Gateway ──► Lambda              │
│      │                                            │               │
│      │                              DynamoDB ◄────┤ fetch nonce   │
│      │                                            │ verify sig    │
│      │                              DynamoDB ◄────┤ delete nonce  │
│      │                                            │               │
│      │  { token: "eyJ..." }                       │ sign JWT      │
│      │◄─────────────────────────────────────────  │               │
│      │                                                             │
│      │  GET /siwe/me                                               │
│      │  Authorization: Bearer eyJ...                               │
│      ├──────────────────────► API Gateway                         │
│      │                             │                               │
│      │                    SIWEAuthorizer Lambda                    │
│      │                    (verify JWT, emit IAM policy)            │
│      │                             │                               │
│      │                        AuthHandler Lambda                   │
│      │  { address, iat, exp }      │                               │
│      │◄────────────────────────────┘                               │
└────────────────────────────────────────────────────────────────────┘
```

### RAG Ingest Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                        RAG Ingest Flow                             │
│                                                                    │
│  Admin Client                                                      │
│      │  POST /ingest (Bearer admin-JWT)                            │
│      ├──────────► API Gateway ──► Authorizer ──► AuthHandler       │
│      │                                               │             │
│      │                                     S3 ListObjects          │
│      │                                               │             │
│      │                                  for each file:             │
│      │                                    S3 GetObject             │
│      │                                    parse text               │
│      │                                    chunk (1200 chars)       │
│      │                                               │             │
│      │                                  Bedrock ApplyGuardrail     │
│      │                                  Bedrock InvokeModel        │
│      │                                  (Titan Embeddings)         │
│      │                                               │             │
│      │                                  PostgreSQL UPSERT          │
│      │                                  (rag_documents,            │
│      │                                   rag_chunks + vectors)     │
│      │  { ingested: N, chunks: M }                                 │
│      │◄──────────────────────────────────────────────┘             │
└────────────────────────────────────────────────────────────────────┘
```

### RAG Chat Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                         RAG Chat Flow                              │
│                                                                    │
│  User                                                              │
│      │  POST /chat { "question": "..." } (Bearer JWT)              │
│      ├──────────► API Gateway ──► Authorizer ──► AuthHandler       │
│      │                                               │             │
│      │                                  Bedrock ApplyGuardrail     │
│      │                                  (input safety check)       │
│      │                                               │             │
│      │                                  Bedrock InvokeModel        │
│      │                                  (Titan: embed question)    │
│      │                                               │             │
│      │                                  PostgreSQL vector search   │
│      │                                  (cosine similarity top-K)  │
│      │                                               │             │
│      │                                  Build context              │
│      │                                  (up to 12k chars)          │
│      │                                               │             │
│      │                                  Bedrock InvokeModel        │
│      │                                  (LLM: generate answer)     │
│      │                                               │             │
│      │                                  Bedrock ApplyGuardrail     │
│      │                                  (output safety check)      │
│      │                                               │             │
│      │  { answer, citations: [{title, score}] }                    │
│      │◄──────────────────────────────────────────────┘             │
└────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Single Lambda, Dual Responsibility
Both SIWE authentication and RAG endpoints are handled by one Lambda function (`src/index.mjs`). This reduces cold-start surface area and deployment complexity, at the cost of a larger deployment package. The routing is done via `event.routeKey` matching.

### 2. Stateless JWT with Stateful Nonce
JWTs are stateless (no server-side session storage). However, nonces are stored in DynamoDB to prevent replay attacks during the SIWE verification step. This hybrid approach minimizes infrastructure while maintaining security.

### 3. Separate Lambda Authorizer
The JWT authorizer is a separate Lambda function (`src/authorizer.mjs`) rather than inline middleware. This allows API Gateway to cache authorization decisions, reducing Bedrock/DynamoDB calls on every request.

### 4. ARM64 (Graviton) Runtime
Both Lambda functions use `Architectures: [arm64]`. Graviton processors offer ~20% cost reduction and comparable performance for Node.js workloads. Any native modules (e.g., `pg`) must be ARM-compatible — the standard npm packages are.

### 5. HTTP API (v2) over REST API (v1)
AWS HTTP API is used instead of REST API because it offers lower latency (~10ms vs ~60ms overhead), lower cost, and simpler configuration for JWT/Lambda authorizers. It does not support some REST API features like request validators or usage plans.

### 6. pgvector for Vector Storage
PostgreSQL with the pgvector extension is used instead of a dedicated vector database (e.g., Pinecone, Weaviate). This avoids additional infrastructure costs and complexity. The trade-off is that PostgreSQL vector search is less optimized for very large embedding sets (millions of vectors).

### 7. Bedrock Guardrails on I/O
Bedrock guardrails are applied to both ingested content and chat I/O. This provides content safety at the model boundary without requiring application-level content filtering logic.

### 8. DynamoDB TTL for Nonce Expiry
Nonce expiry is handled by DynamoDB's native TTL feature rather than a scheduled cleanup Lambda. This is cost-free and requires no operational overhead. The trade-off is that expired items may linger in DynamoDB for up to 48 hours after the TTL epoch (DynamoDB TTL guarantee), but the application checks `expiresAt` in the Lambda logic as well.

### 9. OIDC for CI/CD Authentication
GitHub Actions uses AWS OIDC federation instead of long-lived IAM access keys. This eliminates credential rotation risk and follows AWS security best practices for CI/CD pipelines.
