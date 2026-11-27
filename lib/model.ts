// Token Radar's scoring model, rebuilt from the sealed snapshot.
//
// The input is one frozen DefiLlama snapshot: a list of protocols with TVL, seven-day
// change, listing date, chains and (where one exists) a token. The output is a ranking of
// the protocols that have no token yet and are not a wrapped, staked or bridged product of
// a token that already trades. The watchlist is the floor — every one of its 40 slugs is
// ranked — and the board then adds every other protocol that passes the same test, so the
// radar surfaces early finds instead of stopping at the house's line.
//
// Implied value is one function of the snapshot's own figures, the same for every row:
//
//   base     = tvl_usd x 0.30
//   growth   = clamp(change_7d, -50, 150) percent
//   growth   multiplier = 1 + (growth / 100) x 0.6
//   maturity multiplier = 0.55 + 0.45 x min(age_days, 1460) / 1460   (unknown age: 365 days)
//   breadth  multiplier = 1 + 0.03 x min(chains - 1, 5)
//   implied  = max(1, round(base x growth x maturity x breadth))
//
// Age is days since first listing: how long the protocol has run with no token. Chain count
// is how many chains its TVL sits on. Rows that tie on implied value are nudged one dollar
// apart so the ranking is strict. Live-token protocols are kept apart and shown with the
// market's own value (market cap), never mixed into the ranked board.
//
// Every ranked row also carries a seven-step farm plan, derived from the protocol's own
// record (category, chains, TVL, age): two qualifying moves, a weekly rhythm, a hold
// window, a points check and an exit plan.

