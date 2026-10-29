/** The single error shape this API returns. Documented in the README and OpenAPI spec. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    requestId: string;
    /** True when retrying the identical request could succeed. */
    retryable: boolean;
  };
}
