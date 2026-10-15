import { VerificationError, requireCondition as check } from './errors.mjs';

// Implements only the keywords used by the fixed governance schemas. This is not
// the preview validator, nor a general-purpose evaluator of candidate schemas.
const keywords = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'enum',
  'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum']);

export function assertSchema(value, schema) {
  check(Object.keys(schema).every(key => keywords.has(key)), 'unsupported_schema_keyword');
  if ('const' in schema) check(value === schema.const, 'schema_violation');
  if (schema.enum) check(schema.enum.includes(value), 'schema_violation');
  const kind = schema.type;
  if (kind) {
    const valid = kind === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : kind === 'array' ? Array.isArray(value) : kind === 'integer' ? Number.isSafeInteger(value)
      : kind === 'null' ? value === null : typeof value === kind;
    check(valid, 'schema_violation');
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    check(value.isWellFormed() && length >= (schema.minLength ?? 0)
      && length <= (schema.maxLength ?? Infinity), 'schema_violation');
    if (schema.pattern) {
      const match = new RegExp(schema.pattern, 'u').exec(value);
      check(match && match[0].length === value.length, 'schema_violation');
    }
  }
  if (typeof value === 'number') check(Number.isFinite(value)
    && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity), 'schema_violation');
  if (Array.isArray(value)) {
    check(value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity), 'schema_violation');
    // Governance uniqueItems are primitive ID/path arrays, not arbitrary objects.
    if (schema.uniqueItems) check(new Set(value).size === value.length, 'schema_violation');
    for (const item of value) if (schema.items) assertSchema(item, schema.items);
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) check(Object.hasOwn(value, key), 'schema_violation');
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) assertSchema(item, schema.properties[key]);
      else if (schema.additionalProperties === false) throw new VerificationError('schema_violation');
      else if (typeof schema.additionalProperties === 'object') assertSchema(item, schema.additionalProperties);
    }
  }
  return value;
}
