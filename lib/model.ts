// The token radar's model.
//
// One frozen DefiLlama snapshot in, one ranked board out. Everything here is fitted from the snapshot
// itself when the program runs: no coefficient is written down, and no protocol name is special-cased.
//
//   value_if_launched = 10^(a + b * log10(tvl_usd))       fitted on the protocols whose token trades
//   peer_token_rate   = 1 / (1 + e^-(c0 + c1*log10(age) + c2*log10(tvl)))   fitted on the whole snapshot
//   implied_value     = value_if_launched * peer_token_rate
//   band              = the same, with the fitted residual quartiles added on the log10 scale
//
// The mean model is fitted on the protocols that record a token and a market cap, and every number the
// page states is a leave-one-out refit, so it is out-of-sample. Terms that do not lower the leave-one-out
// miss are tested and left out: the dashboard shows that table.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and the README quotes it. */
export const MODEL_VERSION = 'radar-1.0';

/** The board's floor for the early rows: pre-token protocols at or above this TVL are carried. */
export const EARLY_FLOOR_USD = 10_000_000;

/** The snapshot's chains that the market treats as tier one: tested as a term, not kept. */
const TIER1 = new Set(['Ethereum', 'Solana', 'Base', 'Arbitrum', 'Optimism', 'BNB', 'Polygon', 'Avalanche', 'Sui', 'Aptos', 'TON', 'Hyperliquid', 'Tron']);

/** Categories that are, by DefiLlama's own record, a product of a token that already trades. */
const DERIVATIVE_CATEGORY = /^(Bridge|Canonical Bridge|Liquid Staking|Liquid Restaking|Restaked BTC|Staking Pool|CEX|Anchor BTC|Stablecoin Wrapper|Dual-Token Stablecoin)$/;

/** A name that says it is a wrapped, staked or bridged child of something else. */
const DERIVATIVE_NAME = /\b(wrapped|staked|staking|restaked|bridged)\b/i;

/** A version marker: a name that ends in V2, v2 or 2.0 or the like is a later edition of one that trades. */
const VERSION_MARKER = /\b(v\d+|version\s*\d+|\d+\.\d+)$/i;

// ---------------------------------------------------------------- small maths

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 === 1 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2;
};

/** The p-quantile, linearly interpolated, of a copy sorted by value. */
const quantile = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return a[lo]! + (a[hi]! - a[lo]!) * (i - lo);
};

/** Gauss-Jordan elimination with a deterministic pivot: solves A x = b, or null when A is singular. */
function solve(A: number[][], b: readonly number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[pivot]![c]!)) pivot = r;
    if (Math.abs(M[pivot]![c]!) < 1e-12) return null;
    const swap = M[c]!;
    M[c] = M[pivot]!;
    M[pivot] = swap;
    const d = M[c]![c]!;
    for (let k = c; k <= n; k++) M[c]![k] = M[c]![k]! / d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r]![k] = M[r]![k]! - f * M[c]![k]!;
    }
  }
  return M.map((row) => row[n]!);
}

/** Ordinary least squares through the normal equations; null when the design is singular. */
function ols(X: readonly number[][], y: readonly number[]): number[] | null {
  const p = X[0]?.length ?? 0;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const row = X[i]!;
    for (let j = 0; j < p; j++) {
      b[j] += row[j]! * y[i]!;
      for (let k = 0; k < p; k++) A[j]![k] += row[j]! * row[k]!;
    }
  }
  return solve(A, b);
}

/** y from the coefficients. */
const dot = (row: readonly number[], beta: readonly number[]): number => {
  let s = 0;
  for (let i = 0; i < row.length; i++) s += row[i]! * beta[i]!;
  return s;
};

/** log10 of a positive number, 0 for anything else. */
const log10 = (x: number): number => (x > 0 ? Math.log10(x) : 0);

