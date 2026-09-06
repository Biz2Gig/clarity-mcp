/** Errors that carry a stable machine code and are safe to surface to callers. */

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Missing/invalid configuration (e.g. no provider credentials). Never faked. */
export class ConfigurationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("configuration_error", message, 503, details);
  }
}

/** Caller supplied bad input. */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("validation_error", message, 400, details);
  }
}

/** A remote URL failed a security policy check (SSRF, scheme, size, MIME). */
export class SecurityError extends AppError {
  constructor(message: string, details?: unknown) {
    super("security_error", message, 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super("not_found", message, 404, details);
  }
}

export class QuotaError extends AppError {
  constructor(message: string, details?: unknown) {
    super("quota_exhausted", message, 429, details);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
