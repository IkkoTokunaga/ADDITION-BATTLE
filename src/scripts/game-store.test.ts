import { describe, it, expect } from 'vitest';
// @ts-expect-error — game.js is plain JS with no type declarations
import { gameStore } from './game.js';

// The store mirrors the server-authoritative mode. These tests exercise the
// mode threading from the start screen (task 6.2) without any DOM/audio.
function freshStore() {
  const store: any = gameStore();
  store.audio = null; // skip all sound side effects
  return store;
}

describe('gameStore mode threading (task 6.2)', () => {
  it('startNewGame sends the chosen mode to /api/stages/start', async () => {
    const store = freshStore();
    const calls: any[] = [];
    store.api = async (path: string, body: any) => {
      calls.push({ path, body });
      return { stage: 1, oni_max_hp: 700, session_token: 't', questions: [], mode: body.mode };
    };

    await store.startNewGame(1, 'blank');

    expect(calls[0].path).toBe('/api/stages/start');
    expect(calls[0].body.mode).toBe('blank');
    expect(store.mode).toBe('blank');
  });

  it('normalizes an unknown mode to normal before sending', async () => {
    const store = freshStore();
    let sentMode: string | undefined;
    store.api = async (_path: string, body: any) => {
      sentMode = body.mode;
      return { stage: 1, oni_max_hp: 700, session_token: 't', questions: [], mode: body.mode };
    };

    await store.startNewGame(1, 'wat');

    expect(sentMode).toBe('normal');
    expect(store.mode).toBe('normal');
  });

  it('syncs mode from the server response (carry token decides the next stage)', async () => {
    const store = freshStore();
    store.mode = 'normal';
    // Server returns blank because the carry token said blank, overriding us.
    store.api = async () => ({
      stage: 3,
      oni_max_hp: 2100,
      session_token: 't',
      questions: [],
      mode: 'blank',
    });

    await store.loadStage(3, 'carry-token');

    expect(store.mode).toBe('blank');
  });

  it('goBackToTitle resets the mode to normal', () => {
    const store = freshStore();
    store.mode = 'blank';
    store.goBackToTitle();
    expect(store.mode).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// Gameplay blank-mode display & answer logic (tasks 7.2–7.5). Runs in node:
// `document` is undefined, so projectile effects call their onHit() synchronously.
// ---------------------------------------------------------------------------
describe('resolveQuestion (answer reconstruction, task 7.3/7.4)', () => {
  const store = freshStore();
  it('normal: expected is the sum, blank=0', () => {
    expect(store.resolveQuestion({ num1: 5, num2: 3 })).toEqual({
      num1: 5, num2: 3, blank: 0, expected: 8,
    });
  });
  it('blank=1: recovers the hidden first addend from sum - num2', () => {
    expect(store.resolveQuestion({ num2: 3, sum: 8, blank: 1 })).toEqual({
      num1: 5, num2: 3, blank: 1, expected: 5,
    });
  });
  it('blank=2: recovers the hidden second addend from sum - num1', () => {
    expect(store.resolveQuestion({ num1: 5, sum: 8, blank: 2 })).toEqual({
      num1: 5, num2: 3, blank: 2, expected: 3,
    });
  });
});

describe('question display getters never reveal the hidden value (task 7.2)', () => {
  it('blank=1 shows □ on the left, the addend on the right, and the sum', () => {
    const store = freshStore();
    store.currentQuestion = { num2: 3, sum: 8, blank: 1 };
    expect(store.qLeft).toBe('□');
    expect(store.qRight).toBe(3);
    expect(store.qShowSum).toBe(true);
    expect(store.qSum).toBe(8);
    // the hidden addend (5) appears in none of the rendered slots
    expect([store.qLeft, store.qRight, store.qSum]).not.toContain(5);
  });
  it('blank=2 shows □ on the right', () => {
    const store = freshStore();
    store.currentQuestion = { num1: 5, sum: 8, blank: 2 };
    expect(store.qLeft).toBe(5);
    expect(store.qRight).toBe('□');
    expect(store.qShowSum).toBe(true);
  });
  it('normal shows both addends and hides the sum slot', () => {
    const store = freshStore();
    store.currentQuestion = { num1: 5, num2: 3 };
    expect(store.qLeft).toBe(5);
    expect(store.qRight).toBe(3);
    expect(store.qShowSum).toBe(false);
  });
});

describe('submitAnswer is mode-aware (tasks 7.3–7.5)', () => {
  function answerable(q: any) {
    const store = freshStore();
    store.currentQuestion = q;
    store.questionQueue = [q, { num1: 1, num2: 1 }];
    store.questionIndex = 0;
    store.stage = 1;
    store.oniMaxHp = 700;
    store.oniHp = 700;
    store.totalDamage = 0;
    store.questionStartTime =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    return store;
  }

  it('blank=1: typing the hidden addend is correct and logs reconstructed num1/num2/blank', () => {
    const store = answerable({ num2: 3, sum: 8, blank: 1 });
    store.userInput = '5';
    store.submitAnswer();
    expect(store.answersLog[0]).toMatchObject({
      num1: 5, num2: 3, blank: 1, user_answer: 5, is_correct: true,
    });
  });

  it('blank=2: typing the hidden second addend is correct', () => {
    const store = answerable({ num1: 5, sum: 8, blank: 2 });
    store.userInput = '3';
    store.submitAnswer();
    expect(store.answersLog[0]).toMatchObject({
      num1: 5, num2: 3, blank: 2, is_correct: true,
    });
  });

  it('blank mode: typing the SUM is wrong (common mistake)', () => {
    const store = answerable({ num2: 3, sum: 8, blank: 1 });
    store.userInput = '8';
    store.submitAnswer();
    expect(store.answersLog[0].is_correct).toBe(false);
  });

  it('normal mode still judges against the sum, blank=0', () => {
    const store = answerable({ num1: 5, num2: 3 });
    store.userInput = '8';
    store.submitAnswer();
    expect(store.answersLog[0]).toMatchObject({ num1: 5, num2: 3, blank: 0, is_correct: true });
  });

  it('必殺技 gauge gain is identical across modes for the same numbers (task 7.5)', () => {
    const normal = answerable({ num1: 5, num2: 3 });
    normal.userInput = '8';
    normal.submitAnswer();

    const blank = answerable({ num2: 3, sum: 8, blank: 1 });
    blank.userInput = '5';
    blank.submitAnswer();

    expect(blank.specialGauge).toBe(normal.specialGauge);
    expect(normal.specialGauge).toBe(10 + ((5 + 3) % 16)); // 18
  });
});
