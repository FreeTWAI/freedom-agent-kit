// Thin consumer entrypoint; implementation is exported from the central repo.
import { runFreedomCli } from '../vendor/freedom-tooling/packages/contribution-tools/cli.mjs';
process.exitCode = await runFreedomCli();
