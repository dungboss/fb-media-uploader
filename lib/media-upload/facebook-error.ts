// Shared Facebook/Meta error type. Lives in its own module so both
// meta-graph.ts and token-store.ts can import it without creating a
// circular dependency (meta-graph.ts → token-store.ts → meta-graph.ts).

import type { MetaUsage } from "./meta-usage";

export interface MetaApiErrorPayload {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

export class FacebookApiError extends Error {
  readonly status: number;
  readonly details?: MetaApiErrorPayload;
  // The calling account's last-known usage snapshot, attached when the
  // failing call targeted one specific `act_X` (see meta-graph.ts's
  // parseFacebookResponse). Lets the worker read
  // estimated_time_to_regain_access straight off a rate-limit error instead
  // of re-deriving it.
  readonly usage?: MetaUsage;

  constructor(
    message: string,
    status = 500,
    details?: MetaApiErrorPayload,
    usage?: MetaUsage
  ) {
    super(message);
    this.name = "FacebookApiError";
    this.status = status;
    this.details = details;
    this.usage = usage;
  }
}