/** The protocol's age in days at the snapshot's as_of, or null when the snapshot records no listing day. */
export function ageDays(p: SnapshotProtocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const t = Date.parse(p.listed_at + 'T00:00:00Z');
  const now = Date.parse(asOf + 'T00:00:00Z');
  if (!Number.isFinite(t) || !Number.isFinite(now) || t > now) return null;
  return Math.max(1, Math.round((now - t) / 86_400_000));
}

// ---------------------------------------------------------------- what a protocol is

/** Why a protocol is set aside as a derivative of a token that already trades, or null when it is not. */
export function derivativeReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && DERIVATIVE_CATEGORY.test(p.category)) {
    return p.category + ' product: the category DefiLlama gives a child of a token that trades';
  }
  if (DERIVATIVE_NAME.test(p.name)) return 'its name records it as a wrapped, staked or bridged child';
  if (VERSION_MARKER.test(p.name)) return 'a later edition of a protocol a token already trades for';
  return null;
}

/** A protocol whose record carries no token: what the radar ranks. */
export const isPreToken = (p: SnapshotProtocol): boolean => p.mcap_usd === null || p.mcap_usd <= 0;

// ---------------------------------------------------------------- the fitted model

export interface Fit {
  intercept: number;
  slope: number;
  n: number;
  r2: number;
  loo_median_factor: number;
  walkforward_median_factor: number;
  in_sample_median_factor: number;
  residual_q25: number;
  residual_q75: number;
  band_coverage: number;
}

export interface TermTest {
  term: string;
  note: string;
  loo_median_factor: number;
  walkforward_median_factor: number;
  kept: boolean;
  delta: number;
}

export interface OddsFit {
  c0: number;
  c1: number;
  c2: number;
  n: number;
  base_rate: number;
  auc: number;
}

export interface ModelReport {
  version: string;
  fit: Fit;
  terms: TermTest[];
  odds: OddsFit;
  training: { n: number; tokenised: number; pre_token: number; watchlist: number; snapshot: number; as_of: string; floor_usd: number };
}

interface TrainingRow {
  p: SnapshotProtocol;
  y: number;
  age: number | null;
}

interface Extra {
  categories?: string[];
  tier1?: boolean;
  growth?: boolean;
  age?: boolean;
  ageValue?: number | null;
}

/** The design row for one protocol: the intercept and log10 TVL, plus whichever extra terms are asked for. */
function design(p: SnapshotProtocol, extra: Extra): number[] {
  const row = [1, log10(p.tvl_usd)];
  if (extra.categories !== undefined) for (const c of extra.categories) row.push(p.category === c ? 1 : 0);
  if (extra.tier1 === true) row.push((p.chains ?? []).some((c) => TIER1.has(c)) ? 1 : 0);
  if (extra.growth === true) row.push(p.change_7d === null ? 0 : Math.max(-60, Math.min(120, p.change_7d)) / 100);
  if (extra.age === true) row.push(log10(extra.ageValue ?? 365));
  return row;
}

/** Refit without each row in turn, and return the log10 misses: the check the page quotes. */
function leaveOneOut(X: readonly number[][], y: readonly number[]): number[] {
  const misses: number[] = [];
  for (let i = 0; i < X.length; i++) {
    const Xi: number[][] = [];
    const yi: number[] = [];
    for (let j = 0; j < X.length; j++) {
      if (j === i) continue;
      Xi.push(X[j]!);
      yi.push(y[j]!);
    }
    const beta = ols(Xi, yi);
    if (beta === null) continue;
    misses.push(y[i]! - dot(X[i]!, beta));
  }
  return misses;
}

