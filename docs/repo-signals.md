# AuthChain — Repo Signals

**Repo:** AuthChain
**Description:** Serverless Web3 authentication gateway with RAG capabilities using EIP-4361 SIWE, AWS Lambda, and Bedrock.

---

## Design Patterns

### 1. Lambda Authorizer (Token-Based Auth Gate)

**Category:** Security / API Gateway
**Files:** `src/authorizer.mjs`, `template.yaml`

A dedicated AWS Lambda function acts as a JWT authorizer for API Gateway (HTTP API v2). It validates HS256 Bearer tokens, extracts claims, and returns a full IAM policy document (Allow/Deny) rather than a simple boolean. Wildcard ARN scoping ensures cached policies remain valid across all routes on the same API stage.

- `AuthorizerPayloadFormatVersion: "2.0"`
- `EnableSimpleResponses: false` (returns IAM policy, not simple response)
- Wildcard resource ARN: `arn:.../{apiId}/{stage}/*`

---

### 2. Tiered Feature Authorization

**Category:** Security / Authorization
**Files:** `src/authorizer.mjs`

JWT payload carries a `feature` claim that drives two distinct authorization tiers. Standard tokens (`feature != "admin"`) pass with JWT signature verification only. Admin tokens additionally require a live nonce lookup in DynamoDB to confirm the session is still active, providing a stricter one-time-use gate.

- `feature: "siwe"` → JWT signature check only
- `feature: "admin"` → JWT check + DynamoDB nonce validation

---

### 3. One-Time Nonce (Replay Protection)

**Category:** Security / Authentication
**Files:** `src/authorizer.mjs`, `template.yaml`

Nonces are stored in DynamoDB with a TTL of 5 minutes and deleted immediately after successful SIWE verification, preventing replay attacks. DynamoDB TTL handles automatic expiry of unconsumed nonces.

- DynamoDB table with TTL on `expiresAt` attribute
- `PAY_PER_REQUEST` billing (no capacity planning)
- Nonce key formats tried: `"nonce#{value}"` and bare `"{value}"`

---

### 4. EIP-4361 Sign-In With Ethereum (SIWE)

**Category:** Authentication / Web3
**Files:** `src/index.mjs`, `package.json`

Implements the SIWE standard for wallet-based authentication. Users sign a structured message with their Ethereum private key; the server verifies the signature and issues a JWT session token. Eliminates passwords and centralised credential storage.

---

### 5. Retrieval-Augmented Generation (RAG)

**Category:** AI / Document Q&A
**Files:** `src/index.mjs`

Documents are ingested from S3, chunked with a sliding window, embedded via Amazon Bedrock Titan, and stored in PostgreSQL with pgvector. At query time the question is embedded, top-K chunks are retrieved by cosine similarity, and a Bedrock-hosted Claude model generates a grounded answer. Guardrails are applied to both input and output.

- Chunking: configurable `CHUNK_SIZE` / `CHUNK_OVERLAP` with sliding window
- Embedding: Amazon Titan Embed (v1 fixed 1536-dim; v2 supports 256/512/1024)
- Vector store: PostgreSQL + pgvector, cosine distance operator `<=>`
- Generation: Anthropic Claude via Bedrock `InvokeModel`
- Guardrails: `ApplyGuardrailCommand` on `INPUT` and `OUTPUT`

---

### 6. Upsert Pattern (Idempotent Ingestion)

**Category:** Data / Persistence
**Files:** `src/index.mjs`

Both document metadata (`rag_documents`) and chunk embeddings (`rag_chunks`) are written with `INSERT … ON CONFLICT … DO UPDATE`, making re-ingestion of the same S3 object fully idempotent. Document identity is the SHA-256 of the S3 URI.

- `doc_id = sha256("s3://{bucket}/{key}")`
- `chunk_id = "{doc_id}:{chunkIndex}"`

---

### 7. Transactional Batch Ingest

**Category:** Data / Reliability
**Files:** `src/index.mjs`

All chunk upserts for a single ingest request are wrapped in a single PostgreSQL transaction (`BEGIN` / `COMMIT` / `ROLLBACK`). Per-file errors are captured and returned in the response without aborting the entire batch.

---

### 8. Event-Source Fan-Out (S3 Trigger)

**Category:** Integration / Event-Driven
**Files:** `src/index.mjs`

The Lambda handler detects S3 event records (`event.Records[0].eventSource === "aws:s3"`) and routes them directly into `handleIngest`, allowing automatic ingestion when files are uploaded to S3 without going through API Gateway.

---

### 9. Serverless Infrastructure-as-Code (AWS SAM)

**Category:** Infrastructure / Deployment
**Files:** `template.yaml`, `deploy.sh`, `.github/workflows/deploy.yaml`

All AWS resources (Lambda, API Gateway HTTP API, DynamoDB, IAM permissions) are declared in a single SAM template. SAM globals reduce repetition across Lambda functions. Deployment is automated via GitHub Actions using OIDC (no long-lived AWS credentials stored in CI).

- Runtime: `nodejs20.x` on `arm64`/Graviton (cost optimised)
- X-Ray tracing enabled via `Tracing: Active` global
- OIDC role: `arn:aws:iam::239571291755:role/teamweave-github-actions-sam-deployer`
- `sam deploy --resolve-s3` manages the SAM artifact bucket automatically

---

### 10. CORS Pass-Through

**Category:** API / Web
**Files:** `template.yaml`, `src/index.mjs`

`OPTIONS` pre-flight requests are handled at the Lambda level (returning 204) and CORS headers are injected on every response. API Gateway `CorsConfiguration` mirrors the same allowed origins, headers, and methods.

- `AllowOrigins: "*"` (open — restrict to dApp domain in production)
- `MaxAge: 86400`

---

### 11. Connection Pool (Reuse Across Invocations)

**Category:** Performance / Database
**Files:** `src/index.mjs`

A `pg.Pool` instance is created at module initialisation time (outside the handler) so it is reused across warm Lambda invocations, avoiding per-request TCP and TLS handshake overhead to PostgreSQL.

---

### 12. Bedrock Client with Custom Timeouts

**Category:** Resilience / External Calls
**Files:** `src/index.mjs`

The `BedrockRuntimeClient` is configured with `NodeHttpHandler` specifying explicit connection and socket timeouts, preventing Lambda from hanging indefinitely on slow or unresponsive Bedrock endpoints.

- `connectionTimeout: 10000 ms`
- `socketTimeout: 90000 ms`

---

### 13. Guardrail Content Filtering

**Category:** AI / Safety
**Files:** `src/index.mjs`

Bedrock guardrails are applied to both user questions (`INPUT`) and model answers (`OUTPUT`) via `ApplyGuardrailCommand`. Blocked inputs return a 400; blocked outputs suppress citations and return the guardrail-provided message.
