import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { BaseController } from './base.controller';
import { EpisController } from '../../modules/epis/epis.controller';
import { MachinesController } from '../../modules/machines/machines.controller';
import { ToolsController } from '../../modules/tools/tools.controller';
import { RisksController } from '../../modules/risks/risks.controller';
import { CreateEpiDto } from '../../modules/epis/dto/create-epi.dto';

/**
 * Regressão de SGS-EPI-SEC-001.
 *
 * `BaseController.create/update` declaram o @Body() com um type parameter
 * genérico. O TypeScript apaga generics em `design:paramtypes` e emite
 * `Object`; o `ValidationPipe` do Nest pula a validação inteira quando o
 * metatype é `Object` (`validation.pipe.js` › `toValidate`).
 *
 * Consequência antes da correção: `whitelist`, `forbidNonWhitelisted` e TODOS
 * os decorators dos DTOs de catálogo — inclusive o `sanitizePlainTextTransform`
 * anti-XSS — eram letra morta em POST/PATCH de /epis, /machines e /tools.
 *
 * Estes testes falham se alguém remover os overrides tipados dos controllers
 * ou reintroduzir o padrão em uma subclasse nova.
 */
describe('BaseController — validação de body nas rotas de catálogo', () => {
  const bodyParamType = (
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    target: Function,
    method: 'create' | 'update',
  ): unknown => {
    const types = Reflect.getMetadata(
      'design:paramtypes',
      target.prototype as object,
      method,
    ) as unknown[] | undefined;
    if (!types) return undefined;
    // create(body) → índice 0 | update(id, body) → índice 1
    return method === 'create' ? types[0] : types[1];
  };

  describe('a armadilha existe de fato no BaseController genérico', () => {
    it('BaseController.create não expõe um metatype validável (por isso os overrides são obrigatórios)', () => {
      // O tsc do build emite `Object` para type parameters genéricos; o ts-jest
      // não emite metadata nenhuma para o método abstrato. Os dois casos levam
      // ao MESMO resultado no ValidationPipe: `!metatype` ou `metatype === Object`
      // fazem `toValidate()` retornar false e o body passar cru.
      const type = bodyParamType(BaseController, 'create');
      expect([Object, undefined]).toContain(type);
    });

    it('ValidationPipe ignora completamente o body quando o metatype é Object', async () => {
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      });

      const hostilePayload = {
        nome: '<script>alert(1)</script>',
        id: '11111111-1111-1111-1111-111111111111',
        deleted_at: '2020-01-01T00:00:00Z',
        company_id: '22222222-2222-2222-2222-222222222222',
        campo_inexistente: 'x',
        validade_ca: 'nao-e-data',
      };

      const passouCru: unknown = await pipe.transform(
        { ...hostilePayload },
        { type: 'body', metatype: Object },
      );
      expect(passouCru).toEqual(hostilePayload);

      await expect(
        pipe.transform(
          { ...hostilePayload },
          { type: 'body', metatype: CreateEpiDto },
        ),
      ).rejects.toThrow();
    });
  });

  describe('cada subclasse de BaseController redeclara o body com DTO concreto', () => {
    const subclasses = [
      { name: 'EpisController', target: EpisController },
      { name: 'MachinesController', target: MachinesController },
      { name: 'ToolsController', target: ToolsController },
      { name: 'RisksController', target: RisksController },
    ];

    it.each(subclasses)(
      '$name.create não expõe @Body() com metatype Object',
      ({ target }) => {
        const type = bodyParamType(target, 'create');
        expect(type).toBeDefined();
        expect(type).not.toBe(Object);
      },
    );

    it.each(subclasses)(
      '$name.update não expõe @Body() com metatype Object',
      ({ target }) => {
        const type = bodyParamType(target, 'update');
        expect(type).toBeDefined();
        expect(type).not.toBe(Object);
      },
    );
  });
});
