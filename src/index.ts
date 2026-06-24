import { runOnce } from "./runner.js";

async function main() {
  const start = Date.now();
  try {
    const result = await runOnce();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[done] ${elapsed}s collected=${result.collected} persisted=${result.persisted} errors=${result.errors}`);
    process.exit(result.errors > 0 && result.collected === 0 ? 1 : 0);
  } catch (err) {
    console.error(`[fatal] ${(err as Error).stack || (err as Error).message}`);
    process.exit(2);
  }
}

main();
