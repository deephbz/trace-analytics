// Builds a small pi-durable 1.4.0 store with pi-ai's faux provider (no network, no credentials).
// Only tests open it. It is a dev-only fixture: the durable source itself never imports pi-durable.
//
//   root:  user → assistant(tool call) → tool-result → assistant · custom input · custom write
//          · compaction · reset · user → assistant
//   fork:  forked at the first answer; its own user → assistant
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const MODEL = { provider: 'fixture-sim', modelId: 'sim-1' };

function respond({ messages, systemPrompt }) {
  if (/summar/i.test(systemPrompt ?? '') || /summar/i.test(JSON.stringify(messages.at(-1)?.content ?? '')))
    return fauxAssistantMessage([fauxText('## Goal\n- fixture summary')], { stopReason: 'stop' });
  const last = messages.at(-1);
  const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((p) => p.text ?? '').join('');
  if (last?.role === 'user' && text.includes('use echo')) return fauxAssistantMessage([fauxToolCall('echo', { say: 'hi' })], { stopReason: 'toolUse' });
  if (last?.role === 'toolResult') return fauxAssistantMessage([fauxText('echo said hi')], { stopReason: 'stop' });
  return fauxAssistantMessage([fauxText(`answer to: ${text}`)], { stopReason: 'stop' });
}

/** Open (or reopen) a store at `path`. The caller closes the returned harness. */
export async function openFixtureStore(path) {
  const faux = fauxProvider({ provider: MODEL.provider, api: 'fixture-sim', tokensPerSecond: 1e6,
    models: [{ id: MODEL.modelId, name: 'Fixture sim', reasoning: false, input: ['text'], contextWindow: 64_000, maxTokens: 4_000 }] });
  const step = (ctx) => { faux.appendResponses([step]); return respond(ctx); };
  faux.setResponses(Array.from({ length: 64 }, () => step));
  const models = createModels();
  models.setProvider(faux.provider);
  // A rerun returns the same output, so a crash mid-call may replay it.
  const echo = defineTool({ name: 'echo', description: 'Echo a word', parameters: Type.Object({ say: Type.String() }), replay: 'safe',
    execute: async (args) => ({ output: [{ type: 'text', text: `echo: ${args.say}` }] }) });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'fixture', tools: [echo] }));
  const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry, settings: { compaction: { keepRecentTokens: 1 } } }, context);
  const root = await harness.root(context, { agent: { model: MODEL } });
  return { harness, root };
}

export async function ask(conversation, content, extra = {}) {
  const s = await conversation.submit({ type: 'input', content, ...extra }, context);
  const settled = await s.wait(context);
  if (settled.status !== 'done') throw new Error(`fixture input ${settled.status}: ${JSON.stringify(settled)}`);
  return settled;
}

/** Build the fixture conversations. Returns the root, the fork, and the fork cutoff entry. */
export async function buildFixture(harness, root) {
  const first = await ask(root, 'use echo please');
  const cutoff = first.answer;
  await ask(root, 'ann: check the build', { entry: { kind: 'fixture.mention', data: { author: 'ann', text: 'check the build' } } });
  const write = await root.submit({ type: 'write', entry: { kind: 'fixture.note', data: { note: 'opened a file' } } }, context);
  await write.wait(context);
  const task = await root.compact('keep names', context);
  const { outcome } = (await harness.waitForTask(task, context)).state;
  if (outcome.status !== 'completed') throw new Error(`fixture compaction ${outcome.status}`);
  if (outcome.result.submissionId !== undefined) await (await harness.submission(outcome.result.submissionId, context)).wait(context);
  await root.reset('We were testing the reader. Continue.', context);
  await root.waitForIdle(context);
  await ask(root, 'after reset');
  const fork = await root.fork(cutoff, { ownership: { kind: 'ownerless' } }, context);
  await ask(fork, 'fork question');
  return { fork, cutoff, answer: (id) => root.commit((tx) => tx.entry(AssistantEntry, id), context) };
}
