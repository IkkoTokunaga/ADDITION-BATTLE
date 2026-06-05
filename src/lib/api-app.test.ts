import { describe, it, expect } from 'vitest';
import { app } from './api-app';
import { encrypt, decrypt } from '../utils/crypto';
import type { PlayToken, CarryToken } from './game-logic';

// Integration tests for the mode threading through the real Hono handlers
// (spec: ゲームモードの選択 / 計算問題の自動生成…) — task 5.6.
// These hit /stages/start and /stages/more only, which never touch the DB.

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/stages/start (mode)', () => {
  it('starts a blank game: response + token + payload all reflect blank mode', async () => {
    const res = await post('/api/stages/start', { mode: 'blank' });
    const json: any = await res.json();

    expect(json.mode).toBe('blank');
    // every public question is blank-shaped and never leaks the hidden addend
    for (const q of json.questions) {
      expect([1, 2]).toContain(q.blank);
      expect(q).toHaveProperty('sum');
      const hiddenKey = q.blank === 1 ? 'num1' : 'num2';
      expect(q).not.toHaveProperty(hiddenKey);
      expect(q).not.toHaveProperty('answer');
    }
    // the server-issued token records the mode
    const token = decrypt<PlayToken>(json.session_token);
    expect(token?.mode).toBe('blank');
  });

  it('defaults to normal when no mode is given', async () => {
    const res = await post('/api/stages/start', {});
    const json: any = await res.json();
    expect(json.mode).toBe('normal');
    for (const q of json.questions) {
      expect(q).toHaveProperty('num1');
      expect(q).toHaveProperty('num2');
      expect(q).not.toHaveProperty('sum');
    }
  });

  it('falls back to normal for a garbage mode', async () => {
    const res = await post('/api/stages/start', { mode: 'h4x' });
    const json: any = await res.json();
    expect(json.mode).toBe('normal');
  });

  it('carry token mode wins over a conflicting client-claimed mode', async () => {
    const carry: CarryToken = { carriedScore: 300, nextStage: 3, mode: 'blank' };
    const res = await post('/api/stages/start', {
      mode: 'normal', // client claims normal…
      carry_token: encrypt(carry), // …but the server-issued carry says blank
    });
    const json: any = await res.json();
    expect(json.mode).toBe('blank');
    expect(json.stage).toBe(3);
  });
});

describe('POST /api/stages/more (mode)', () => {
  it('preserves blank mode across the prefetch batch', async () => {
    const start: any = await (await post('/api/stages/start', { mode: 'blank' })).json();
    const more: any = await (
      await post('/api/stages/more', { session_token: start.session_token })
    ).json();

    for (const q of more.questions) {
      expect([1, 2]).toContain(q.blank);
    }
    const merged = decrypt<PlayToken>(more.session_token);
    expect(merged?.mode).toBe('blank');
    // questions accumulate (initial 5 + 5 more)
    expect(merged?.questions.length).toBe(10);
  });
});
