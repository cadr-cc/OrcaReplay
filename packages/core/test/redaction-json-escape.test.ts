import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/redaction.js';

/**
 * THE SWEEP MUST NOT BREAK THE DOCUMENT IT IS SWEEPING.
 *
 * The entropy sweep judges runs of `[A-Za-z0-9_-]`, and the character class holds `n` — the second
 * half of the JSON escape `\n`. The sweep runs over the *escaped* text, so a token sitting right
 * after a `\n` was matched from the `n`, the `n` went into the placeholder with the rest of the
 * token, and the lone `\` left in front of it is not a legal JSON escape. The stored body stopped
 * parsing, and `orca replay` died on it while *loading* the trace — before the proxy was even
 * started, which is why `--loose` did not help.
 *
 * The recorder said nothing: it exits 0 and reports a healthy run. The damage surfaced at replay
 * time, in a different process, hours later.
 */
describe('the entropy sweep leaves the JSON it is scanning intact', () => {
  /** A token shaped like an Anthropic tool_use id: base62, 32 chars, over 4.0 bits/char. */
  const TOKEN = 'toolu_01AbCdEfGhIjKlMnOpQrStUvXy';

  function fresh(): Redactor {
    return new Redactor({ salt: 'test-salt' });
  }

  function parses(s: string): boolean {
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  }

  it('keeps a body parseable when a flagged token follows a \\n escape', () => {
    const body = JSON.stringify({
      desc: `...\n${TOKEN}\nmcp__claude_ai_Gmail__apply_sensitive_message_label`,
    });
    const { value } = fresh().redactString(body);
    expect(parses(value)).toBe(true);
  });

  it('keeps a body parseable when a flagged token follows any escape', () => {
    // Real control characters, so the body carries the escape the JSON writer would have written.
    for (const control of ['\n', '\t', '\r', '\b', '\f']) {
      const body = JSON.stringify({ desc: `...${control}${TOKEN}...` });
      const { value } = fresh().redactString(body);
      expect(parses(value)).toBe(true);
    }
  });

  it('keeps a body parseable when a flagged token follows a \\u escape', () => {
    // The escape owns six characters — the backslash, the `u` and four hex digits — and those hex
    // digits are in the sweep's character class, so a run can start inside the escape and take its
    // middle with it. Written out, because `JSON.stringify` only emits `\uXXXX` for a lone
    // surrogate, and this is about the escape, not about how it got there.
    const body = `{"desc":"\\u0041${TOKEN}"}`;
    expect(parses(body)).toBe(true);
    const { value } = fresh().redactString(body);
    expect(parses(value)).toBe(true);
  });

  it('keeps a body parseable when a flagged token follows a \\u escape stored twice', () => {
    const body = `{"desc":"\\u0041${TOKEN}"}`;
    const stored = JSON.stringify({ payload: body });
    const { value } = fresh().redactString(stored);
    expect(parses(value)).toBe(true);
    expect(parses(JSON.parse(value).payload)).toBe(true);
  });

  it('keeps a body parseable when the body is stored inside an event, escaped twice', () => {
    // A body that crossed the inline-payload limit lives in a blob as the provider's wire format.
    // A small one stays in the event line, where it is a string inside a string.
    const body = JSON.stringify({ desc: `...\n${TOKEN}...` });
    const stored = JSON.stringify({ payload: body });
    const { value } = fresh().redactString(stored);
    expect(parses(value)).toBe(true);
    expect(parses(JSON.parse(value).payload)).toBe(true);
  });

  it('still redacts the token, wherever the escape put it', () => {
    const body = JSON.stringify({ desc: `...\n${TOKEN}...` });
    const { value, hits } = fresh().redactString(body);
    expect(value).not.toContain(TOKEN);
    expect(hits.map((h) => h.rule)).toContain('high_entropy');
  });

  it('redacts the token the same way in both representations of it', () => {
    // The same token, once in a body and once in that body stored inside an event. The two hold
    // the same content, so they have to hold the same placeholder — a reader comparing two traces
    // should not see a difference that was never in the recording.
    const body = JSON.stringify({ desc: `...\n${TOKEN}...` });
    const direct = fresh()
      .redactString(body)
      .hits.find((h) => h.rule === 'high_entropy');
    const nested = fresh()
      .redactString(JSON.stringify({ payload: body }))
      .hits.find((h) => h.rule === 'high_entropy');
    expect(direct?.placeholder).toBe(nested?.placeholder);
  });

  it('leaves the escape itself in the body, so the newline survives', () => {
    const body = JSON.stringify({ desc: `...\n${TOKEN}...` });
    const { value } = fresh().redactString(body);
    expect(JSON.parse(value).desc).toMatch(/^\.\.\.\n<secret:high_entropy:[0-9a-f]{8}>\.\.\.$/);
  });

  it('does not touch the array form, which never had the problem', () => {
    // The separator there is `","` — the quote is outside the sweep's character class, so the run
    // starts cleanly after it. This is the shape the issue reported as unaffected, pinned so the
    // fix cannot quietly change it.
    const body = JSON.stringify({ tools: [TOKEN, 'other'] });
    const { value } = fresh().redactString(body);
    expect(parses(value)).toBe(true);
    expect(value).not.toContain(TOKEN);
  });

  it('keeps a body parseable when many flagged tokens follow escapes', () => {
    const body = JSON.stringify({
      tools: Array.from({ length: 40 }, (_, i) => `${TOKEN}${i}`).join('\n'),
    });
    const { value } = fresh().redactString(body);
    expect(parses(value)).toBe(true);
  });
});