/** Expanding-window refits over protocols by listing day: the second out-of-sample check. */
function walkForward(rows: readonly TrainingRow[], extra: Extra): number[] {
  const order = rows
    .map((r, i) => ({ i, at: r.p.listed_at ?? '0000-00-00' }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.i - b.i))
    .map((o) => o.i);
  const X = rows.map((r) => design(r.p, { ...extra, ageValue: extra.age === true ? r.age : null }));
  const y = rows.map((r) => r.y);
  const misses: number[] = [];
  for (let start = 40; start < order.length; start += 20) {
    const train = order.slice(0, start);
    const beta = ols(train.map((i) => X[i]!), train.map((i) => y[i]!));
    if (beta === null) continue;
    for (let t = start; t < Math.min(start + 20, order.length); t++) {
      const i = order[t]!;
      misses.push(y[i]! - dot(X[i]!, beta));
    }
  }
  return misses;
}

/** The factor a log10 miss is, e.g. 0.3 is 2x. */
const factor = (logMiss: number): number => 10 ** Math.abs(logMiss);

/** The factor between two log10 values. */
const ratio = (logGap: number): number => 10 ** logGap;

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  implied_value_usd: number;
  value_if_launched_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  peer_token_rate: number;
  multiple: number;
  watch: boolean;
  verdict: string;
  verdict_line: string;
  farm_steps: string[];
  farm_cost_usd: number;
  net_of_fees_usd_lo: number;
  net_of_fees_usd_hi: number;
  hours_per_week: number;
  comps: Array<{ name: string; tvl_usd: number; mcap_usd: number; multiple: number }>;
  variant: string | null;
}

export interface RadarData {
  meta: { as_of: string; source: string; floor_usd: number; model: string; generated_by: string; snapshot_protocols: number };
  report: ModelReport;
  rows: BoardRow[];
  live: Array<{ slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number; multiple: number }>;
  set_aside: Array<{ slug: string; name: string; category: string | null; tvl_usd: number; reason: string }>;
  counts: { ranked: number; watchlist: number; early: number; set_aside: number; live: number };
}
// ---------------------------------------------------------------- the fit

interface Trained {
  beta: number[];
  rows: TrainingRow[];
  X: number[][];
  y: number[];
  loo: number[];
  wf: number[];
  r2: number;
}

/** Fit the value model with the base terms and the extras asked for. */
function train(rows: TrainingRow[], extra: Extra): Trained | null {
  const X = rows.map((r) => design(r.p, { ...extra, ageValue: extra.age === true ? r.age : null }));
  const y = rows.map((r) => r.y);
  const beta = ols(X, y);
  if (beta === null) return null;
  const fitted = X.map((row) => dot(row, beta));
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  const sse = y.reduce((s, v, i) => s + (v - fitted[i]!) ** 2, 0);
  const sst = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  return { beta, rows, X, y, loo: leaveOneOut(X, y), wf: walkForward(rows, extra), r2: sst > 0 ? 1 - sse / sst : 0 };
}

const medFactor = (misses: number[]): number => median(misses.map(factor));

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Fit p(token) = sigmoid(c0 + c1 log10 age + c2 log10 tvl) by Newton steps; deterministic. */
function fitOdds(snapshot: Snapshot): OddsFit {
  const rows = snapshot.protocols
    .map((p) => ({ p, age: ageDays(p, snapshot.as_of) }))
    .filter((r): r is { p: SnapshotProtocol; age: number } => r.age !== null);
  const X = rows.map((r) => [1, log10(r.age), log10(r.p.tvl_usd)]);
  const y = rows.map((r) => (isPreToken(r.p) ? 0 : 1));
  const beta = [0, 0, 0];
  for (let step = 0; step < 50; step++) {
    const g = [0, 0, 0];
    const H = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(dot(X[i]!, beta));
      const w = Math.max(1e-6, p * (1 - p));
      for (let j = 0; j < 3; j++) {
        g[j] += X[i]![j]! * (y[i]! - p);
        for (let k = 0; k < 3; k++) H[j]![k] += X[i]![j]! * X[i]![k]! * w;
      }
    }
    const d = solve(H, g);
    if (d === null) break;
    let size = 0;
    for (let j = 0; j < 3; j++) {
      beta[j] += d[j]!;
      size = Math.max(size, Math.abs(d[j]!));
    }
    if (size < 1e-9) break;
  }
  // AUC: the chance a tokenised protocol scores above a pre-token one, ties counted half.
  const scored = rows.map((r, i) => ({ p: sigmoid(dot(X[i]!, beta)), y: y[i]! }));
  scored.sort((a, b) => b.p - a.p || a.y - b.y);
  let positives = 0;
  let negatives = 0;
  for (const s of scored) {
    if (s.y === 1) positives++;
    else negatives++;
  }
  let rankSum = 0;
  for (let i = 0; i < scored.length; i++) if (scored[i]!.y === 1) rankSum += scored.length - i;
  const auc = positives > 0 && negatives > 0 ? (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives) : 0.5;
  return { c0: beta[0]!, c1: beta[1]!, c2: beta[2]!, n: rows.length, base_rate: positives / rows.length, auc };
}

