import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'cardtonic:isPublic';

/**
 * Opts a route out of the global access-token guard.
 *
 * Used by wallet creation, login, `/rates`, `/currencies` and `/health` — and
 * nothing that touches an existing wallet's money.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
