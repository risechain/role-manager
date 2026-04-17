import { describe, expect, it } from 'vitest';

import type { FunctionParameter } from '@openzeppelin/ui-types';

import {
  getFunctionParameterHelperText,
  getFunctionParameterPlaceholder,
  parseFunctionParameterValue,
  toAbiFunctionParameter,
} from '../function-args';

const tupleParam: FunctionParameter = {
  name: 'config',
  type: 'tuple',
  components: [
    { name: 'capacity', type: 'uint128' },
    { name: 'refillRate', type: 'uint128' },
    { name: 'enabled', type: 'bool' },
  ],
};

describe('function-args', () => {
  it('builds tuple placeholders with named JSON fields', () => {
    expect(getFunctionParameterPlaceholder(tupleParam)).toBe(
      '{"capacity":"123","refillRate":"123","enabled":true}'
    );
  });

  it('explains how to provide tuple values', () => {
    expect(getFunctionParameterHelperText(tupleParam)).toBe(
      'Use a JSON object with fields: capacity (uint128), refillRate (uint128), enabled (bool).'
    );
  });

  it('parses tuple JSON objects into ABI-ready positional values', () => {
    expect(
      parseFunctionParameterValue(tupleParam, '{"capacity":"1000","refillRate":250,"enabled":true}')
    ).toEqual([1000n, 250n, true]);
  });

  it('preserves tuple components when converting back to ABI inputs', () => {
    expect(toAbiFunctionParameter(tupleParam)).toEqual({
      name: 'config',
      type: 'tuple',
      components: [
        { name: 'capacity', type: 'uint128' },
        { name: 'refillRate', type: 'uint128' },
        { name: 'enabled', type: 'bool' },
      ],
    });
  });
});