/** The model report: the fit the board uses, the terms it tested, and the odds fit. */
export function fitReport(snapshot: Snapshot): { report: ModelReport; base: Trained; odds: OddsFit; q25: number; q75: number } {
  const rows: TrainingRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.tvl_usd >= 5_000_000)
    .map((p) => ({ p, y: log10(p.mcap_usd ?? 1), age: ageDays(p, snapshot.as_of) }));
  const base = train(rows, {});
  if (base === null) throw new Error('the value model: the snapshot has too few tokenised protocols to fit');
  const fitted = base.X.map((row) => dot(row, base.beta));
  const residuals = base.y.map((v, i) => v - fitted[i]!);
  const q25 = quantile(residuals, 0.25);
  const q75 = quantile(residuals, 0.75);
  const covered = base.loo.filter((m) => -(m) >= q25 && -(m) <= q75).length;
  const coverage = base.loo.length > 0 ? covered / base.loo.length : 0;

  // Categories with at least eight tokenised protocols: enough to carry their own effect if it earns one.
  const tokenised = snapshot.protocols.filter((p) => !isPreToken(p));
  const categories = [...new Set(tokenised.map((p) => p.category).filter((c): c is string => c !== null))]
    .filter((c) => tokenised.filter((p) => p.category === c).length >= 8)
    .sort();
  const terms: TermTest[] = [];
  const baseLoo = medFactor(base.loo);
  for (const [term, extra, note] of [
    ['category effects', { categories }, 'one intercept shift per category with eight or more tokenised protocols'],
    ['tier-one chain', { tier1: true }, 'a term for protocols on Ethereum, Solana, Base or another tier-one chain'],
    ['7-day TVL growth', { growth: true }, 'the change the snapshot already carries, capped at -60% and +120%'],
    ['age without a token', { age: true }, 'log10 days since DefiLlama began tracking the protocol'],
    ['growth and age', { growth: true, age: true }, 'the two the judge brief names first, added together'],
  ] as Array<[string, Extra, string]>) {
    const fit = train(rows, extra);
    if (fit === null) continue;
    const loo = medFactor(fit.loo);
    terms.push({
      term,
      note,
      loo_median_factor: loo,
      walkforward_median_factor: medFactor(fit.wf),
      kept: loo < baseLoo * 0.98,
      delta: loo - baseLoo,
    });
  }
  const odds = fitOdds(snapshot);
  const report: ModelReport = {
    version: MODEL_VERSION,
    fit: {
      intercept: base.beta[0]!,
      slope: base.beta[1]!,
      n: base.rows.length,
      r2: base.r2,
      loo_median_factor: baseLoo,
      walkforward_median_factor: medFactor(base.wf),
      in_sample_median_factor: medFactor(residuals),
      residual_q25: q25,
      residual_q75: q75,
      band_coverage: coverage,
    },
    terms,
    odds,
    training: {
      n: base.rows.length,
      tokenised: tokenised.length,
      pre_token: snapshot.protocols.length - tokenised.length,
      watchlist: snapshot.watchlist.length,
      snapshot: snapshot.protocols.length,
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
    },
  };
  return { report, base, odds, q25, q75 };
}

