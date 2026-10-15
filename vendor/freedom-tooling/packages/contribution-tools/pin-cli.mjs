import { verifyContractPin } from './contracts.mjs';
import { safeFailure, VerificationError } from './errors.mjs';

export async function runPinCli(args = process.argv.slice(2), repositoryRoot = process.cwd()) {
  try {
    if (args.some(arg => arg !== '--remote') || new Set(args).size !== args.length) {
      throw new VerificationError('invalid_arguments');
    }
    // No candidate-provided trust file/root flag. v2 without an operator's
    // trust injection deliberately reports unavailable in this bootstrap CLI.
    const result = await verifyContractPin({ repositoryRoot, remote: args.includes('--remote') });
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const failure = safeFailure(error);
    console.log(JSON.stringify({ format: 'freedom.pin-verification/v1', assurance_level: 'local', ...failure }));
    return failure.status === 'unavailable' ? 2 : 1;
  }
}
