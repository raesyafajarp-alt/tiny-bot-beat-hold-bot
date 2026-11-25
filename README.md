# tiny-bot-beat-hold-bot

[![make.fun · Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/raesyafajarp-alt/tiny-bot-beat-hold-bot/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/raesyafajarp-alt/tiny-bot-beat-hold-bot/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny deterministic paper-trading bot for hourly Solana prices (`agent-fun/bars-replay/v1`). It beats buy-and-hold by riding what is already rising and sitting in cash when everything is falling. TypeScript, Node 22, no dependencies, no network.

## Strategy: Trend-Rotate

- Every 6 bars, rank all 7 symbols by trailing 12-bar return and hold the top 3 — but only the ones whose return clears a 1% bar, and only while the universe median 12-bar return clears it too.
- A held coin ranked 4th gets one bar of grace instead of a churned round trip.
- Each position carries an 8% stop-loss against its cost, and once 15% up, a trailing stop 10% below its peak value.
- When no symbol in the top 3 has a positive 12-bar return, the bot sells everything and holds cash.
- Buys are equal-weighted, capped by the hello weight cap; sells go out first and their proceeds fund the buys on the next batch, as the harness requires.

Guardrails met on the dev window: well over 8 trades, max drawdown far under 25% (see `HANDOFF.md` for the local grade numbers).

## Run it

```sh
node main.ts
```

The bot speaks the harness line protocol on stdin/stdout; grade it locally with the competition kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rmxdpssa&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
