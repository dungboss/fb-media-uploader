// TODO(phase 03): full worker rewrite — adaptive BUC-header-driven pacing,
// per-ad-account throttle (Redis SET NX PX), retry/backoff classification.
// This phase (01) only needs the file to exist under the new name and
// typecheck against the rewritten job/queue modules; the body below is a
// stub, not a real implementation.

import { getMediaUploadConfig } from "../lib/media-upload/env";
import { getBullConnectionOptions } from "../lib/media-upload/redis";

async function main() {
  const config = getMediaUploadConfig();

  console.info(
    `[media-upload-worker] queue=${config.queueName} concurrency=${config.workerConcurrency}`
  );
  // Referenced so the connection helper stays exercised/typechecked even
  // though no Worker is constructed yet (phase 03 wires it up for real).
  void getBullConnectionOptions();

  throw new Error(
    "media-upload-worker: not implemented yet — see phase 03 (worker rewrite)."
  );
}

void main().catch((error) => {
  console.error("[media-upload-worker] fatal", error);
  process.exit(1);
});
