import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool } from '../src/agent/dispatch.mjs';

test('dispatchTool measures overhead and handles concurrent calls', async () => {
  const testTool = async (args) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return args.x * 2;
  };

  const schemaValidator = (args) => {
    if (typeof args.x !== 'number') {
      throw new Error('Invalid args');
    }
  };

  const [res1, res2] = await Promise.all([
    dispatchTool(testTool, { x: 2 }, schemaValidator),
    dispatchTool(testTool, { x: 3 }, schemaValidator)
  ]);

  assert.equal(res1.result, 4);
  assert.equal(res2.result, 6);
  assert(res1.profile.totalTime > 0);
  assert(res2.profile.totalTime > 0);
  assert(typeof res1.profile.validationTime === 'number');
  assert(typeof res1.profile.dispatchOverhead === 'number');
});
