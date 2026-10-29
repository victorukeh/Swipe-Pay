import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

import { REQUEST_ID_HEADER, type CardtonicRequest, headerValue } from '../request-context';

/**
 * An incoming request id is echoed into a response header, written to logs and
 * persisted, so it is accepted only in a shape that is safe in all three.
 *
 * The charset matters more than the length: `res.setHeader` throws on CR/LF,
 * which would turn a malformed header into a 500 raised before the error filter
 * has an id to report, and unescaped control characters in a log line are log
 * forging. The 128 cap keeps a client from writing unbounded junk into logs and
 * the database — generous next to a 36-char UUID or a 55-char traceparent.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Gives every request a correlation id, echoed in the response header and in
 * every error envelope.
 *
 * It is also written to `transaction_attempts`, which is what lets an operator
 * take a request id out of a client's error report and find the exact failed
 * money operation behind it.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: CardtonicRequest, res: Response, next: NextFunction): void {
    const incoming = headerValue(req, REQUEST_ID_HEADER);
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : uuidv7();

    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
