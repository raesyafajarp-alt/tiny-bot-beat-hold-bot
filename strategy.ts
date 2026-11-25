// strategy.ts — Trend-Rotate for the bars-replay/v1 hourly Solana contest.
//
// Idea: the scored window is only 3 days of hourly bars, so the edge is not in
// predicting one coin — it is in staying in the coins that are already rising and
// sitting in cash when the whole universe is falling. Every 6 bars the bot ranks
// the 7 symbols by trailing 12-bar return, holds the top 3 — but only the ones
// whose return clears a 1% bar, and only while the universe median 12-bar return
// clears it too; in a falling market it holds cash, which is what beats
// buy-and-hold there. A held coin gets one extra bar of grace (rank 4 is kept,
// not sold) so a marginal rank flip does not churn a round trip. Each open
// position carries an 8% stop-loss against its cost and, once it is 15% up, a
// trailing stop 10% below its peak value.
//
// Deterministic: no clock, no environment, no Math.random; every comparison is
// exact BigInt arithmetic and ties keep universe order (stable sort). All caps,
// fees and scales are read from hello at run time, never hard-coded.

import { BPS, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

/** Bars of history a symbol's momentum is measured over (24 hourly bars). */
export const LOOKBACK_BARS = 12;
/** Bars between rebalances. */
export const REBALANCE_EVERY = 6;
/** How many symbols the bot holds at most. */
export const TOP_N = 3;
/** A held symbol ranked this or better is kept even outside the top 3. */
export const KEEP_N = TOP_N + 1;
/** Stop-loss: sell when a position is worth this many bps under its cost. */
export const STOP_LOSS_BPS = 800;
/** Entry bar: a symbol counts as rising only when its trailing return beats this, in bps. */
export const ENTRY_MIN_BPS = 100;
/** Trailing stop arms once a position's peak value is this many bps over cost. */
export const TRAIL_ARM_BPS = 1500;
/** Trailing stop: sell when a position falls this many bps under its peak value. */
export const TRAIL_DROP_BPS = 1000;
/** Slippage cap, wide open like the house baselines: a fill is never refused for it. */
export const MAX_SLIPPAGE_BPS = 10_000;
/** Market filter: hold nothing while the universe median trailing return is not positive. */
export const MARKET_FILTER = true;

export interface Strategy {
  onBatch(state: BarsState, batchSeq: number): OrderInput[];
}

/** Each universe symbol's latest close as of every batch so far, by seq. */
function recordCloses(history: Map<string, (bigint | null)[]>, state: BarsState): void {
  for (const { symbol } of state.hello.symbols) {
    const closes = history.get(symbol) ?? [];
    while (closes.length < state.seq) closes.push(null);
    closes.push(state.close(symbol));
    history.set(symbol, closes);
  }
}

/**
 * Symbols ranked by trailing return as of batch `seq`, best first. A symbol
 * counts only when both closes exist and the earlier one is positive; returns
 * are compared exactly by cross-multiplication, ties keep universe order.
 */
function ranked(
  history: Map<string, (bigint | null)[]>,
  state: BarsState,
  seq: number,
): { symbol: string; now: bigint; then: bigint; positive: boolean }[] {
  const rows: { symbol: string; now: bigint; then: bigint }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const closes = history.get(symbol)!;
    const now = closes[seq];
    const then = closes[seq - LOOKBACK_BARS];
    if (now !== null && now !== undefined && then !== null && then !== undefined && then > 0n) {
      rows.push({ symbol, now, then });
    }
  }
  rows.sort((a, b) => {
    const l = a.now * b.then;
    const r = b.now * a.then;
    return l > r ? -1 : l < r ? 1 : 0;
  });
  return rows.map((r) => ({
    symbol: r.symbol,
    now: r.now,
    then: r.then,
    positive: r.now * 10_000n > r.then * BigInt(10_000 + ENTRY_MIN_BPS),
  }));
}