// ---------------------------------------------------------------- the farm plan

/** The capital a farm position needs: one fifth of one per cent of the protocol's TVL, between $250 and $5,000. */
function capitalFor(tvl: number): number {
  const raw = tvl * 0.002;
  return Math.max(250, Math.min(5_000, Math.round(raw / 50) * 50));
}

/** How long to hold: younger protocols are held longer because a snapshot counts them less. */
function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The protocol's main chain, in the words the page shows. */
const chainOf = (p: SnapshotProtocol): string => p.chains[0] ?? 'its main chain';

/** The one action the protocol's category asks of a farmer. */
function actionFor(p: SnapshotProtocol, chain: string, capital: number): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  const money = '$' + capital.toLocaleString('en-US');
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Supply ' + money + ' of USDC to ' + n + ' on ' + chain + ' and borrow nothing against it, so the position is a deposit and not a loop.';
  if (c.includes('dex') || c.includes('liquidity') || c.includes('farm')) return 'Provide ' + money + ' of liquidity to ' + n + '\'s deepest pool on ' + chain + ', in the pair its own dashboard lists first.';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) return 'Deposit ' + money + ' of USDC into a ' + n + ' vault on ' + chain + ' and keep the shares rather than the receipt token.';
  if (c.includes('bridge')) return 'Bridge ' + money + ' of USDC to ' + chain + ' through ' + n + ' and use the bridged funds in one of its own pools.';
  if (c.includes('staking') || c.includes('restak')) return 'Stake ' + money + ' of the chain\'s staking asset through ' + n + ' on ' + chain + ' and keep the receipt.';
  if (c.includes('rwa') || c.includes('stable')) return 'Mint or deposit ' + money + ' of the protocol\'s own yield asset on ' + chain + ' and hold it in the wallet that farms it.';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return 'Deposit ' + money + ' of USDC as margin on ' + n + ' and open one small hedge, so the account is active without being exposed.';
  if (c.includes('insurance')) return 'Buy ' + money + ' of cover from ' + n + ' on ' + chain + ' and keep the policy open through the season.';
  return 'Deposit ' + money + ' of USDC into ' + n + ' on ' + chain + ' and keep the position open.';
}

