import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApprovePtDto } from './approve-pt.dto';

describe('ApprovePtDto', () => {
  it('rejeita motivo de aprovação acima de 2000 caracteres', async () => {
    const dto = plainToInstance(ApprovePtDto, {
      reason: 'x'.repeat(2001),
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain('reason');
  });
});
