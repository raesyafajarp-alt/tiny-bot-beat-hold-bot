// main.ts — entrypoint: wires the Trend-Rotate strategy into the bars-replay/v1
// harness shim. The grader runs `node /bot/main.ts`; stdout carries replies only
// (diagnostics go to stderr).
import { runBars } from './vendor/makefun-bars.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBars({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch.seq);
  },
  onDone(state) {
    console.error(
      `done: equity ${state.equity} cash ${state.cash} positions ${state.positions.size}`,
    );
  },
});
