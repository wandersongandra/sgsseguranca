import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePtDto } from './create-pt.dto';

const basePayload = {
  numero: 'PT-001',
  titulo: 'PT de trabalho operacional',
  data_hora_inicio: '2026-09-10T08:00:00.000Z',
  data_hora_fim: '2026-09-10T18:00:00.000Z',
  site_id: '11111111-1111-4111-8111-111111111111',
  responsavel_id: '22222222-2222-4222-8222-222222222222',
};

describe('CreatePtDto — limite de executantes', () => {
  it('aceita até 200 executantes', async () => {
    const dto = plainToInstance(CreatePtDto, {
      ...basePayload,
      executantes: Array.from(
        { length: 200 },
        (_, index) =>
          `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
      ),
    });

    const errors = await validate(dto);

    expect(
      errors.filter((error) => error.property === 'executantes'),
    ).toHaveLength(0);
  });

  it('rejeita mais de 200 executantes antes da consulta de vínculos', async () => {
    const dto = plainToInstance(CreatePtDto, {
      ...basePayload,
      executantes: Array.from(
        { length: 201 },
        (_, index) =>
          `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
      ),
    });

    const errors = await validate(dto);
    const fieldErrors = errors.filter(
      (error) => error.property === 'executantes',
    );
    const messages = Object.values(fieldErrors[0]?.constraints ?? {}).join(' ');

    expect(fieldErrors.length).toBeGreaterThan(0);
    expect(messages).toMatch(/200/);
  });

  it('rejeita executantes duplicados antes da persistência da junção', async () => {
    const dto = plainToInstance(CreatePtDto, {
      ...basePayload,
      executantes: [
        '33333333-3333-4333-8333-333333333333',
        '33333333-3333-4333-8333-333333333333',
      ],
    });

    const errors = await validate(dto);
    const fieldErrors = errors.filter(
      (error) => error.property === 'executantes',
    );

    expect(fieldErrors.length).toBeGreaterThan(0);
    expect(Object.values(fieldErrors[0]?.constraints ?? {}).join(' ')).toMatch(
      /unique|distinct|duplic/i,
    );
  });

  it('limita os campos textuais de maior volume da PT', async () => {
    const dto = plainToInstance(CreatePtDto, {
      ...basePayload,
      numero: 'x'.repeat(81),
      titulo: 'x'.repeat(201),
      descricao: 'x'.repeat(5001),
      control_description: 'x'.repeat(2001),
      analise_risco_rapida_observacoes: 'x'.repeat(5001),
      resultado_auditoria: 'x'.repeat(201),
      notas_auditoria: 'x'.repeat(2001),
    });

    const errors = await validate(dto);
    const fields = errors.map((error) => error.property);

    expect(fields).toEqual(
      expect.arrayContaining([
        'numero',
        'titulo',
        'descricao',
        'control_description',
        'analise_risco_rapida_observacoes',
        'resultado_auditoria',
        'notas_auditoria',
      ]),
    );
  });

  it('limita referências legadas de evidência antes de persistir payload volumoso', async () => {
    const dto = plainToInstance(CreatePtDto, {
      ...basePayload,
      evidence_photo: 'x'.repeat(100_001),
      evidence_document: 'x'.repeat(100_001),
    });

    const errors = await validate(dto);
    const fields = errors.map((error) => error.property);

    expect(fields).toEqual(
      expect.arrayContaining(['evidence_photo', 'evidence_document']),
    );
  });
});
