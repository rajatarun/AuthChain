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

export const handler = async (event) => {
  try {
    if (!JWT_SECRET) {
      console.error("JWT_SECRET is not configured");
      return { isAuthorized: false };
    }

    const authHeader = event?.headers?.authorization ?? event?.headers?.Authorization;
    const token = extractBearerToken(authHeader);
    if (!token) return { isAuthorized: false };

    const payload = jwt.verify(token, JWT_SECRET);
    const feature = payload?.feature ? String(payload.feature).toLowerCase() : "";
    const nonce = payload?.nonce;

    if (feature === "siwe") {
      return {
        isAuthorized: true,
        context: {
          sub: payload?.sub ? String(payload.sub) : "",
          address: payload?.address ? String(payload.address) : "",
          nonce: nonce ? String(nonce) : ""
        }
      };
    }

    if (!nonce) return { isAuthorized: false };

    const validNonce = await nonceExists(String(nonce));
    if (!validNonce) return { isAuthorized: false };

    return {
      isAuthorized: true,
      context: {
        sub: payload?.sub ? String(payload.sub) : "",
        address: payload?.address ? String(payload.address) : "",
        nonce: String(nonce)
      }
    };
  } catch (error) {
    console.error("Authorizer error", error);
    return { isAuthorized: false };
  }
};
