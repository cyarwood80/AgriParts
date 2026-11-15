export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'AMBIGUOUS'
  | 'INSUFFICIENT_STOCK'
  | 'CUSTOMER_ON_STOP'
  | 'INVALID_STATE'
  | 'INTEGRATION_FAILED';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  AMBIGUOUS: 409,
  INSUFFICIENT_STOCK: 409,
  CUSTOMER_ON_STOP: 409,
  INVALID_STATE: 409,
  INTEGRATION_FAILED: 502,
};

/**
 * The one error type services throw. REST maps it to an HTTP status; MCP maps it
 * to a tool result with isError so the model can read the message and recover.
 */
export class AppError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.httpStatus = STATUS[code];
  }
}

export const notFound = (what: string, ref: string) => new AppError('NOT_FOUND', `${what} not found: ${ref}`, { ref });
export const invalidState = (message: string, details?: Record<string, unknown>) =>
  new AppError('INVALID_STATE', message, details);
