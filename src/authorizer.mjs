import jwt from "jsonwebtoken";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const { TABLE_NAME, JWT_SECRET } = process.env;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function extractBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

async function nonceExists(nonce) {
  if (!TABLE_NAME || !nonce) return false;

  const keysToTry = [`nonce#${nonce}`, nonce];
  for (const pk of keysToTry) {
    const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk } }));
    if (result?.Item) return true;
  }

  return false;
}

function generatePolicy(principalId, effect, resource, context = {}) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource || "*",
        },
      ],
    },
    context,
  };
}

export const handler = async (event) => {
  const methodArn = event?.methodArn || "*";

  try {
    const authHeader = event?.headers?.authorization ?? event?.headers?.Authorization;
    const token = extractBearerToken(authHeader);

    // Only enforce authentication for admin feature.
    // Any request without a token is authorized by default.
    if (!token) return generatePolicy("anonymous", "Allow", methodArn);

    if (!JWT_SECRET) {
      console.error("JWT_SECRET is not configured");
      return generatePolicy("anonymous", "Deny", methodArn);
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const feature = payload?.feature ? String(payload.feature).toLowerCase() : "";
    const nonce = payload?.nonce;
    const principalId = payload?.sub ? String(payload.sub) : "user";

    if (feature !== "admin") {
      return generatePolicy(principalId, "Allow", methodArn, {
        sub: payload?.sub ? String(payload.sub) : "",
        address: payload?.address ? String(payload.address) : "",
        nonce: nonce ? String(nonce) : "",
      });
    }

    if (!nonce) return generatePolicy(principalId, "Deny", methodArn);

    const validNonce = await nonceExists(String(nonce));
    if (!validNonce) return generatePolicy(principalId, "Deny", methodArn);

    return generatePolicy(principalId, "Allow", methodArn, {
      sub: payload?.sub ? String(payload.sub) : "",
      address: payload?.address ? String(payload.address) : "",
      nonce: String(nonce),
    });
  } catch (error) {
    console.error("Authorizer error", error);
    return generatePolicy("anonymous", "Deny", methodArn);
  }
};
