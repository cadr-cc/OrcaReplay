import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, TraceWriter } from '@orcareplay/core';
import { INLINE_PAYLOAD_LIMIT, isBlobRef } from '@orcareplay/schema';
import { loadExchanges } from '../src/commands/replay.js';

/**
 * Regression guard for the bug that made replay useless against a real agent.
 *
 * The writer spills any payload over `INLINE_PAYLOAD_LIMIT` into a blob as `JSON.stringify(payload)`.
 * Every wire body is a *string*, so a spilled body lands in the blob as a JSON string literal —
 * quoted and backslash-escaped — while the identical body under the limit is stored as itself.
 * Replay read the blob bytes straight back, so it canonicalized an escaped copy: `model` came out
 * empty, `messages` came out `[]`, and every request in the recording fell to rung 4.
 *
 * It was invisible for months of tests because every fixture body was comfortably under 4 KB, and
 * catastrophic in practice because a real harness sends a system prompt and a tool catalogue on the
 * very first turn. Hence the size assertions: a test that stops crossing the spill boundary has
 * stopped testing the thing that broke.
 */
describe('replay across the inline/blob spill boundary', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-spill-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A request body shaped like a real one: a long system prompt is what pushes it over the limit. */
  function bigRequest(): string {
    return JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: `You are a coding agent. ${'Follow the repository conventions. '.repeat(200)}`,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the auth test' }] }],
    });
  }

  async function writeRun(rawRequest: string): Promise<string> {
    const writer = await TraceWriter.create(dir, {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      orcaVersion: '0.0.0',
    });
    await writer.append({
      type: 'model.request',
      actor: 'agent',
      turn: 1,
      attrs: { model: 'claude-opus-5', dialect: 'anthropic' },
      payload: rawRequest,
    });
    await writer.append({
      type: 'model.response',
      actor: 'model',
      turn: 1,
      attrs: { model: 'claude-opus-5', status: 200, streamed: false },
      payload: JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'done' }] }),
    });
    await writer.close(0);
    return writer.runDir;
  }

  it('canonicalizes a spilled request body identically to an inline one', async () => {
    const raw = bigRequest();
    expect(Buffer.byteLength(raw)).toBeGreaterThan(INLINE_PAYLOAD_LIMIT);

    const reader = await TraceReader.open(await writeRun(raw));
    const events = await reader.events();
    // The premise of the test: this body really did spill.
    expect(isBlobRef(events.find((e) => e.type === 'model.request')?.payload)).toBe(true);

    const [exchange] = await loadExchanges(reader);
    expect(exchange).toBeDefined();
    expect(exchange!.canonicalRequest.model).toBe('claude-opus-5');
    expect(exchange!.canonicalRequest.messages).toHaveLength(1);
  });

  it('hands the agent back the exact bytes that were recorded', async () => {
    const raw = bigRequest();
    const reader = await TraceReader.open(await writeRun(raw));
    const [exchange] = await loadExchanges(reader);
    // Not "parses to the same object" — the same bytes. Exact replay means exact.
    expect(exchange!.rawRequest).toBe(raw);
  });

  it('treats an inline body and a spilled body the same way', async () => {
    const small = JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(Buffer.byteLength(small)).toBeLessThan(INLINE_PAYLOAD_LIMIT);

    const inline = await loadExchanges(await TraceReader.open(await writeRun(small)));
    const spilled = await loadExchanges(await TraceReader.open(await writeRun(bigRequest())));

    // Same shape out of both paths: a model, a message list, and the raw bytes intact.
    for (const set of [inline, spilled]) {
      expect(set[0]!.canonicalRequest.model).toBe('claude-opus-5');
      expect(set[0]!.canonicalRequest.messages.length).toBeGreaterThan(0);
      expect(() => JSON.parse(set[0]!.rawRequest)).not.toThrow();
    }
  });
});

