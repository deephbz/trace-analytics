#!/usr/bin/env node
// Public JSON/JSONL boundary. Harness semantics stay in sources.
import { parseArgs } from 'node:util';
import { readSessions, visibleSessions, searchTurns } from '../src/sources/sessions.mjs';
import { load, SOURCES } from '../src/sources/load.mjs';
import { READER_VERSION } from '../src/record.mjs';

const help = `Usage: sessions <sessions|entries ID|calls|search QUERY> [options]
  --since DATE --until DATE --harness pi|claude|codex|magpie
  --role solo|leader|worker|automated --all --text --id ID (sessions)
  --limit N (search, default 20) --format jsonl|json|table
Default Session visibility: solo/leader, non-scratch, with human turns.
Times are epoch milliseconds. Each record carries reader version ${READER_VERSION}.
Text requires --text, except search. Logs stay read-only.`;

function date(value, fallback) {
  if (value === undefined) return fallback;
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error('Invalid date');
  return n;
}

try {
  const { values: v, positionals: p } = parseArgs({ allowPositionals: true, options: {
    id: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, harness: { type: 'string' }, role: { type: 'string' },
    all: { type: 'boolean' }, text: { type: 'boolean' }, limit: { type: 'string' }, format: { type: 'string', default: 'jsonl' }, help: { type: 'boolean' },
  } });
  if (v.help) { console.log(help); process.exit(0); }
  const [verb, arg, ...extra] = p;
  if (!['sessions', 'entries', 'calls', 'search'].includes(verb)) throw new Error(help);
  if (extra.length || (['sessions', 'calls'].includes(verb) && arg) || (['entries', 'search'].includes(verb) && !arg)) throw new Error(help);
  if (!['jsonl', 'json', 'table'].includes(v.format)) throw new Error('Unknown format');
  if (v.id && verb !== 'sessions') throw new Error('--id is only valid for sessions');
  if (v.harness && !Object.hasOwn(SOURCES, v.harness)) throw new Error('Unknown harness');
  if (v.role && !['solo', 'leader', 'worker', 'automated'].includes(v.role)) throw new Error('Unknown role');
  const options = { sinceMs: date(v.since, -Infinity), untilMs: date(v.until, Infinity), harness: v.harness, role: v.role, all: v.all,
    limit: v.limit === undefined ? 20 : Number(v.limit) };
  if (!(options.sinceMs < options.untilMs) || !Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('Invalid window or limit');
  let records;
  if (verb === 'calls') {
    const data = await load({ sinceMs: options.sinceMs, untilMs: options.untilMs,
      ...(v.harness ? { use: [v.harness] } : {}) });
    records = [...data.calls, ...data.compactions, ...data.tools].filter(r => r.t >= options.sinceMs && r.t < options.untilMs)
      .sort((a, b) => a.t - b.t).map(r => ({ reader: READER_VERSION, ...r }));
  } else {
    const catalog = await readSessions({ text: verb === 'entries' ? false : Boolean(v.text || verb === 'search') });
    console.error(JSON.stringify({ reader: READER_VERSION, coverage: catalog.coverage }));
    function resolveId(key) {
      const matches = catalog.sessions.filter(s => s.id === key || s.session === key || s.id.startsWith(key));
      if (matches.length === 1) return matches[0].id;
      const error = new Error(JSON.stringify({ error: matches.length ? 'Ambiguous id' : 'Unknown id', candidates: (matches.length ? matches : catalog.sessions).map(s => s.id) }));
      error.exitCode = 2;
      throw error;
    }
    if (verb === 'sessions') {
      const id = v.id ? resolveId(v.id) : null;
      records = id ? catalog.sessions.filter(s => s.id === id) : visibleSessions(catalog.sessions, options);
    }
    else if (verb === 'search') records = searchTurns(catalog, arg, options);
    else {
      const id = resolveId(arg);
      if (v.text) {
        const selected = catalog.sessions.find(s => s.id === id);
        const full = await readSessions({ text: 'full', paths: [selected.path], useCache: false });
        records = full.entries.get(id);
      } else records = catalog.entries.get(id);
    }
  }
  if (v.format === 'json') console.log(JSON.stringify(records));
  else if (v.format === 'jsonl') for (const r of records) console.log(JSON.stringify(r));
  else {
    console.log(`reader ${READER_VERSION}`);
    if (records.length) {
      const fields = Object.keys(records[0]);
      console.log(fields.join('\t'));
      for (const r of records) console.log(fields.map(k => JSON.stringify(r[k]) ?? '').join('\t'));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
