import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

import { REQUEST_ID_HEADER, type BorderlessRequest, headerValue } from '../request-context';

/** Printable ASCII only: control characters break `setHeader` and forge log lines. */
const SAFE_REQUEST_ID = /^[\x20-\x7E]{1,128}$/;

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
  use(req: BorderlessRequest, res: Response, next: NextFunction): void {
    const incoming = headerValue(req, REQUEST_ID_HEADER);
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : uuidv7();

    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
