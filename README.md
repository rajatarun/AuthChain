# SIWE SAM Infra (HTTP API + Lambda + DynamoDB)

## Endpoints
- POST /siwe/nonce
- POST /siwe/verify (ABNF-only message)
- GET  /siwe/me
- GET  /siwe/session

## Deploy (CloudShell)
1) Unzip this package
2) Export a strong JWT secret
3) Run deploy.sh

Example:
export JWT_SECRET="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"
./deploy.sh

## Important
/siwe/verify rejects JSON-shaped messages. Send the exact output string of `siweMessage.prepareMessage()`.
