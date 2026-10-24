// One spend rule for Pi Sessions, durable Sessions, and Teams that mix them (reader-design.md "Cost").
//
//   rule: provider-reported cost (usage.cost.total) of the requests a Session issued itself
//   durable Session ── pi.usage doc ──► responses, failed attempts, compaction, tools   (authority)
//   Pi Session      ── assistant entries ──► responses                                (what the log holds)
//   Team            ── sum of members ──► covers only what every member covers; `mixed` says it differs
//
// Coverage travels with every figure, so a reader never compares two rules as one number. Inherited
// fork history is excluded by construction on the durable side: pi.usage is per conversation.
export const SPEND_RULE = 'provider-cost/1';
export const CLASSES = Object.freeze(['responses', 'failed', 'compaction', 'tools']);
const PI_COVERS = Object.freeze(['responses']);

const num = (x) => typeof x === 'number' && Number.isFinite(x) ? x : null;
const costOf = (u) => num(u?.cost?.total) ?? num(u?.cost);
const add = (a, b) => b === null ? a : (a ?? 0) + b;

/** Spend of one durable Session from its `pi.usage` document. `usd` stays null when no price was reported. */
export function durableSpend(usage) {
  if (!usage) return { rule: SPEND_RULE, usd: null, tokens: null, covers: [...CLASSES] };
  let usd = null, tokens = 0;
  for (const group of [usage.models, usage.tools]) for (const u of Object.values(group ?? {})) {
    usd = add(usd, costOf(u));
    tokens += num(u?.totalTokens) ?? (num(u?.input) ?? 0) + (num(u?.output) ?? 0) + (num(u?.cacheRead) ?? 0) + (num(u?.cacheWrite) ?? 0);
  }
  return { rule: SPEND_RULE, usd, tokens, covers: [...CLASSES] };
}

/**
 * Spend of one Pi Session from its own assistant entries (TranscriptEntry or Pi usage shape). The Pi
 * log keeps no compaction request and no failed attempt that Pi retried, so only responses are covered.
 */
export function piSpend(entries) {
  let usd = null, tokens = 0;
  for (const e of entries) {
    if (!e?.usage) continue;
    usd = add(usd, costOf(e.usage));
    tokens += (num(e.usage.input) ?? 0) + (num(e.usage.output) ?? 0) + (num(e.usage.cacheRead) ?? 0) + (num(e.usage.cacheWrite) ?? 0);
  }
  return { rule: SPEND_RULE, usd, tokens, covers: [...PI_COVERS] };
}

/** Spend of one Pi Session from a cost total already summed over its assistant entries (piSpend's rule). */
export const piSpendOfTotal = (usd) => ({ rule: SPEND_RULE, usd: num(usd), tokens: null, covers: [...PI_COVERS] });

/** A Team's spend: the members' sum, covering only the classes every member covers. */
export function teamSpend(members) {
  const covers = CLASSES.filter((c) => members.every((m) => m.covers.includes(c)));
  const mixed = members.some((m) => m.covers.length !== covers.length);
  let usd = null, tokens = 0;
  for (const m of members) { usd = add(usd, m.usd); tokens += m.tokens ?? 0; }
  return { rule: SPEND_RULE, usd, tokens, covers, ...(mixed ? { mixed: true } : {}) };
}

// The amount reads as AmPi's money() (web/src/util.ts), so a label that leaves nothing out equals it.
const money = (usd) => usd === 0 ? '$0' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;

/** The label a view shows beside a figure: the amount, and what it leaves out when it is not complete. */
export function spendLabel(spend) {
  const amount = spend.usd === null ? 'no price reported' : money(spend.usd);
  const missing = CLASSES.filter((c) => !spend.covers.includes(c));
  if (!missing.length) return amount;
  return `${amount} (${spend.mixed ? 'some members exclude' : 'excludes'} ${missing.join(', ')})`;
}
