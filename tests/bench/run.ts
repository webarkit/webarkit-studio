/**
 * Benchmark runner: npm run bench [-- runtime|tracker]
 * Prints a table per suite; ops/s and mean latency per operation.
 */
import { runtimeBench } from './runtime.bench';

const suites: Record<string, () => Promise<import('tinybench').Bench>> = {
  runtime: runtimeBench,
  tracker: async () => (await import('./tracker.bench')).trackerBench(),
};

const only = process.argv[2];
for (const [name, make] of Object.entries(suites)) {
  if (only && only !== name) continue;
  const bench = await make();
  await bench.run();
  console.log(`\n${bench.name}`);
  console.table(
    bench.tasks.map((t) => {
      const r = t.result as { latency?: { mean: number; p99?: number }; throughput?: { mean: number } } | undefined;
      return {
        task: t.name,
        'mean (µs)': r?.latency ? +(r.latency.mean * 1000).toFixed(2) : NaN,
        'p99 (µs)': r?.latency?.p99 ? +(r.latency.p99 * 1000).toFixed(2) : NaN,
        'ops/s': r?.throughput ? Math.round(r.throughput.mean) : NaN,
      };
    }),
  );
}
