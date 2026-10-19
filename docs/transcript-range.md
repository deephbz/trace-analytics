# Bounded Pi transcript ranges

Status: bounded reader API used by the AmPi integration. The reader owns decoding and ancestry. Consumers own view
selection and copy retention. The full `openPiSession` contract stays unchanged.
This prototype requires Node with `node:sqlite` support.

```text
native complete lines -> shared observe / transcriptEntry
                      -> SQLite nodes: parent + byte offset + length + preview
                      -> SQLite active branch: ordered entry references
range request         -> at most 400 previews
full entry request    -> one exact byte range in native source
```

`openPiSessionRange(path, { host, indexPath, previewChars: 2048 })` returns:

- `refresh({ force: false })`: ingest complete appended lines, or rebuild on
  shrink, inode change, changed same-size file, or prefix-sample mismatch.
  Await it before reading changes. A failed scan rolls back its transaction.
- `page({ before, limit: 400, version })`: active-branch entries in forward
  order, `more`, source `version`, and complete/partial branch status.
  `before` is an entry ID on the current branch. Stale versions fail explicitly.
- `entry(id, { full: false, version })`: preview, or one full normalized entry
  read by offset. Full reads are caller-requested and outside the preview
  memory bound. References keep the configured Host.
- `visit(visitor, { after })`: stream active-branch native records and normalized
  entries in order. The callback receives `{ native, entry, position, offset,
  length }`. Only one source record is decoded at a time. `after` must name a
  current-branch entry. Consumers must not accumulate source bodies.
- `entryBytes(id, { offset: 0, limit: 65536 })`: one native JSON byte page.
  Returns `text`, `next`, `more`, and `format: "native-json"`. The limit is at
  most 64 KiB. `next` avoids split UTF-8 characters. Use that exact cursor.
- `session()`: compact identity, activity, cwd, title, tip, and fork-header metadata.
  This is not the full catalog SESSION record.
- `info()`: committed bytes, version, branch count, invalid-line count, and
  sampled peak JavaScript heap bytes. `close()` releases SQLite resources.

The preview budget applies across text blocks of each entry. Tool arguments
stay on disk. A preview holds at most 32 blocks and discloses truncation.
SQLite retains the previews so opening a page does not decode large tool bodies.
Its page cache is 1 MiB, mmap is disabled, and temporary tables stay on disk.
No full node map, branch array, or body cache stays in JavaScript.

Parent links remain on disk after an entry leaves the newest-400 window.
Branch reconstruction walks these links and uses a disk uniqueness constraint
to detect cycles. Missing parents and cycles remain partial branches. Imported
fork and compaction entries keep their native parent links. They do not truncate
history.

The private index stores the Host, source path, schema and preview budgets,
complete-line byte length, and a chained SHA-256 over complete line bytes.
The chain starts at SHA-256 of the empty string. Each step hashes the previous
hex digest followed by the next line, including its newline. This content key
is independent of read-chunk boundaries. Reset generations guard replacement;
source versions use schema, digest, and complete-line length.

Warm range reads validate the committed prefix's length and head/tail samples.
They do not hash a whole source file on navigation. `refresh()` also checks
inode, size, and mtime. An in-place rewrite beyond the samples that preserves
metadata is outside the append-only contract; call `refresh({ force: true })`.
These samples are a trust rule for an owned copy, not proof of arbitrary-file
integrity. Copy ingestion must declare resets. Missing or stale source bytes
fail the read instead of using an unrelated Host or path.

## Checks

`node --test test/transcript-range.test.mjs test/transcript.test.mjs` checks
branch parity against both `activeBranch()` and the full reader. Cases include
an appended parent outside the tail, reset, same-length replacement, imported
fork, compaction, missing/cyclic ancestry, restart, partial lines, Host identity,
full-body recovery after preview truncation, streamed suffix visits, warm titles,
and UTF-8 byte-page reconstruction.

`mirrorEntryText(native)` in `transcript.mjs` owns in-Session search extraction.
It follows Session Mirror: user/reply text, thinking, tool name and arguments,
tool output, bash command and output, custom messages, and summaries. It omits
images and non-text metadata. Fleet prose selection remains a consumer policy.

Use a private source and private index for measurements:

```sh
node bin/bench-transcript-range.mjs build "$SOURCE" "$INDEX"
node bin/bench-transcript-range.mjs parity "$SOURCE" "$INDEX"
node bin/bench-transcript-range.mjs open "$SOURCE" "$INDEX"
```

Each command runs in a separate process. Build reports ingestion time and
sampled heap peak. Parity runs an independent full-node oracle outside the
reader memory measurement. Open includes constructor, index metadata, prefix
validation, and the newest-400 page. It excludes Node startup and prior index
construction. Output contains numbers only. The 20 MB heap and 50 ms cold-open
gates apply to this reader experiment; they do not prove a GUI RSS or paint
budget. Heap sampling occurs after each decoded entry and read chunk. It does
not measure SQLite/native allocations or prove a bound for arbitrary giant
JSON lines.

For a cold-page check on macOS, build on a private copy. Compile
`bin/cold-copy-darwin.c` with a compatible macOS SDK. Use that helper to create
fresh uncached copies of both the private source and its completed index.
Rename each replacement over its old private path after all readers close.
The helper uses `F_NOCACHE` for writes and checks every page with `mincore`.
It fails unless both files have zero resident pages. Run one fresh `open`
process immediately after that check. Repeat the uncached copy for each trial.
Do not use a global cache purge or modify the original Session. The OS may
still cache directory metadata, libraries, and executable pages.

## Integration limits

The scan is bounded by one native JSON line, not a fixed byte ceiling.
Oversized lines require a separate ingestion policy. The SQLite transaction
spans one refresh, so no reads through the same reader run during that refresh.
Each reader has one connection per index; fleet integrations must bound
connections and schedule scan work away from latency-sensitive rendering.
It does not implement full SESSION aggregates, Rarebit selection, FTS, or
consumer-specific materializations. Those remain separate integration work.
