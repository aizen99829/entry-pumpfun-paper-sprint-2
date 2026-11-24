// Pump.fun Paper Sprint bot: momentum sniper with disciplined exits.
//
// Buy each fresh coin once, small (0.15 SOL), as soon as the size cap allows
// AND its virtual price has already risen >= 5% above its creation price
// (momentum filter: real early demand, not a dead curve). Then exit on
// take-profit (1.8x entry), stop-loss (0.65x entry), a trailing stop
// (peak >= 1.10x entry, sell when price falls to 0.85x peak), or a time exit
// (1500 slots held). Fast turnover across many coins is how the entry reaches
// the 20-distinct-mint breadth guardrail.
//
// Determinism: no clock, no environment, no Math.random. Every price comparison
// is integer cross-multiplication on bigints; iteration order is Map insertion
// order only. current price = vq / vt (virtual reserves); entry price = eq / et
// (quote spent / tokens received on the buy fill). current >= entry * num/den
// <=> vq * et * den >= vt * eq * num.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 15n) / 100n; // 0.15 SOL
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1000;
const MAX_AGE_SLOTS = 1200;
const MAX_HOLD_SLOTS = 1500;

interface Entry {
  eq: bigint; // quote lamports spent on the buy fill (fees included)
  et: bigint; // tokens received on the buy fill
  pq: bigint; // peak virtual quote reserves seen since entry
  pt: bigint; // peak virtual token reserves seen since entry
  buySlot: number; // slot the buy fill resolved at
}

type OrderOut =
  | { side: 'buy'; mint: string; quote_lamports: bigint; max_slippage_bps: number; client_id?: string }
  | { side: 'sell'; mint: string; token_amount: bigint; max_slippage_bps: number };

const candidates = new Set<string>();
const entries = new Map<string, Entry>();
/** Virtual reserves at each coin's CreateEvent: the momentum baseline. */
const createPrices = new Map<string, { cq: bigint; ct: bigint }>();
let buySeq = 0;

/** current >= entry * num/den, all bigint cross-multiplication. */
function atOrAbove(vq: bigint, vt: bigint, eq: bigint, et: bigint, num: bigint, den: bigint): boolean {
  return vq * et * den >= vt * eq * num;
}

/** current <= entry * num/den, all bigint cross-multiplication. */
function atOrBelow(vq: bigint, vt: bigint, eq: bigint, et: bigint, num: bigint, den: bigint): boolean {
  return vq * et * den <= vt * eq * num;
}

await runBot({
  onBatch(state, batch) {
    // 1. Fold this batch's fills into our entry records.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // Harness close (curve completed / replay flattened / writeoff): position gone.
        entries.delete(f.mint);
        candidates.delete(f.mint);
        continue;
      }
      if (f.side === 'buy' && f.status === 'filled') {
        const eq = BigInt(f.quote_lamports);
        const et = BigInt(f.token_amount);
        if (eq > 0n && et > 0n) {
          const curve = state.curves.get(f.mint);
          entries.set(f.mint, {
            eq,
            et,
            pq: curve ? curve.virtual_quote_reserves : eq,
            pt: curve ? curve.virtual_token_reserves : et,
            buySlot: f.slot,
          });
        }
      } else if (f.side === 'sell' && f.status === 'filled') {
        entries.delete(f.mint);
      }
      // Rejected/failed fills leave no record: a rejected buy stays decided
      // (mint already left candidates when the order was sent); a rejected
      // sell keeps its entry record, so the exit is retried next batch.
    }

    const orders: OrderOut[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // 2. Exits first, so a freed slot can be reused by a buy in the same reply.
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (pendingSell.has(mint)) continue;
      const entry = entries.get(mint);
      if (entry === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (vq === 0n || vt === 0n) continue;
      // Track the peak: current > peak <=> vq * pt > vt * pq.
      if (vq * entry.pt > vt * entry.pq) {
        entry.pq = vq;
        entry.pt = vt;
      }
      const tp = atOrAbove(vq, vt, entry.eq, entry.et, 18n, 10n);
      const sl = atOrBelow(vq, vt, entry.eq, entry.et, 65n, 100n);
      // Trailing stop: peak reached >= 1.10x entry and price fell to <= 0.85x peak.
      const peakHigh = entry.pq * entry.et * 10n >= entry.pt * entry.eq * 11n;
      const fellFromPeak = vq * entry.pt * 100n <= vt * entry.pq * 85n;
      const trailing = peakHigh && fellFromPeak;
      const timedOut = state.slot - entry.buySlot > MAX_HOLD_SLOTS;
      if (tp || sl || trailing || timedOut) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // 3. Buys: register new coins from this batch's events, in chain order.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        candidates.add(e.mint);
        createPrices.set(e.mint, { cq: BigInt(e.virtual_quote_reserves), ct: BigInt(e.virtual_token_reserves) });
      }
      if (e.event === 'CompleteEvent') {
        candidates.delete(e.mint);
        entries.delete(e.mint);
      }
    }
    for (const mint of [...candidates]) {
      if (orders.length >= maxOrders || slots <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(mint);
        continue;
      }
      const created = curve.created_slot ?? state.slot;
      if (state.slot - created > MAX_AGE_SLOTS) {
        candidates.delete(mint);
        continue;
      }
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      // Momentum filter: only buy coins whose virtual price already rose >= 5%
      // above their creation price — real early demand, not a dead curve.
      // current >= create * 105/100 <=> vq * ct * 100 >= vt * cq * 105.
      // A coin that has not risen yet stays a candidate and may qualify later.
      const cp = createPrices.get(mint);
      if (cp !== undefined) {
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vt === 0n || vq * cp.ct * 100n < vt * cp.cq * 105n) continue;
      }
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      candidates.delete(mint);
      buySeq += 1;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
        client_id: `b${buySeq}`,
      });
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
