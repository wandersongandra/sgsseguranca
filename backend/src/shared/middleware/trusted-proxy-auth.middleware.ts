import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  setTrustedProxyAuthenticationState,
  type TrustedProxyPolicy,
} from '../utils/request-ip.util';

/**
 * Marca a requisição somente depois da validação do segredo interno do proxy.
 * O estado fica em WeakMap no resolver e não pode ser criado por header.
 */
export function createTrustedProxyAuthenticationMiddleware(
  policy: TrustedProxyPolicy,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    setTrustedProxyAuthenticationState(
      req,
      policy.mode === 'authenticated' && policy.isProxyAuthHeaderValid(req),
    );
    next();
  };
}