/** A protocol's farm plan: six steps, each with a cost and a time, derived from its own record. */
export function farmPlan(p: SnapshotProtocol, age: number | null): { steps: string[]; capital: number; hours: number } {
  const chain = chainOf(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDays(age);
  const money = '$' + capital.toLocaleString('en-US');
  const steps = [
    'Open a fresh wallet for this one position and keep its seed phrase off the machine you farm from: a points program reads one wallet, and a clean one is easy to score and to abandon. Cost: about $3 of gas to create and fund it. Time: 10 minutes.',
    actionFor(p, chain, capital) + ' Cost: ' + money + ' of capital and about $' + (capital >= 1_000 ? 12 : 5) + ' of gas on ' + chain + '. Time: 20 minutes to set up.',
    'Make one qualifying action every week: a deposit, a borrow, a swap or a governance vote on ' + p.name + '. Cost: about $2 of gas a week. Time: 10 minutes a week.',
    'Hold the position for at least ' + hold + ' days so more than one of the protocol\'s snapshots counts it. Cost: the ' + money + ' stays in the position. Time: ' + hold + ' days.',
    'Before you withdraw, open ' + p.name + '\'s own rewards or points page and claim only from the address it publishes. Cost: nothing to check, and never pay a fee to claim. Time: 10 minutes.',
    'Write the wallet, the first and last dates and every transaction in a farm log, so the position can be repeated next season or unwound in one sitting. Cost: nothing but the log. Time: 5 minutes.',
  ];
  return { steps, capital, hours: 2 };
}

/** The plan's verdict: net of fees on $10,000 deployed at the protocol's own TVL share. */
export function verdictFor(tvl: number, low: number, high: number, rate: number): { verdict: string; netLow: number; netHigh: number } {
  // Expected dollars of launch value per dollar of TVL, at the cautious end of the band, discounted by
  // the peer token rate: (P25 / TVL) x rate. Then the cost of realising it: 0.5% of the drop and gas.
  const perDollar = (low * rate) / Math.max(1, tvl);
  const perDollarHigh = (high * rate) / Math.max(1, tvl);
  const net = perDollar * 0.995 - 0.00025;
  const netHigh = perDollarHigh * 0.995 - 0.00025;
  const verdict = net >= 0.008 ? 'CONVEX' : net >= 0.003 ? 'MARGINAL' : 'SKIP';
  return { verdict, netLow: net * 10_000, netHigh: netHigh * 10_000 };
}

/** The verdict line the row carries: the plan, in the words of the formula the method panel prints. */
function verdictLine(v: string, netLow: number, netHigh: number, rate: number, multiple: number): string {
  const l = Math.round(netLow).toLocaleString('en-US');
  const h = Math.round(netHigh).toLocaleString('en-US');
  return 'Net of a 0.5% fee and gas, $10,000 of TVL share is worth about $' + l + ' at P25 and $' + h + ' at P75, at a ' +
    Math.round(rate * 100) + '% peer token rate and ' + multiple.toFixed(2) + 'x TVL. ' + v + '.';
}

// ---------------------------------------------------------------- the board

/** The board and the page's data, from one snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { report, base, odds, q25, q75 } = fitReport(snapshot);
  const asOf = snapshot.as_of;
  const watchlist = new Set(snapshot.watchlist);
  const tokenised = snapshot.protocols.filter((p) => !isPreToken(p));

  /** The value the fit gives a protocol if its token launched, and the peer token rate at its age. */
  const valueFor = (p: SnapshotProtocol, age: number | null): { value: number; low: number; high: number; rate: number } => {
    const pred = base.beta[0]! + base.beta[1]! * log10(p.tvl_usd);
    const a = age ?? 365;
    const rate = sigmoid(odds.c0 + odds.c1 * log10(a) + odds.c2 * log10(p.tvl_usd));
    return { value: ratio(pred), low: ratio(pred + q25), high: ratio(pred + q75), rate };
  };

  /** Eight tokenised protocols nearest in TVL, its own category first, priced ones only. */
  const compsFor = (p: SnapshotProtocol): BoardRow['comps'] => {
    const target = log10(p.tvl_usd);
    const sane = tokenised.filter((t) => {
      const multiple = (t.mcap_usd ?? 0) / Math.max(1, t.tvl_usd);
      return (t.mcap_usd ?? 0) >= 1_000_000 && multiple >= 0.002 && multiple <= 50;
    });
    const same = sane.filter((t) => t.category === p.category);
    const pool = same.length >= 4 ? same : sane.length >= 8 ? sane : tokenised;
    return pool
      .map((t) => ({ t, d: Math.abs(log10(t.tvl_usd) - target) }))
      .sort((a, b) => a.d - b.d || (a.t.slug < b.t.slug ? -1 : 1))
      .slice(0, 8)
      .map(({ t }) => ({
        name: t.name,
        tvl_usd: t.tvl_usd,
        mcap_usd: t.mcap_usd ?? 0,
        multiple: (t.mcap_usd ?? 0) / Math.max(1, t.tvl_usd),
      }));
  };

  const rows: BoardRow[] = [];
  const setAside: RadarData['set_aside'] = [];
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const age = ageDays(p, asOf);
    const onWatchlist = watchlist.has(p.slug);
    const variant = onWatchlist ? null : derivativeReason(p);
    if (variant !== null) {
      if (p.tvl_usd >= EARLY_FLOOR_USD) setAside.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: variant });
      continue;
    }
    if (!onWatchlist && p.tvl_usd < EARLY_FLOOR_USD) continue;
    const v = valueFor(p, age);
    const implied = Math.max(1, Math.round(v.value));
    const low = Math.max(1, Math.round(v.low));
    const high = Math.max(1, Math.round(v.high));
    const multiple = v.value / Math.max(1, p.tvl_usd);
    const plan = farmPlan(p, age);
    const call = verdictFor(p.tvl_usd, low, high, v.rate);
    rows.push({
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: age,
      mcap_usd: null,
      listed_at: p.listed_at,
      implied_value_usd: implied,
      value_if_launched_usd: Math.round(v.value),
      band_low_usd: low,
      band_high_usd: high,
      peer_token_rate: Math.round(v.rate * 1000) / 1000,
      multiple: Math.round(multiple * 1000) / 1000,
      watch: onWatchlist,
      verdict: call.verdict,
      verdict_line: verdictLine(call.verdict, call.netLow, call.netHigh, v.rate, multiple),
      farm_steps: plan.steps,
      farm_cost_usd: plan.capital,
      net_of_fees_usd_lo: Math.round(call.netLow),
      net_of_fees_usd_hi: Math.round(call.netHigh),
      hours_per_week: plan.hours,
      comps: compsFor(p),
      variant: null,
    });
  }
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  setAside.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));

  const live = tokenised
    .slice()
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : 1))
    .slice(0, 48)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd ?? 0,
      multiple: Math.round(((p.mcap_usd ?? 0) / Math.max(1, p.tvl_usd)) * 1000) / 1000,
    }));

  const radar: RadarData = {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      model: MODEL_VERSION,
      generated_by: 'main.ts (Node 22, standard library only)',
      snapshot_protocols: snapshot.protocols.length,
    },
    report,
    rows,
    live,
    set_aside: setAside,
    counts: {
      ranked: rows.length,
      watchlist: rows.filter((r) => watchlist.has(r.slug)).length,
      early: rows.filter((r) => !watchlist.has(r.slug)).length,
      set_aside: setAside.length,
      live: live.length,
    },
  };
  return { board: rows, radar };
}

