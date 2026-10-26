export class OswSourceError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterS?: number;
  readonly detail?: unknown;
  constructor(
    code: string,
    message = code,
    options: { status?: number; retryAfterS?: number; detail?: unknown } = {},
  ) {
    super(message);
    this.name = 'OswSourceError';
    this.code = code;
    this.status = options.status;
    this.retryAfterS = options.retryAfterS;
    this.detail = options.detail;
  }
}
