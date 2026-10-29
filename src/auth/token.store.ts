export interface TokenStore {
  /** Records a refresh token as valid until it expires. */
  allowRefresh(jti: string, walletId: string, ttlSeconds: number): Promise<void>;

  /** True when this refresh token is still on the allowlist. */
  isRefreshAllowed(jti: string, walletId: string): Promise<boolean>;

  /** Removes a single refresh token, used by rotation and by logout. */
  revokeRefresh(jti: string, walletId: string): Promise<void>;

  /** Denylists an access token until its natural expiry. */
  revokeAccess(jti: string, ttlSeconds: number): Promise<void>;

  isAccessRevoked(jti: string): Promise<boolean>;
}

export const TOKEN_STORE = Symbol('TOKEN_STORE');
