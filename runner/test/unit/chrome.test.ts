// Claude in Chrome per thread (docs/protocol.md, "Claude in Chrome"). The
// CLI only loads the claude-in-chrome tools when started with --chrome
// (claudeInChromeDefaultEnabled is for interactive sessions), so a thread
// asks for it with `chrome` on its record. Never in Auto or a sandbox: both
// read untrusted text, and Chrome has the user's logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import { RpcError } from '../../src/protocol.ts';
import type { ApprovalDecision, PermissionMode } from '../../src/protocol.ts';

function setup(callerMode: PermissionMode = 'full') {
  const root = fs.realpathSync(tmpDir());
  const box = path.join(root, 'sandboxed');
  const work = path.join(root, 'work');
  for (const d of [box, work]) fs.mkdirSync(d, { recursive: true });
  const h = makeHarness(tmpDir(), { sandbox: { folders: [box], image: 'threadbear-sandbox', docker: 'docker' } });
  const me = h.runner.create({ text: 'Me', accountId: 'claude-3', cwd: work, permissionMode: callerMode }).thread;
  h.adapter.last.init();
  const list = buildThreadbearTools(h.runner as never, me.id, () => h.clock.now(), undefined, undefined, undefined, { sleep: async () => {} });
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = list.find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };
  const cards = () => h.events(me.id).filter((e) => e.type === 'approval.requested');
  const withCard = async (decision: ApprovalDecision, name: string, args: Record<string, unknown>) => {
    const before = cards().length;
    const p = call(name, args);
    let card: any;
    for (let i = 0; i < 50 && !card; i++) {
      await tick();
      card = cards().length > before ? cards().at(-1) : undefined;
    }
    assert.ok(card, `a card for ${name} ${JSON.stringify(args)}`);
    h.runner.respondApproval({ threadId: me.id, approvalId: card.approvalId, decision });
    return { ...(await p), card };
  };
  const rec = (id: string) => h.store.loadAll().records.find((t) => t.id === id)!;
  const sessionsOf = (id: string) => h.adapter.sessions.filter((s) => s.opts.threadId === id);
  return { h, box, work, me, call, withCard, rec, sessionsOf };
}

// A message to an idle thread whose CLI went: the fresh one starts after a tick.
async function sendAndStart(s: ReturnType<typeof setup>, id: string, text: string) {
  const n = s.sessionsOf(id).length;
  s.h.runner.send(id, text);
  for (let i = 0; i < 50 && s.sessionsOf(id).length === n; i++) await tick();
  assert.equal(s.sessionsOf(id).length, n + 1, 'a fresh CLI');
}

test('threads.create: chrome goes on the record and the summary, and the CLI is started with it', () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'Check my inbox', accountId: 'claude-3', cwd: s.work, permissionMode: 'full', chrome: true }).thread;
  assert.equal(t.chrome, true);
  assert.deepEqual(checkSummary(t as never), [], 'a field docs/protocol.md has');
  assert.equal(s.rec(t.id).chrome, true);
  assert.equal(s.sessionsOf(t.id)[0].opts.chrome, true);
  const plain = s.h.runner.create({ text: 'No browser', accountId: 'claude-3', cwd: s.work, permissionMode: 'full' }).thread;
  assert.equal(plain.chrome, undefined);
  assert.equal(s.sessionsOf(plain.id)[0].opts.chrome, undefined);
});

test('threads.create: chrome is refused in Auto (named or the default) and in a sandbox folder, and makes no thread', () => {
  const s = setup();
  const before = s.h.runner.list().length;
  assert.throws(() => s.h.runner.create({ text: 'x', accountId: 'claude-3', cwd: s.work, permissionMode: 'auto', chrome: true }), /Auto/);
  assert.throws(() => s.h.runner.create({ text: 'x', accountId: 'claude-3', cwd: s.box, permissionMode: 'full', chrome: true }), /sandbox/);
  s.h.cfg.defaults.permissionMode = 'auto';
  assert.throws(() => s.h.runner.create({ text: 'x', accountId: 'claude-3', cwd: s.work, chrome: true }), /Auto/);
  assert.equal(s.h.runner.list().length, before);
});

test('threads.update: turning chrome on or off restarts the CLI once idle, and the next turn has it', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'Work', accountId: 'claude-3', cwd: s.work, permissionMode: 'full' }).thread;
  const first = s.sessionsOf(t.id)[0];
  first.init();
  first.result();
  assert.equal(s.h.runner.update({ threadId: t.id, chrome: true }).thread.chrome, true);
  assert.equal(first.ended, true, 'an idle CLI goes, so the flag takes');
  await sendAndStart(s, t.id, 'Now look in Chrome');
  const second = s.sessionsOf(t.id).at(-1)!;
  assert.notEqual(second, first);
  assert.equal(second.opts.chrome, true);
  assert.equal(second.opts.resume, true, 'the conversation carries on');
  second.init();
  second.result();
  assert.equal(s.h.runner.update({ threadId: t.id, chrome: false }).thread.chrome, undefined);
  assert.equal(s.rec(t.id).chrome, undefined);
  assert.equal(second.ended, true);
});

