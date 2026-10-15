// Consumer entrypoint; exported together with the central tooling, not a forked verifier.
import { runPinCli } from '../vendor/freedom-tooling/packages/contribution-tools/pin-cli.mjs';
process.exitCode = await runPinCli();
