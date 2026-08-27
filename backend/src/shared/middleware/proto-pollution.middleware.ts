import type { Request, Response, NextFunction } from 'express';
import { Logger } from '@nestjs/common';
import { getRequestIp } from '../utils/request-ip.util';

const logger = new Logger('ProtoPollutionMiddleware');

/** Chaves que, se presentes em qualquer nível do body, indicam tentativa de pollution. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Middleware de proteção contra prototype pollution.
 *
 * Inspeciona recursivamente o body JSON da requisição e rejeita com 400
 * qualquer payload que contenha chaves perigosas (`__proto__`, `constructor`,
 * `prototype`).
 *
 * Por que aqui e não apenas no ValidationPipe?
 *   O ValidationPipe com `whitelist:true` remove chaves extras, mas a
 *   contaminação do prototype pode ocorrer durante o parsing do JSON pelo
 *   body-parser ANTES do ValidationPipe ser executado — se o payload for
 *   deserializado com JSON.parse sem sanitização prévia.
 *
 * Referência: CVE-2019-10744 (lodash), CVE-2020-28282 (getobject).
 */
function hasDangerousKey(value: unknown, depth = 0): boolean {
  // Limitar profundidade para evitar DoS por objetos muito aninhados
  if (depth > 10) return false;

  if (typeof value !== 'object' || value === null) return false;

  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (hasDangerousKey((value as Record<string, unknown>)[key], depth + 1)) {
      return true;
    }
  }

  return false;
}

export function protoPollutionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body as unknown;

  // Só inspeciona quando há body parseado (JSON ou form)
  if (body !== null && typeof body === 'object') {
    if (hasDangerousKey(body)) {
      logger.warn({
        event: 'proto_pollution_blocked',
        method: req.method,
        path: req.path,
        ip: getRequestIp(req),
        // Nunca logar o body completo — apenas sinalizar o evento
      });

      res.status(400).json({
        success: false,
        statusCode: 400,
        message: 'Payload inválido.',
        errorCode: 'BAD_REQUEST',
      });
      return;
    }
  }

  next();
}