/** One protocol as the sealed snapshot records it. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, in the order the dashboard prints them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_step: number;
  breadth_cap: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.3,
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 150,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1460,
  unknown_age_days: 365,
  breadth_step: 0.03,
  breadth_cap: 5,
};

/** The model's version label, as the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's Live token view carries. */
export const LIVE_ROWS = 24;

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row's compact form for data.js; the page generates the farm plan itself. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A live-token protocol, shown with the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  watchlist: string[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why a snapshot file is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function daysSince(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** Four-decimal rounding, for the multipliers the board prints. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The score one protocol gets: its implied value and the multipliers behind it. */
export function scoreOne(p: SnapshotProtocol, asOf: string, model: ModelConstants): {
  value: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
} {
  const age = daysSince(asOf, p.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, numOr(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageUsed = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageUsed, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const breadthMult = 1 + model.breadth_step * Math.min(Math.max(p.chains.length - 1, 0), model.breadth_cap);
  const value = Math.max(1, Math.round(p.tvl_usd * model.base_multiple * growthMult * maturityMult * breadthMult));
  return { value, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** Categories that mark a wrapped, staked or bridged product of a token that already trades. */
const DERIVATIVE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Names that begin with an exchange's name are that exchange's product, not a new protocol. */
const EXCHANGE_LEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** A whole word wrapped, staked or staking in the name marks a product of another token. */
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;

/** A name ending in a release marker is a pool of another protocol, not a launch. */
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function hasNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a wrapped, staked or bridged product of a token that already trades. */
export function isDerivative(p: SnapshotProtocol): boolean {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (EXCHANGE_LEAD.test(p.name)) return true;
  if (VERSION_TAIL.test(p.name)) return true;
  return false;
}

/** Whether a protocol is one the board may rank: pre-token, and not a derivative product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return hasNoToken(p) && !isDerivative(p);
}

/** The farm plan's two qualifying moves, by category keyword, first match wins. */
interface MovePair {
  keys: string[];
  first: (name: string, capital: number, chain: string) => string;
  second: (name: string, capital: number, chain: string) => string;
}

const MOVES: MovePair[] = [
  {
    keys: ['lend', 'cdp', 'collateral'],
    first: (n, c, ch) => `Supply $${c} of USDC to ${n} on ${ch} and keep the position open.`,
    second: (n) => `Borrow a small amount against the deposit on ${n}, then repay it the same week.`,
  },
  {
    keys: ['dex', 'yield', 'leveraged farm', 'liquidity manager'],
    first: (n, c, ch) => `Provide $${c} of liquidity to ${n}'s main pool on ${ch} and keep the position open.`,
    second: (n) => `Swap a small amount through the same pool on ${n} so the wallet shows trading activity too.`,
  },
  {
    keys: ['bridge'],
    first: (n, c, ch) => `Bridge $${c} of USDC to ${ch} through ${n} and use the bridged funds in its app.`,
    second: (n) => `Send a second, smaller bridge back through ${n} so the wallet shows two-way use.`,
  },
  {
    keys: ['staking', 'restak'],
    first: (n, c) => `Stake $${c} of the chain's staking asset through ${n} and keep the receipt.`,
    second: (n) => `Delegate a second, smaller tranche through ${n} a week later.`,
  },
  {
    keys: ['perpetual', 'derivative', 'basis'],
    first: (n, c) => `Deposit $${c} of USDC as margin on ${n} and open one small hedged position.`,
    second: (n) => `Close the first position on ${n} and open a fresh one the next week.`,
  },
  {
    keys: ['prediction'],
    first: (n, c) => `Fund $${c} and place one market position on ${n}.`,
    second: (n) => `Settle the first market on ${n} and open a second one.`,
  },
  {
    keys: ['curator', 'allocator'],
    first: (n, c, ch) => `Deposit $${c} into a ${n} vault on ${ch} and keep the shares.`,
    second: (n, c, ch) => `Move a slice of the deposit into a second ${n} vault on ${ch}.`,
  },
  {
    keys: ['stable'],
    first: (n, c, ch) => `Mint or deposit $${c} of the stable asset through ${n} on ${ch}.`,
    second: (n) => `Redeem a small amount of the stable asset and re-mint it through ${n}.`,
  },
  {
    keys: ['rwa'],
    first: (n, c, ch) => `Mint $${c} of the protocol's yield-bearing asset on ${ch} and hold it.`,
    second: (n) => `Buy a second, smaller tranche of the yield asset on ${n}.`,
  },
  {
    keys: ['insurance'],
    first: (n, c, ch) => `Buy $${c} of cover from ${n} on ${ch} and keep the policy.`,
    second: (n) => `Extend the cover on ${n} by one more period.`,
  },
  {
    keys: ['aggregator'],
    first: (n, c, ch) => `Deposit $${c} into a ${n} vault on ${ch} and let it auto-compound.`,
    second: (n) => `Harvest the vault's rewards on ${n} and re-deposit them.`,
  },
  {
    keys: ['options'],
    first: (n, c, ch) => `Deposit $${c} into the ${n} options vault on ${ch} and keep the position.`,
    second: (n) => `Roll the options vault position on ${n} into the next round.`,
  },
  {
    keys: ['payment'],
    first: (n, c, ch) => `Top up $${c} through ${n} on ${ch} and make one payment with it.`,
    second: (n, c, ch) => `Make a second payment through ${n} on ${ch}.`,
  },
  {
    keys: ['privacy'],
    first: (n, c, ch) => `Run one shielded transfer of $${c} through ${n} on ${ch}.`,
    second: (n) => `Repeat the shielded transfer on ${n} with a fresh note.`,
  },
  {
    keys: ['index'],
    first: (n, c, ch) => `Buy $${c} of the ${n} index on ${ch} and hold it.`,
    second: (n) => `Rebalance the ${n} index holding once after a month.`,
  },
  {
    keys: ['farm'],
    first: (n, c, ch) => `Stake $${c} of LP tokens in the ${n} farm on ${ch}.`,
    second: (n) => `Harvest the farm rewards on ${n} and stake them again.`,
  },
  {
    keys: ['chain'],
    first: (n, c) => `Bridge $${c} of USDC to ${n} and use its flagship app once.`,
    second: (n) => `Stake a small amount of the chain's gas token on ${n}.`,
  },
];

/** The default moves, for a category no row above matches. */
const DEFAULT_MOVES: MovePair = {
  keys: [],
  first: (n, c, ch) => `Deposit $${c} of USDC into ${n} on ${ch} and keep the position open.`,
  second: (n, c, ch) => `Make a second, smaller deposit into ${n} on ${ch} a week later.`,
};

/** The move pair a category falls under, first match wins, else the default. */
function movesFor(category: string | null): MovePair {
  const c = (category ?? '').toLowerCase();
  for (const m of MOVES) {
    if (m.keys.some((k) => c.includes(k))) return m;
  }
  return DEFAULT_MOVES;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 250_000_000) return 125;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. Two different qualifying moves, a weekly rhythm, a hold window, a points check and
 * an exit plan: the whole answer to "what do I do about it".
 */
export function planFor(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const moves = movesFor(p.category);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: moves.first(p.name, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: moves.second(p.name, capital, chain),
      cost: `about $${Math.max(2, Math.round(capital / 25))} of gas`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Open the protocol's own points or rewards page once a week and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes a week',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log, then unwind after the claim window and keep a dust position in case of a second snapshot.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** One step as a single string: its action, then its cost and time, within 20..600 characters. */
export function joinStep(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The protocols the board ranks, strongest first, ranks 1..n, strictly falling values. */
export function rankBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it
  // cannot, but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable protocol, above and below the floor. No TVL cut: a
  // small protocol growing fast is exactly the early find the radar exists to surface.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => ({ p, ...scoreOne(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // A ranking, not a tie: nudge a row one dollar below the row above it when the model gives
  // the same value, so implied value strictly falls as rank ascends.
  for (let i = 1; i < scored.length; i++) {
    if (scored[i]!.value >= scored[i - 1]!.value) scored[i]!.value = Math.max(1, scored[i - 1]!.value - 1);
  }
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.value,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: planFor(s.p, s.age).map(joinStep),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveSet(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !hasNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function compactRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function assemble(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = rankBoard(snapshot, model);
  const live = liveSet(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    watchlist: snapshot.watchlist,
    rows: board.map(compactRow),
    live,
  };
  return { board, radar };
}

/** A required string field, or a refusal naming it. */
function needStr(doc: Record<string, unknown>, key: string): string {
  const v = doc[key];
  if (typeof v !== 'string') throw new SnapshotError(`snapshot.json has no ${key} string`);
  return v;
}

/** A required number field, or a refusal naming it. */
function needNum(doc: Record<string, unknown>, key: string): number {
  const v = doc[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SnapshotError(`snapshot.json has no ${key} number`);
  return v;
}

/** An optional number field: the number when it is finite, else null. */
function maybeNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** An optional string field: the string, else null. */
function maybeStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** One protocol entry out of the snapshot's array, refused unless it carries a slug, a name and a TVL. */
function readEntry(entry: unknown, i: number): SnapshotProtocol {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
  }
  const p = entry as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: maybeStr(p.category),
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: maybeNum(p.change_7d),
    mcap_usd: maybeNum(p.mcap_usd),
    listed_at: maybeStr(p.listed_at),
    gecko_id: maybeStr(p.gecko_id),
    symbol: maybeStr(p.symbol),
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const asOf = needStr(doc, 'as_of');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new SnapshotError('snapshot.json as_of is not a YYYY-MM-DD date');
  const source = needStr(doc, 'source');
  const floor = needNum(doc, 'floor_usd');
  if (!Number.isSafeInteger(floor) || floor <= 0) throw new SnapshotError('snapshot.json floor_usd is not a positive whole number');
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  return {
    as_of: asOf,
    source,
    floor_usd: floor,
    protocols: doc.protocols.map((entry, i) => readEntry(entry, i)),
    watchlist: doc.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function validateBoard(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function toDataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
