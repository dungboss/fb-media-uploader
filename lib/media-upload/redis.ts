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

export function createRedisConnection() {
  const { redisUrl } = getMediaUploadConfig();

  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
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
