import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isAiFeatureEnabled } from '../config/ai-feature-policy';

/**
 * Feature flag para desativar completamente IA no ambiente.
 *
 * Regra:
 * - FEATURE_AI_ENABLED=false  -> desativa (404)
 * - FEATURE_AI_ENABLED=true   -> ativa
 * - FEATURE_AI_ENABLED ausente -> ativa por padrão
 *
 * O default ON evita indisponibilidade acidental em produção por variável
 * ausente após deploy/migração. Quem quiser desligar deve declarar "false".
 */
@Injectable()
export class FeatureAiGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isAiFeatureEnabled()) {
      throw new NotFoundException();
    }
    return true;
  }
}
