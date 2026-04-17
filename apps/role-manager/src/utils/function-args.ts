import type { FunctionParameter } from '@openzeppelin/ui-types';

const ARRAY_SUFFIX_RE = /\[[0-9]*\]$/;
const INTEGER_TYPE_RE = /^u?int\d*$/;
const BOOL_TYPE_RE = /^bool$/;
const BYTES_TYPE_RE = /^bytes(\d+)?$/;

function isArrayType(type: string): boolean {
  return ARRAY_SUFFIX_RE.test(type);
}

function hasTupleComponents(param: FunctionParameter): boolean {
  return param.type.startsWith('tuple') && (param.components?.length ?? 0) > 0;
}

function isBlankValue(value: string | undefined): boolean {
  return !value?.trim();
}

function stripArraySuffix(type: string): string {
  return type.replace(ARRAY_SUFFIX_RE, '');
}

function getTupleObjectKey(param: FunctionParameter, index: number): string | null {
  void index;
  return param.name || param.displayName || null;
}

function tupleSupportsObjectInput(param: FunctionParameter): boolean {
  return (
    param.components?.every((component, index) => getTupleObjectKey(component, index)) ?? false
  );
}

function getScalarExampleValue(type: string): string {
  if (INTEGER_TYPE_RE.test(type)) return '"123"';
  if (BOOL_TYPE_RE.test(type)) return 'true';
  if (type === 'address' || BYTES_TYPE_RE.test(type)) return '"0x..."';
  if (type === 'string') return '"text"';
  return '"value"';
}

function getExampleValue(param: FunctionParameter): string {
  if (isArrayType(param.type)) {
    const itemParam = getArrayItemParameter(param);
    return `[${getExampleValue(itemParam)}]`;
  }

  if (hasTupleComponents(param)) {
    if (tupleSupportsObjectInput(param)) {
      const entries =
        param.components?.map((component, index) => {
          const key = getTupleObjectKey(component, index) ?? `item${index}`;
          return `${JSON.stringify(key)}:${getExampleValue(component)}`;
        }) ?? [];
      return `{${entries.join(',')}}`;
    }

    return `[${param.components?.map((component) => getExampleValue(component)).join(',') ?? ''}]`;
  }

  return getScalarExampleValue(param.type);
}

function getFieldList(param: FunctionParameter): string {
  return (
    param.components
      ?.map(
        (component, index) => `${getFunctionParameterLabel(component, index)} (${component.type})`
      )
      .join(', ') ?? ''
  );
}

function getArrayItemParameter(param: FunctionParameter): FunctionParameter {
  return {
    ...param,
    type: stripArraySuffix(param.type),
  };
}

function parseJsonValue(rawValue: string): unknown {
  return JSON.parse(rawValue);
}

function normalizeScalarValue(type: string, value: unknown): unknown {
  if (INTEGER_TYPE_RE.test(type)) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && value.trim()) return BigInt(value.trim());
    throw new Error(`Expected an integer-compatible value for ${type}`);
  }

  if (BOOL_TYPE_RE.test(type)) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    throw new Error('Expected true or false');
  }

  if (typeof value === 'string') return value;
  return String(value);
}

function normalizeTupleValue(param: FunctionParameter, value: unknown): unknown[] {
  const components = param.components ?? [];

  if (Array.isArray(value)) {
    if (value.length !== components.length) {
      throw new Error('Tuple value must include every component in order');
    }

    return components.map((component, index) => normalizeParameterValue(component, value[index]));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return components.map((component, index) => {
      const candidateKeys = [component.name, component.displayName].filter(Boolean) as string[];
      const matchedKey = candidateKeys.find((key) => key in record);
      if (!matchedKey) {
        throw new Error(`Missing tuple field ${getFunctionParameterLabel(component, index)}`);
      }
      return normalizeParameterValue(component, record[matchedKey]);
    });
  }

  throw new Error('Tuple value must be a JSON object or array');
}

