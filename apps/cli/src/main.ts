// monad: the CLI client. Milestone 1 lands run, attach, ls, daemon, and acp-stdio.
const VERSION = "0.0.0";

if (process.argv.includes("--version")) {
  console.log(`monad ${VERSION} (scaffold)`);
  process.exit(0);
}

console.log("monad is not usable yet; Milestone 1 is in progress. See docs/architecture.md.");
process.exit(1);
