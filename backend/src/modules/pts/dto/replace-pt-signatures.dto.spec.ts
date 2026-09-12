import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReplacePtSignaturesDto } from './replace-pt-signatures.dto';

describe('ReplacePtSignaturesDto', () => {
  it('rejeita assinaturas duplicadas para o mesmo usuário', async () => {
    const signature = {
      user_id: '11111111-1111-4111-8111-111111111111',
      signature_data: 'data:image/png;base64,AAAA',
      type: 'drawn',
    };
    const dto = plainToInstance(ReplacePtSignaturesDto, {
      signatures: [signature, { ...signature }],
    });

    const errors = await validate(dto);
    const signaturesError = errors.find(
      (error) => error.property === 'signatures',
    );

    expect(signaturesError).toBeDefined();
    expect(Object.values(signaturesError?.constraints ?? {}).join(' ')).toMatch(
      /vez|unique|duplic|distint/i,
    );
  });
});