function normalizeParameterValue(param: FunctionParameter, value: unknown): unknown {
  if (isArrayType(param.type)) {
    if (!Array.isArray(value)) {
      throw new Error('Array value must be a JSON array');
    }

    const itemParam = getArrayItemParameter(param);
    return value.map((item) => normalizeParameterValue(itemParam, item));
  }

  if (hasTupleComponents(param)) {
    return normalizeTupleValue(param, value);
  }

  return normalizeScalarValue(param.type, value);
}

export function getFunctionParameterLabel(param: FunctionParameter, index: number): string {
  return param.displayName || param.name || `arg${index}`;
}

export function isStructuredTupleParameter(param: FunctionParameter): boolean {
  return hasTupleComponents(param) && !isArrayType(param.type);
}

export function isComplexFunctionParameter(param: FunctionParameter): boolean {
  return hasTupleComponents(param) || isArrayType(param.type);
}

export function isBooleanFunctionParameter(param: FunctionParameter): boolean {
  return BOOL_TYPE_RE.test(param.type) && !isComplexFunctionParameter(param);
}

export function getFunctionParameterPlaceholder(param: FunctionParameter): string {
  if (isComplexFunctionParameter(param)) {
    return getExampleValue(param);
  }

  return param.type;
}

export function getFunctionParameterHelperText(param: FunctionParameter): string | null {
  let helperText: string | null = null;

  if (hasTupleComponents(param)) {
    const fieldList = getFieldList(param);
    if (isArrayType(param.type)) {
      helperText = tupleSupportsObjectInput(param)
        ? `Use a JSON array of objects with fields: ${fieldList}.`
        : `Use a JSON array of tuples in ABI order: ${fieldList}.`;
    } else {
      helperText = tupleSupportsObjectInput(param)
        ? `Use a JSON object with fields: ${fieldList}.`
        : `Use a JSON array in ABI order: ${fieldList}.`;
    }
  } else if (isArrayType(param.type)) {
    helperText = `Use a JSON array, e.g. ${getFunctionParameterPlaceholder(param)}.`;
  }

  if (param.description) {
    return helperText ? `${helperText} ${param.description}` : param.description;
  }

  return helperText;
}

export function parseFunctionParameterValue(param: FunctionParameter, rawValue: string): unknown {
  const trimmedValue = rawValue.trim();
  if (!trimmedValue) return '';

  if (isComplexFunctionParameter(param)) {
    return normalizeParameterValue(param, parseJsonValue(trimmedValue));
  }

  return normalizeScalarValue(param.type, trimmedValue);
}

export function getNestedFunctionParameterKey(parentKey: string, index: number): string {
  return `${parentKey}.${index}`;
}

export function hasFunctionParameterInput(
  param: FunctionParameter,
  values: Record<string, string>,
  fieldKey: string
): boolean {
  if (isStructuredTupleParameter(param)) {
    return (
      param.components?.every((component, index) =>
        hasFunctionParameterInput(component, values, getNestedFunctionParameterKey(fieldKey, index))
      ) ?? false
    );
  }

  return !isBlankValue(values[fieldKey]);
}

export function parseFunctionParameterFormValue(
  param: FunctionParameter,
  values: Record<string, string>,
  fieldKey: string,
  fieldLabel: string
): unknown {
  if (isStructuredTupleParameter(param)) {
    return (
      param.components?.map((component, index) =>
        parseFunctionParameterFormValue(
          component,
          values,
          getNestedFunctionParameterKey(fieldKey, index),
          getFunctionParameterLabel(component, index)
        )
      ) ?? []
    );
  }

  const rawValue = values[fieldKey] ?? '';
  if (isBlankValue(rawValue)) {
    throw new Error(`Enter ${fieldLabel}`);
  }

  try {
    return parseFunctionParameterValue(param, rawValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Enter a valid value';
    throw new Error(`${fieldLabel}: ${message}`);
  }
}

export function toAbiFunctionParameter(param: FunctionParameter): {
  name: string;
  type: string;
  components?: Array<ReturnType<typeof toAbiFunctionParameter>>;
} {
  return {
    name: param.name,
    type: param.type,
    ...(param.components?.length
      ? {
          components: param.components.map((component) => toAbiFunctionParameter(component)),
        }
      : {}),
  };
}