/**
 * A BODY THE SWEEP MUST NOT BREAK.
 *
 * The entropy sweep judged runs of `[A-Za-z0-9_-]`, and `n` — the second half of the JSON escape
 * `\n` — is one of them. A base62 `toolu_*` id sitting right after a newline was therefore matched
 * from the `n`, the `n` went into the placeholder with the rest of the id, and the lone `\` left
 * in front of it was not a legal JSON escape. The stored body stopped parsing and `orca replay`
 * died on it while *loading* the trace:
 *
 *   error replay.failed
 *     Bad escaped character in JSON at position 6907 (line 1 column 6908)
 *
 * `--loose` did not help: the exception was thrown while parsing the stored bodies, before any
 * matching happened. The recorder said nothing — it exits 0 and reports a healthy run — so the
 * damage surfaced at replay time, in another process, hours later.
 *
 * Any Claude Code session carrying the claude.ai tool set was likely to hit it: the request body
 * holds ~146 `mcp__claude_ai_*` tool names next to `toolu_*` ids, and base62 clears the sweep's
 * 4.0 bits/char threshold.
 */
describe('a request body the entropy sweep must not break', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-escape-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** An id under `id`, which the protocol exemption keeps — so it cannot be the one that broke. */
  const PROTOCOL_ID = 'toolu_01A9CkVfSMkVsjE7HB2nQrPz';
  /** The same shape of id, but in a position no exemption covers, right after a newline. */
  const SWEPT_ID = 'toolu_01AbCdEfGhIjKlMnOpQrStUvXy';

  function body(padding: string): string {
    const tools = Array.from(
      { length: 12 },
      (_, i) => `mcp__claude_ai_Gmail__apply_sensitive_message_label_${i}`,
    );
    return JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: `You are a coding agent. ${padding}`,
      tools,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: PROTOCOL_ID, name: 'Bash' }],
        },
      ],
      scratch: `\n${SWEPT_ID}\n${tools.join('\n')}`,
    });
  }

  async function writeRun(rawRequest: string): Promise<string> {
    const writer = await TraceWriter.create(dir, {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      orcaVersion: '0.0.0',
    });
    await writer.append({
      type: 'model.request',
      actor: 'agent',
      turn: 1,
      attrs: { model: 'claude-opus-5', dialect: 'anthropic' },
      payload: rawRequest,
    });
    await writer.append({
      type: 'model.response',
      actor: 'model',
      turn: 1,
      attrs: { model: 'claude-opus-5', status: 200, streamed: false },
      payload: JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'done' }] }),
    });
    await writer.close(0);
    return writer.runDir;
  }

  it('replays a body that spilled into a blob', async () => {
    const raw = body('Follow the repository conventions. '.repeat(200));
    expect(Buffer.byteLength(raw)).toBeGreaterThan(INLINE_PAYLOAD_LIMIT);

    const reader = await TraceReader.open(await writeRun(raw));
    // The premise: this body really did spill, so the blob holds the writer's escaped copy.
    const events = await reader.events();
    expect(isBlobRef(events.find((e) => e.type === 'model.request')?.payload)).toBe(true);

    const [exchange] = await loadExchanges(reader);
    expect(() => JSON.parse(exchange!.rawRequest)).not.toThrow();
    expect(exchange!.canonicalRequest.model).toBe('claude-opus-5');
  });

  it('replays a body that stayed inline', async () => {
    const raw = body('Follow the repository conventions.');
    expect(Buffer.byteLength(raw)).toBeLessThan(INLINE_PAYLOAD_LIMIT);

    const reader = await TraceReader.open(await writeRun(raw));
    const events = await reader.events();
    expect(isBlobRef(events.find((e) => e.type === 'model.request')?.payload)).toBe(false);

    const [exchange] = await loadExchanges(reader);
    expect(() => JSON.parse(exchange!.rawRequest)).not.toThrow();
    expect(exchange!.canonicalRequest.model).toBe('claude-opus-5');
  });

  it('keeps the id out of the body it did not protect', async () => {
    const raw = body('Follow the repository conventions. '.repeat(200));
    const [exchange] = await loadExchanges(await TraceReader.open(await writeRun(raw)));
    // The protocol id under `id` survives — the API demands its shape — and the one in the open
    // field does not.
    expect(exchange!.rawRequest).toContain(PROTOCOL_ID);
    expect(exchange!.rawRequest).not.toContain(SWEPT_ID);
  });
});
