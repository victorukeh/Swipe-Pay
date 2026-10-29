import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v7 as uuidv7 } from 'uuid';

import { AppError } from '../common/errors/app-error';
import type { EnvSchema } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import type { TokenPairResponse } from './dto/auth.dto';
import { PasswordService } from './password.service';
import { TOKEN_STORE, type TokenStore } from './token.store';

export interface TokenClaims {
  sub: string;
  jti: string;
  typ: 'access' | 'refresh';
  exp?: number;
}

export interface ContactInput {
  email?: string | undefined;
  phone?: string | undefined;
}

@Injectable()
export class AuthService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    @Inject(TOKEN_STORE) private readonly tokens: TokenStore,
    config: ConfigService<EnvSchema, true>,
  ) {
    this.accessTtl = config.get('JWT_ACCESS_TTL', { infer: true });
    this.refreshTtl = config.get('JWT_REFRESH_TTL', { infer: true });
    this.accessSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.refreshSecret = config.get('JWT_REFRESH_SECRET', { infer: true });
  }

  /**
   * Contacts are normalised before they are stored or compared.
   *
   * The database has a CHECK that email equals its own lower-case form, so this
   * is the one place that can satisfy it — and it is what makes the plain unique
   * index enough to stop "Ada@Example.COM" registering alongside
   * "ada@example.com".
   */
  static normaliseContact(input: ContactInput): { email: string | null; phone: string | null } {
    const email = input.email?.trim().toLowerCase();
    const phone = input.phone?.trim();
    return { email: email ? email : null, phone: phone ? phone : null };
  }

  static requireOneContact(input: ContactInput): { email: string | null; phone: string | null } {
    const contact = AuthService.normaliseContact(input);
    if (contact.email === null && contact.phone === null) {
      throw AppError.validationFailed({
        issues: ['either email or phone is required'],
      });
    }
    return contact;
  }

  /** Hashes a password for a new wallet. Separated so WalletsService stays thin. */
  async hashPassword(password: string): Promise<{ hash: string; salt: string }> {
    return this.passwords.hash(password);
  }

  /** Exchanges credentials for a token pair. */
  async login(input: ContactInput & { password: string }): Promise<TokenPairResponse> {
    const contact = AuthService.requireOneContact(input);

    const wallet = await this.prisma.wallet.findFirst({
      where: {
        isSystem: false,
        ...(contact.email !== null ? { email: contact.email } : { phone: contact.phone }),
      },
      include: { credential: true },
    });

    // One error for "no such wallet" and for "wrong password", so the endpoint
    // cannot be used to enumerate which emails are registered. The password is
    // still verified against a dummy hash when the wallet is missing, so the
    // two paths take comparable time.
    if (!wallet?.credential) {
      await this.passwords.verify(input.password, 'dummy-salt', '00'.repeat(64));
      throw AppError.invalidCredentials();
    }

    const ok = await this.passwords.verify(
      input.password,
      wallet.credential.salt,
      wallet.credential.passwordHash,
    );
    if (!ok) throw AppError.invalidCredentials();

    return this.issuePair(wallet.id);
  }

  /** Mints a fresh access + refresh pair and allowlists the refresh token. */
  async issuePair(walletId: string): Promise<TokenPairResponse> {
    const accessJti = uuidv7();
    const refreshJti = uuidv7();

    const accessToken = await this.jwt.signAsync(
      { sub: walletId, jti: accessJti, typ: 'access' } satisfies TokenClaims,
      { secret: this.accessSecret, expiresIn: this.accessTtl },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: walletId, jti: refreshJti, typ: 'refresh' } satisfies TokenClaims,
      { secret: this.refreshSecret, expiresIn: this.refreshTtl },
    );

    await this.tokens.allowRefresh(refreshJti, walletId, this.refreshTtl);

    return {
      walletId,
      accessToken,
      refreshToken,
      expiresIn: this.accessTtl,
      tokenType: 'Bearer',
    };
  }

  /**
   * Rotates a refresh token: the presented one is revoked as the new pair is
   * issued, so a captured refresh token is usable at most once.
   */
  async refresh(refreshToken: string): Promise<TokenPairResponse> {
    const claims = await this.verifyToken(refreshToken, 'refresh');

    if (!(await this.tokens.isRefreshAllowed(claims.jti, claims.sub))) {
      // Either it was already used (rotation revoked it) or logout revoked it.
      throw AppError.tokenRevoked();
    }

    // Revoke before issuing. If issuing then failed, the client has to log in
    // again — strictly better than leaving a replayable token alive.
    await this.tokens.revokeRefresh(claims.jti, claims.sub);

    const wallet = await this.prisma.wallet.findUnique({ where: { id: claims.sub } });
    if (!wallet || wallet.isSystem) throw AppError.tokenRevoked();

    return this.issuePair(claims.sub);
  }

  /**
   * Logout. Denylists the presented access token for its remaining lifetime and,
   * when a refresh token is supplied, revokes that too.
   */
  async logout(params: {
    accessJti: string;
    accessExpiresAt: number | undefined;
    walletId: string;
    refreshToken?: string | undefined;
  }): Promise<void> {
    const remaining =
      params.accessExpiresAt === undefined
        ? this.accessTtl
        : params.accessExpiresAt - Math.floor(Date.now() / 1000);

    await this.tokens.revokeAccess(params.accessJti, remaining);

    if (params.refreshToken !== undefined && params.refreshToken !== '') {
      // A bad refresh token must not stop the access token being revoked, which
      // is the part that matters, so failures here are ignored.
      try {
        const claims = await this.verifyToken(params.refreshToken, 'refresh');
        if (claims.sub === params.walletId) {
          await this.tokens.revokeRefresh(claims.jti, claims.sub);
        }
      } catch {
        // Already invalid: nothing to revoke.
      }
    }
  }

  /** Verifies an access token for the guard, including the revocation check. */
  async verifyAccess(token: string): Promise<TokenClaims> {
    const claims = await this.verifyToken(token, 'access');

    if (await this.tokens.isAccessRevoked(claims.jti)) {
      throw AppError.tokenRevoked();
    }
    return claims;
  }

  /**
   * Separate secrets per token type, so a refresh token can never be presented
   * as an access token even though the claim shapes are identical. The `typ`
   * claim is checked as well, belt and braces.
   */
  private async verifyToken(token: string, expected: 'access' | 'refresh'): Promise<TokenClaims> {
    const secret = expected === 'access' ? this.accessSecret : this.refreshSecret;

    let claims: TokenClaims;
    try {
      claims = await this.jwt.verifyAsync<TokenClaims>(token, { secret });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TokenExpiredError') throw AppError.tokenExpired();
      throw AppError.unauthenticated('Token could not be verified');
    }

    if (claims.typ !== expected) throw AppError.tokenWrongType(expected);
    if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
      throw AppError.unauthenticated('Token is missing required claims');
    }
    return claims;
  }
}