export function createStrategy(): Strategy {
  const history = new Map<string, (bigint | null)[]>();
  /** Peak value (quote units) seen for each open position, by symbol. */
  const peaks = new Map<string, bigint>();
  /** Symbols chosen on a rebalance bar whose buys go out on the next batch. */
  let pendingBuys: string[] | null = null;
  /** First rebalance bar: once 12 bars of history exist (warm-up bars count). */
  let nextRebalance = -1;

  function buys(state: BarsState, symbols: readonly string[]): BuyInput[] {
    const { caps, fees } = state.hello;
    const room = Math.min(TOP_N, caps.max_open_positions, caps.max_orders_per_bar) - state.positions.size;
    const coming = symbols
      .filter((s) => !state.positions.has(s) && state.close(s) !== null)
      .slice(0, room > 0 ? room : 0);
    if (coming.length === 0) return [];
    const even = state.cash / BigInt(coming.length);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    const slice = even < byWeight ? even : byWeight;
    if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
    return coming.map((symbol) => ({
      side: 'buy' as const,
      symbol,
      notional_quote_units: slice,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    }));
  }

  function sellAll(state: BarsState, symbols: readonly string[]): OrderInput[] {
    return symbols
      .filter((s) => state.positions.has(s))
      .map((symbol) => ({
        side: 'sell' as const,
        symbol,
        qty: state.positions.get(symbol)!.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      }));
  }

  return {
    onBatch(state, batchSeq): OrderInput[] {
      recordCloses(history, state);
      if (state.warmingUp) return [];
      if (nextRebalance < 0) nextRebalance = Math.max(LOOKBACK_BARS, state.warmupBars);

      // Track each open position's peak value; drop the peak when the position closes.
      for (const symbol of [...peaks.keys()]) {
        if (!state.positions.has(symbol)) peaks.delete(symbol);
      }
      for (const [symbol, p] of state.positions) {
        const value = state.value(symbol, p.qty);
        const peak = peaks.get(symbol) ?? 0n;
        if (value > peak) peaks.set(symbol, value);
      }

      // Stop-loss and trailing stop, checked every batch: a sell here goes out now,
      // its replacement buy (if any) on the next batch.
      const stopped: string[] = [];
      for (const [symbol, p] of state.positions) {
        const value = state.value(symbol, p.qty);
        const cost = p.cost;
        if (cost <= 0n) continue;
        const underCost = value * BPS < cost * BigInt(10_000 - STOP_LOSS_BPS);
        const peak = peaks.get(symbol) ?? 0n;
        const armed = peak * BPS >= cost * BigInt(10_000 + TRAIL_ARM_BPS);
        const trailed = armed && value * BPS < peak * BigInt(10_000 - TRAIL_DROP_BPS);
        if (underCost || trailed) stopped.push(symbol);
      }
      if (stopped.length > 0) {
        const rank = ranked(history, state, batchSeq).map((r) => r.symbol);
        // Stopped symbols are still in state.positions until their sells fill,
        // so they are excluded here and never re-bought on the next batch.
        pendingBuys = rank.slice(0, TOP_N).filter((s) => !state.positions.has(s));
        return sellAll(state, stopped);
      }

      // Buys deferred from the previous batch (its sells have now filled).
      if (pendingBuys !== null) {
        const symbols = pendingBuys;
        pendingBuys = null;
        return buys(state, symbols);
      }

      if (batchSeq < nextRebalance) return [];
      nextRebalance = batchSeq + REBALANCE_EVERY;

      const rank = ranked(history, state, batchSeq);
      // Market filter: the median trailing return across the ranked universe.
      // In a falling market the median is negative and the bot holds cash, which
      // is what beats buy-and-hold there; one noisy green coin is not enough.
      let marketUp = true;
      if (MARKET_FILTER && rank.length > 0) {
        const mids = rank.map((r) => ({ n: r.now, d: r.then }));
        mids.sort((a, b) => {
          const l = a.n * b.d;
          const r2 = b.n * a.d;
          return l > r2 ? 1 : l < r2 ? -1 : 0;
        });
        const mid = mids[Math.floor(mids.length / 2)]!;
        marketUp = mid.n * 10_000n > mid.d * BigInt(10_000 + ENTRY_MIN_BPS);
      }
      const target = marketUp
        ? rank.filter((r) => r.positive).slice(0, TOP_N).map((r) => r.symbol)
        : [];
      // The keep band only covers symbols with a positive return: in a falling
      // market the target is empty and everything is sold to cash.
      const keep = new Set(rank.filter((r) => r.positive).slice(0, KEEP_N).map((r) => r.symbol));
      const toSell = [...state.positions.keys()].filter((s) => !keep.has(s));
      if (toSell.length > 0) {
        pendingBuys = target.filter((s) => !state.positions.has(s));
        return sellAll(state, toSell);
      }
      return buys(state, target);
    },
  };
}
