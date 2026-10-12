#!/usr/bin/env node
// Public JSON/JSONL boundary. Harness semantics stay in sources.
import { parseArgs } from 'node:util';
import { readSessions, visibleSessions, searchTurns } from '../src/sources/sessions.mjs';
import { load, SOURCES } from '../src/sources/load.mjs';
import { READER_VERSION } from '../src/record.mjs';

const help = `Usage: sessions <sessions|entries ID|calls|search QUERY> [options]
  --since DATE|SPAN --until DATE|SPAN --harness pi|claude|codex|magpie
  SPAN: nonnegative integer Nm, Nh, Nd, Nw (now minus minutes, hours, days, weeks)
  --role solo|leader|worker|automated --all --text --id ID (sessions)
  --limit N (search, default 20) --format jsonl|json|table
Default Session visibility: solo/leader, non-scratch, with human turns.
Times are epoch milliseconds. Each record carries reader version ${READER_VERSION}.
Text requires --text, except search. Logs stay read-only.`;

function date(value, fallback, now) {
  if (value === undefined) return fallback;
  const span = /^(\d+)([mhdw])$/.exec(value);
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const n = span ? now - Number(span[1]) * units[span[2]] : Date.parse(value);
  if (!Number.isFinite(n) || Math.abs(n) > 8.64e15) throw new Error('Invalid date');
  return n;
}

const cell = value => value == null ? '-' : String(value).replace(/\s+/g, ' ');
const minute = t => t == null ? '-' : `${new Date(t).toISOString().slice(0, 16)}Z`;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function table(records, verb, text) {
  console.log(`reader ${READER_VERSION}`);
  const fields = verb === 'sessions' ? ['updated', 'id', 'role', 'turns', 'cwd', ...(text ? ['title'] : [])]
    : verb === 'search' ? ['time', 'session', 'kind', 'snippet'] : ['time', 'session', 'kind', 'id', 'name', ...(text ? ['text'] : [])];
  console.log(fields.join('\t'));
  for (const r of records) {
    const row = verb === 'sessions' ? [minute(r.updated), r.id, r.role, r.humanTurns, r.cwd, ...(text ? [r.title] : [])]
      : verb === 'search' ? [minute(r.t), r.session, r.kind, r.snippet]
        : [minute(r.t), verb === 'calls' ? `${r.source}:${r.session ?? '-'}` : r.session, r.kind, r.id, r.name, ...(text ? [r.text] : [])];
    console.log(row.map(cell).join('\t'));
    if (verb === 'sessions') {
      const argv = r.resume.argv.map(quote).join(' ');
      console.log(`  ${r.resume.cwd == null ? argv : `cd ${quote(r.resume.cwd)} && ${argv}`}`);
    }
  }
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
  const now = Date.now();
  const options = { sinceMs: date(v.since, -Infinity, now), untilMs: date(v.until, Infinity, now), harness: v.harness, role: v.role, all: v.all,
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
  else table(records, verb, v.text);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
