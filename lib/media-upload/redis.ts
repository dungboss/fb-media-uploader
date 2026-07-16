import IORedis from "ioredis";

import { getMediaUploadConfig } from "./env";

declare global {
  var __mediaUploadRedis__: IORedis | undefined;
}

export function getRedis() {
  if (!globalThis.__mediaUploadRedis__) {
    globalThis.__mediaUploadRedis__ = createRedisConnection();
  }

  return globalThis.__mediaUploadRedis__;
}

// The app's general-purpose client: token store, batch records, job records.
// NOT the BullMQ connection — that is getBullConnectionOptions() below, and it
// is the only place that needs `maxRetriesPerRequest: null`.
//
// The distinction matters more than it looks. `maxRetriesPerRequest: null`
// means commands QUEUE FOREVER instead of rejecting when Redis is unreachable,
// so this client having it made a stopped Redis look like a hung app: the
// dashboard sat on "Đang tải token..." with no error, no toast, no timeout,
// and no clue. It cost real debugging time twice. BullMQ requires that setting
// for its own connection; nothing here does, so this client fails fast and
// says why.
export function createRedisConnection() {
  const { redisUrl } = getMediaUploadConfig();

  return new IORedis(redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    enableReadyCheck: true,
    // Bounded reconnect backoff. Without a cap ioredis keeps trying forever at
    // ever-longer intervals, which reads as "slow" rather than "broken".
    retryStrategy: (attempt) => (attempt > 5 ? null : Math.min(attempt * 200, 2_000)),
  });
}

const REDIS_CONNECT_TIMEOUT_MS = 5_000;

// Turns ioredis's low-level connection errors into something an operator can
// act on. Every route that touches Redis surfaces its error message to the UI,
// so this text is what a user actually sees when Redis is not running.
//
// The patterns are MEASURED, not guessed. With Redis down, the message that
// actually reaches a route is ioredis's retry-budget message — "Reached the
// max retries per request limit (which is 2)" — not the ECONNREFUSED you would
// expect, because the refusal happens on the connection, while the command
// fails on its own retry budget. A first draft of this function matched only
// the obvious connection errors and therefore never fired. Add a pattern only
// after seeing the real string.
const REDIS_DOWN_PATTERNS =
  /Reached the max retries per request|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|Connection is closed|connect timeout|Stream isn't writeable|Command timed out/i;

export function describeRedisError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!REDIS_DOWN_PATTERNS.test(message)) {
    return message;
  }

  const { redisUrl } = getMediaUploadConfig();
  return `Không kết nối được Redis ở ${redisUrl} — Redis chưa chạy? Khởi động Redis (DBngin hoặc \`brew services start redis\`) rồi thử lại (xem README).`;
}

export function getBullConnectionOptions() {
  const { redisUrl } = getMediaUploadConfig();
  const redisUrlObject = new URL(redisUrl);
  const databasePath = redisUrlObject.pathname.replace(/^\//, "");
  const database =
    databasePath && Number.isFinite(Number(databasePath))
      ? Number.parseInt(databasePath, 10)
      : 0;

  return {
    host: redisUrlObject.hostname,
    port: redisUrlObject.port
      ? Number.parseInt(redisUrlObject.port, 10)
      : 6379,
    username: redisUrlObject.username
      ? decodeURIComponent(redisUrlObject.username)
      : undefined,
    password: redisUrlObject.password
      ? decodeURIComponent(redisUrlObject.password)
      : undefined,
    db: Number.isFinite(database) ? database : 0,
    tls: redisUrlObject.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}
