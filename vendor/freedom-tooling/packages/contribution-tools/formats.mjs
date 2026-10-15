import releaseSet from '../../governance/schemas/release-set.schema.json' with { type: 'json' };
import lockV1 from '../../governance/schemas/contract-pin-v1.schema.json' with { type: 'json' };
import lockV2 from '../../governance/schemas/contract-pin-v2.schema.json' with { type: 'json' };
import proof from '../../governance/schemas/release-proof.schema.json' with { type: 'json' };
import trust from '../../governance/schemas/release-trust.schema.json' with { type: 'json' };
import moduleDescriptor from '../../governance/schemas/module.schema.json' with { type: 'json' };
import codingContext from '../../governance/schemas/coding-context.schema.json' with { type: 'json' };
import verifierReport from '../../governance/schemas/verifier-report.schema.json' with { type: 'json' };
import { assertSchema } from './schema.mjs';
import { parseJson } from './io.mjs';
import { requireCondition as check } from './errors.mjs';

const schemas = { releaseSet, lockV1, lockV2, proof, trust, moduleDescriptor, codingContext, verifierReport };
export function validateFormat(name, value) {
  check(Object.hasOwn(schemas, name), 'unknown_format');
  return assertSchema(value, schemas[name]);
}
export function parseFormat(name, bytes) { return validateFormat(name, parseJson(bytes)); }