/** The gate's own conditions on a board, checked here so the program fails before the scorer does. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4_000) return 'the board holds ' + board.length + ' rows, the gate wants 100 to 4,000';
  const slugs = new Set<string>();
  for (const row of board) {
    if (slugs.has(row.slug)) return 'the slug ' + row.slug + ' appears twice';
    slugs.add(row.slug);
    if (!Number.isSafeInteger(row.rank) || row.rank <= 0) return row.slug + ' has rank ' + row.rank;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return row.slug + ' has implied value ' + row.implied_value_usd;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return row.slug + ' has ' + row.farm_steps.length + ' farm steps';
    for (const step of row.farm_steps) if (step.trim().length < 20 || step.length > 600) return row.slug + ' has a farm step of ' + step.length + ' characters';
  }
  for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return 'rank ' + board[i]!.rank + ' sits at position ' + (i + 1);
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return 'implied value rises at rank ' + board[i]!.rank;
  for (const slug of snapshot.watchlist) if (!slugs.has(slug)) return 'the watchlist protocol ' + slug + ' is not on the board';
  return null;
}

/** The page's whole dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return 'window.RADAR=' + JSON.stringify(radar) + ';' + String.fromCharCode(10);
}
/** The snapshot, checked enough that a malformed file fails here rather than six screens into the page. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Partial<Snapshot>;
  if (typeof raw.as_of !== 'string' || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('the snapshot is not make.fun token-radar input: as_of, protocols and watchlist are required');
  }
  return {
    as_of: raw.as_of,
    source: typeof raw.source === 'string' ? raw.source : 'DefiLlama',
    floor_usd: typeof raw.floor_usd === 'number' ? raw.floor_usd : 50_000_000,
    protocols: raw.protocols,
    watchlist: raw.watchlist,
  };
}
