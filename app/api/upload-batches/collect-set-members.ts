// Exhaustive SSCAN of a status SET. Used to collect ALL members of a batch's
// queued/processing/failed set for cancel and retry-failed (unlike
// listBatchJobIds in lib/media-upload/batches.ts, which pages a bounded
// window for the UI, this drains the whole set — bounded by the set's own
// size, which is bounded by the batch cap).

import { getRedis } from "@/lib/media-upload/redis";

const SCAN_COUNT = 1000;

export async function collectSetMembers(key: string): Promise<string[]> {
  const redis = getRedis();
  const members: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.sscan(key, cursor, "COUNT", SCAN_COUNT);
    members.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");

  return members;
}
