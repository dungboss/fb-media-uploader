import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";

import { FacebookApiError } from "./facebook-error";
import { getRedis } from "./redis";

// Encrypted-at-rest store for Facebook credentials. Tokens (and their app
// secret) are secrets the worker — a separate process — also needs, so they
// live in Redis, shared by web app and worker, rather than .env or the browser.
// Each secret is sealed with AES-256-GCM; the master key is derived from
// TOKEN_ENCRYPTION_KEY. Only non-secret fields (id, label, appId) ever leave
// the server; raw tokens/app secrets never round-trip back to the client.
//
// app_id + app_secret are captured per token so server calls can attach an
// `appsecret_proof` (required when the Meta app enables "Require app secret").

const TOKENS_KEY = "audience-upload:fb-tokens";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard nonce
// Stable salt so the same passphrase always derives the same key across restarts.
const SCRYPT_SALT = "fb-audience-uploader:token-store:v1";

export interface FbTokenSummary {
  id: string;
  label: string;
  appId: string | null;
  createdAt: string;
  lastValidatedAt: string | null;
}

export interface FbTokenCredentials {
  accessToken: string;
  appId: string | null;
  appSecret: string | null;
}

interface StoredFbToken extends FbTokenSummary {
  // base64(iv).base64(authTag).base64(ciphertext)
  encryptedToken: string;
  encryptedAppSecret: string | null;
}

// Derives a 32-byte key from the configured passphrase. Accepts any string —
// scrypt stretches it to the required length. Changing the passphrase
// invalidates previously stored secrets (they must be re-added).
function getEncryptionKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();

  if (!raw) {
    throw new FacebookApiError(
      "Thiếu TOKEN_ENCRYPTION_KEY trong .env. Tạo một khóa bằng `openssl rand -base64 32`, thêm vào .env rồi khởi động lại server và worker.",
      500
    );
  }

  return scryptSync(raw, SCRYPT_SALT, KEY_LENGTH);
}

function encryptSecret(plainText: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");

  if (!ivB64 || !tagB64 || !dataB64) {
    throw new FacebookApiError(
      "Credential đã lưu bị hỏng định dạng mã hóa. Hãy xóa và thêm lại token.",
      500
    );
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function addFbToken(input: {
  label: string;
  token: string;
  appId?: string;
  appSecret?: string;
}): Promise<FbTokenSummary> {
  const token = input.token.trim();
  const appId = input.appId?.trim() || null;
  const appSecret = input.appSecret?.trim() || null;

  if (!token) {
    throw new FacebookApiError("Access token không được để trống.", 400);
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const stored: StoredFbToken = {
    id,
    label: input.label.trim() || `Token ${createdAt.slice(0, 10)}`,
    appId,
    createdAt,
    lastValidatedAt: createdAt,
    encryptedToken: encryptSecret(token),
    encryptedAppSecret: appSecret ? encryptSecret(appSecret) : null,
  };

  await getRedis().hset(TOKENS_KEY, id, JSON.stringify(stored));

  return toSummary(stored);
}

export async function listFbTokens(): Promise<FbTokenSummary[]> {
  const all = await getRedis().hgetall(TOKENS_KEY);

  return Object.values(all)
    .map(parseStored)
    .filter((token): token is StoredFbToken => token !== null)
    .map(toSummary)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

// Returns the decrypted credentials for server-side Meta calls, or null if
// missing. appSecret is null when the token was added without one.
export async function getFbTokenCredentials(
  tokenId: string
): Promise<FbTokenCredentials | null> {
  const raw = await getRedis().hget(TOKENS_KEY, tokenId.trim());

  if (!raw) {
    return null;
  }

  const stored = parseStored(raw);
  if (!stored) {
    return null;
  }

  return {
    accessToken: decryptSecret(stored.encryptedToken),
    appId: stored.appId,
    appSecret: stored.encryptedAppSecret
      ? decryptSecret(stored.encryptedAppSecret)
      : null,
  };
}

export async function deleteFbToken(tokenId: string): Promise<boolean> {
  const removed = await getRedis().hdel(TOKENS_KEY, tokenId.trim());
  return removed > 0;
}

function toSummary(stored: StoredFbToken): FbTokenSummary {
  return {
    id: stored.id,
    label: stored.label,
    appId: stored.appId,
    createdAt: stored.createdAt,
    lastValidatedAt: stored.lastValidatedAt,
  };
}

function parseStored(raw: string): StoredFbToken | null {
  try {
    const parsed = JSON.parse(raw) as StoredFbToken;
    return parsed?.id && parsed?.encryptedToken ? parsed : null;
  } catch {
    return null;
  }
}
