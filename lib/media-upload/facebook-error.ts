// Shared Facebook/Meta error type. Lives in its own module so both meta.ts and
// token-store.ts can import it without creating a circular dependency
// (meta.ts → token-store.ts → meta.ts).

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

  constructor(message: string, status = 500, details?: MetaApiErrorPayload) {
    super(message);
    this.name = "FacebookApiError";
    this.status = status;
    this.details = details;
  }
}
