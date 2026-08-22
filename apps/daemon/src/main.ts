// monadd: the monad daemon. Milestone 1 lands sessions, the event log, and ACP on both sides.
const VERSION = "0.0.0";

if (process.argv.includes("--version")) {
  console.log(`monadd ${VERSION} (scaffold)`);
  process.exit(0);
}

console.log("monadd is not usable yet; Milestone 1 is in progress. See docs/architecture.md.");
process.exit(1);
