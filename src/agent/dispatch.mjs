export async function dispatchTool(tool, args, schemaValidator) {
  const start = performance.now();

  let validationTime = 0;
  if (schemaValidator) {
    const vStart = performance.now();
    schemaValidator(args);
    validationTime = performance.now() - vStart;
  }

  const invokeStart = performance.now();
  const result = await tool(args);
  const invokeTime = performance.now() - invokeStart;

  const totalTime = performance.now() - start;

  return {
    result,
    profile: {
      totalTime,
      validationTime,
      dispatchOverhead: totalTime - validationTime - invokeTime
    }
  };
}