test('threads.update: chrome mid-turn waits for the turn, and says so', () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'Work', accountId: 'claude-3', cwd: s.work, permissionMode: 'full' }).thread;
  const first = s.sessionsOf(t.id)[0];
  first.init();
  s.h.runner.update({ threadId: t.id, chrome: true });
  assert.equal(first.ended, false, 'the turn runs on');
  assert.ok(s.h.events(t.id).some((e) => e.type === 'system.note' && /Chrome/.test((e as { text: string }).text)));
  first.result();
  assert.equal(first.ended, true);
});

test('threads.update: chrome is refused on an Auto or sandboxed thread; switching a Chrome thread to Auto restarts its CLI without it', async () => {
  const s = setup();
  const auto = s.h.runner.create({ text: 'x', accountId: 'claude-3', cwd: s.work, permissionMode: 'auto' }).thread;
  assert.throws(() => s.h.runner.update({ threadId: auto.id, chrome: true }), /Auto/);
  const boxed = s.h.runner.create({ text: 'x', accountId: 'claude-3', cwd: s.box, permissionMode: 'full' }).thread;
  assert.throws(() => s.h.runner.update({ threadId: boxed.id, chrome: true }), /sandbox/);
  // Turned on and to Auto in one call: refused too.
  const full = s.h.runner.create({ text: 'x', accountId: 'claude-3', cwd: s.work, permissionMode: 'full' }).thread;
  assert.throws(() => s.h.runner.update({ threadId: full.id, chrome: true, permissionMode: 'auto' }), /Auto/);
  assert.equal(s.rec(full.id).permissionMode, 'full', 'nothing in the refused call changed');

  const t = s.h.runner.create({ text: 'Chrome work', accountId: 'claude-3', cwd: s.work, permissionMode: 'full', chrome: true }).thread;
  const first = s.sessionsOf(t.id)[0];
  first.init();
  first.result();
  s.h.runner.update({ threadId: t.id, permissionMode: 'auto' });
  assert.equal(first.ended, true);
  assert.equal(s.rec(t.id).chrome, true, 'kept for when it leaves Auto');
  await sendAndStart(s, t.id, 'next');
  const second = s.sessionsOf(t.id).at(-1)!;
  assert.equal(second.opts.chrome, undefined, 'not passed in Auto');
  second.init();
  second.result();
  s.h.runner.update({ threadId: t.id, permissionMode: 'ask' });
  assert.equal(second.ended, true, 'out of Auto it comes back on the next CLI');
  await sendAndStart(s, t.id, 'again');
  assert.equal(s.sessionsOf(t.id).at(-1)!.opts.chrome, true);
});

test('caller gate: a thread off Full can neither start a Chrome thread nor turn Chrome on', () => {
  const s = setup('ask');
  const gate = new CallerGate({ runner: s.h.runner } as never);
  assert.throws(() => gate.check(s.me.id, 'threads.create', { text: 'x', chrome: true }), (e: unknown) => e instanceof RpcError && /Chrome/.test(e.message));
  assert.throws(() => gate.check(s.me.id, 'threads.update', { threadId: s.me.id, chrome: true }), RpcError);
  // Turning it off takes nothing.
  assert.doesNotThrow(() => gate.check(s.me.id, 'threads.update', { threadId: s.me.id, chrome: false }));
  const full = setup('full');
  const g2 = new CallerGate({ runner: full.h.runner } as never);
  assert.equal(g2.check(full.me.id, 'threads.create', { text: 'x', chrome: true }).chrome, true);
});

test('create_thread: chrome from a Full thread starts one with it; from Ask it asks on a card first', async () => {
  const s = setup('full');
  const r = await s.call('create_thread', { text: 'Look at my orders', permissionMode: 'full', chrome: true });
  assert.equal(r.error, false, r.text);
  const made = s.h.runner.list().find((t) => t.title === 'Look at my orders')!;
  assert.equal(made.chrome, true);
  const refused = await s.call('create_thread', { text: 'x', permissionMode: 'auto', chrome: true });
  assert.equal(refused.error, true);
  assert.match(refused.text, /Auto/);

  const a = setup('ask');
  const out = await a.withCard('allow', 'create_thread', { text: 'Ask chrome', chrome: true });
  assert.equal(out.error, false, out.text);
  assert.match(JSON.stringify(out.card), /Chrome/);
  assert.equal(a.h.runner.list().find((t) => t.title === 'Ask chrome')?.chrome, true);
});

test('update_thread: chrome turns on with a card from a thread off Full, and off without one', async () => {
  const s = setup('ask');
  const out = await s.withCard('allow', 'update_thread', { chrome: true });
  assert.equal(out.error, false, out.text);
  assert.equal(s.rec(s.me.id).chrome, true);
  const off = await s.call('update_thread', { chrome: false });
  assert.equal(off.error, false, off.text);
  assert.equal(s.rec(s.me.id).chrome, undefined);
});
