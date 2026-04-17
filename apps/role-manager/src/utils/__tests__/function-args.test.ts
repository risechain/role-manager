import { describe, expect, it } from 'vitest';

import type { FunctionParameter } from '@openzeppelin/ui-types';

import {
  getFunctionParameterHelperText,
  getFunctionParameterPlaceholder,
  hasFunctionParameterInput,
  parseFunctionParameterFormValue,
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

  it('detects when nested tuple fields are complete without requiring JSON', () => {
    expect(
      hasFunctionParameterInput(
        tupleParam,
        {
          'arg2.0': '1000',
          'arg2.1': '250',
          'arg2.2': 'true',
        },
        'arg2'
      )
    ).toBe(true);
  });

  it('parses nested tuple fields into ABI-ready positional values', () => {
    expect(
      parseFunctionParameterFormValue(
        tupleParam,
        {
          'arg2.0': '1000',
          'arg2.1': '250',
          'arg2.2': 'false',
        },
        'arg2',
        'config'
      )
    ).toEqual([1000n, 250n, false]);
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
