/**
 * The deployment is wrong, not the request: absent seed data, a required row
 * missing, an environment variable that has to be set and is not.
 *
 * It is its own class rather than a bare `Error` so logs and stack traces name
 * the fault, and so a `catch` can tell "we are misconfigured" — which no retry
 * and no client change will fix — apart from a transient failure. It never
 * reaches a client on its own: `AppError.misconfigured()` carries it as a cause
 * and publishes INTERNAL_ERROR, and the mapper's fallthrough would do the same.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
