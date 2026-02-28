# 🔐 AuthChain

**AuthChain** is a serverless Web3 identity gateway implementing  
**EIP-4361 (Sign-In With Ethereum)** on AWS using:

- AWS Lambda (Node.js 20)
- API Gateway (HTTP API)
- DynamoDB (TTL-based nonce store)
- Stateless JWT session minting

AuthChain enables cryptographically secure authentication using Ethereum wallets while maintaining cloud-native scalability and operational simplicity.

---

## 🧠 What Problem AuthChain Solves

Traditional Web2 authentication relies on passwords or OAuth providers.

AuthChain replaces that with:

- Wallet-based identity (SIWE)
- Nonce-based replay protection
- Verified EIP-4361 message parsing
- Signed session token issuance (JWT)
- Fully serverless deployment

This allows applications to authenticate users without storing passwords, private keys, or long-lived secrets.

---

## 🏗 Architecture Overview

**Flow:**

Client (Web / dApp)  
→ POST `/siwe/nonce`  
→ Wallet signs prepared SIWE message  
→ POST `/siwe/verify`  
→ JWT issued  
→ GET `/siwe/me` or `/siwe/session`

**Infrastructure:**

Client
↓
API Gateway (HTTP API)
↓
Lambda (AuthChain)
↓
DynamoDB (nonce store with TTL)

Key security features:

- Nonce expiration via DynamoDB TTL
- ABNF-only SIWE message validation
- Replay protection
- Signature verification using `siwe` library
- Stateless JWT issuance (HS256)
- No cookies required (Bearer token model)

---

## 📦 Endpoints

### POST `/siwe/nonce`

Generates a nonce and sessionId.

**Response:**
```json
{
  "sessionId": "uuid",
  "nonce": "randomNonce",
  "ttlSeconds": 300
}


⸻

POST /siwe/verify

Validates SIWE message and signature.

Body:

{
  "sessionId": "...",
  "message": "ABNF prepared SIWE message string",
  "signature": "0x..."
}

⚠️ The message must be the exact string returned by:

siweMessage.prepareMessage()

JSON-shaped messages are rejected.

Response:

{
  "ok": true,
  "address": "0x...",
  "token": "jwt..."
}


⸻

GET /siwe/me

Checks authentication status.

Requires:

Authorization: Bearer <token>


⸻

GET /siwe/session

Returns decoded session metadata.

⸻

🔐 Security Model

AuthChain enforces:
	•	Nonce stored server-side
	•	One-time verification
	•	Expiration enforced via TTL
	•	Signature must match original prepared message
	•	JWT expiration configurable
	•	No JSON reconstruction of SIWE messages (ABNF-only)

Replay attacks are prevented because:
	1.	Nonce is unique per session
	2.	Nonce is deleted after verification
	3.	Nonce expires automatically

⸻

🚀 Deployment (AWS SAM)

Requirements
	•	AWS CLI configured
	•	SAM CLI installed
	•	Node.js 20+
	•	IAM permissions for:
	•	CloudFormation
	•	Lambda
	•	DynamoDB
	•	API Gateway

⸻

Deploy

unzip siwe_infra_sam.zip -d authchain
cd authchain

export JWT_SECRET="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"

chmod +x deploy.sh
./deploy.sh

After deployment, retrieve the API base URL from CloudFormation outputs.

⸻

🧪 Client Integration Example

import { SiweMessage } from "siwe";

const { sessionId, nonce } = await fetch("/siwe/nonce", { method: "POST" })
  .then(r => r.json());

const siwe = new SiweMessage({
  domain: window.location.host,
  address,
  statement: "Sign in to AuthChain.",
  uri: window.location.origin,
  version: "1",
  chainId,
  nonce
});

const preparedMessage = siwe.prepareMessage();
const signature = await signMessageAsync({ message: preparedMessage });

const result = await fetch("/siwe/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    sessionId,
    message: preparedMessage,
    signature
  })
}).then(r => r.json());


⸻

📊 Why AuthChain Is Production-Ready
	•	Fully serverless
	•	Horizontally scalable
	•	Zero server state (except nonce TTL)
	•	No database migrations
	•	Low operational cost
	•	Protocol-aligned (EIP-4361)
	•	Clean separation of identity and business logic

⸻

🔮 Future Roadmap

AuthChain can evolve to support:
	•	Multi-chain authentication
	•	Solana Sign-In
	•	DID integration
	•	OAuth bridge
	•	Web2 ↔ Web3 hybrid identity
	•	Role-based access control
	•	Enterprise audit logging
	•	Multi-tenant SaaS architecture

⸻

🏷 Positioning

AuthChain is a cryptographic identity gateway designed for:
	•	Web3 platforms
	•	DeFi dashboards
	•	NFT marketplaces
	•	Developer portals
	•	Recruiter authentication portals
	•	On-chain credential systems

⸻

📄 License

Apache

