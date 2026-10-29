/**
 * The port the auth service uses to track token validity.
 *
 * Narrow on purpose (ISP): the auth service needs exactly these five
 * operations, so swapping Redis for anything else — or injecting an in-memory
 * double in a test — means implementing five methods rather than mocking a
 * client library.
 */
export interface TokenStore {
  /** Records a refresh token as valid until it expires. */
  allowRefresh(jti: string, walletId: string, ttlSeconds: number): Promise<void>;

  /** True when this refresh token is still on the allowlist. */
  isRefreshAllowed(jti: string, walletId: string): Promise<boolean>;

  /** Removes a single refresh token, used by rotation and by logout. */
  revokeRefresh(jti: string, walletId: string): Promise<void>;

  /**
   * Denylists an access token until its natural expiry.
   *
   * Access tokens are short-lived and self-contained, so the only way logout can
   * take effect before expiry is an explicit denylist entry.
   */
  revokeAccess(jti: string, ttlSeconds: number): Promise<void>;

  isAccessRevoked(jti: string): Promise<boolean>;
}

export const TOKEN_STORE = Symbol('TOKEN_STORE');
