import { describe, it, expect } from 'vitest';
import {
  genQuestion,
  genBatch,
  publicQuestions,
  verifyAndScore,
  normalizeMode,
  type PlayToken,
  type CarryToken,
  type Question,
} from './game-logic';
import { encrypt, decrypt } from '../utils/crypto';

// ---------------------------------------------------------------------------
// Regression: lock in the existing (normal-mode) behavior before adding the
// blank mode. These MUST stay green throughout the change.
// ---------------------------------------------------------------------------
describe('genQuestion (normal mode, regression)', () => {
  it('answer always equals num1 + num2 for every stage', () => {
    for (let stage = 1; stage <= 12; stage++) {
      for (let i = 0; i < 200; i++) {
        const q = genQuestion(stage);
        expect(q.answer).toBe(q.num1 + q.num2);
      }
    }
  });

  it('no-carry stages (3,5,7,9) never carry between columns', () => {
    for (const stage of [3, 5, 7, 9]) {
      for (let i = 0; i < 200; i++) {
        const { num1, num2 } = genQuestion(stage);
        let a = num1;
        let b = num2;
        while (a > 0 || b > 0) {
          expect((a % 10) + (b % 10)).toBeLessThanOrEqual(9);
          a = Math.floor(a / 10);
          b = Math.floor(b / 10);
        }
      }
    }
  });
});

describe('publicQuestions (regression)', () => {
  it('strips the answer from the payload sent to the client', () => {
    const pub = publicQuestions(genBatch(2));
    for (const q of pub) {
      expect(q).not.toHaveProperty('answer');
      expect(q).toHaveProperty('num1');
      expect(q).toHaveProperty('num2');
    }
  });
});

describe('verifyAndScore (regression)', () => {
  const token: PlayToken = {
    stage: 1,
    questions: [{ num1: 2, num2: 3, answer: 5, blank: 0 }],
    carriedScore: 0,
  };

  it('scores a correct answer with the deterministic formula', () => {
    const r = verifyAndScore(
      token,
      [{ num1: 2, num2: 3, user_answer: 5, time_taken: 10 }],
      true
    );
    expect(r.verified).toBe(true);
    expect(r.stageScore).toBe(100); // stage*100, no time bonus at t=10
    expect(r.terminal).toBe(true);
    expect(r.reachedStage).toBe(1);
  });

  it('rejects an answer referencing a question the server never generated', () => {
    const r = verifyAndScore(
      token,
      [{ num1: 9, num2: 9, user_answer: 18, time_taken: 10 }],
      true
    );
    expect(r.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token type carries the mode, survives encryption, and normalizes safely
// (spec: ゲームモードの選択 / 計算問題の自動生成…) — tasks 3.1–3.3
// ---------------------------------------------------------------------------
describe('mode persistence through the session token', () => {
  it('round-trips PlayToken.mode through encrypt → decrypt', () => {
    const token: PlayToken = {
      stage: 3,
      carriedScore: 120,
      mode: 'blank',
      questions: [{ num1: 5, num2: 3, answer: 8, blank: 1 }],
    };
    const back = decrypt<PlayToken>(encrypt(token));
    expect(back?.mode).toBe('blank');
  });

  it('round-trips CarryToken.mode (carry between stages)', () => {
    const carry: CarryToken = { carriedScore: 500, nextStage: 4, mode: 'blank' };
    const back = decrypt<CarryToken>(encrypt(carry));
    expect(back?.mode).toBe('blank');
    expect(back?.nextStage).toBe(4);
  });

  it('normalizes a legacy token with no mode to "normal"', () => {
    const legacy = { stage: 1, carriedScore: 0, questions: [] }; // pre-blank token
    const back = decrypt<PlayToken>(encrypt(legacy));
    expect(normalizeMode(back?.mode)).toBe('normal');
  });

  it('normalizes a garbage mode value to "normal"', () => {
    const tampered = { stage: 1, carriedScore: 0, questions: [], mode: 'h4x' };
    const back = decrypt<PlayToken>(encrypt(tampered));
    expect(normalizeMode(back?.mode)).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// Answer judging & session verification (spec: 回答判定とダメージ処理・セッション
// 検証) — tasks 2.1–2.5
// ---------------------------------------------------------------------------
type Triple = [num1: number, num2: number, blank: 0 | 1 | 2];

const correctAnswer = (num1: number, num2: number, blank: 0 | 1 | 2) =>
  blank === 1 ? num1 : blank === 2 ? num2 : num1 + num2;

const buildToken = (stage: number, qs: Triple[]): PlayToken => ({
  stage,
  carriedScore: 0,
  questions: qs.map(([num1, num2, blank]) => ({
    num1,
    num2,
    answer: num1 + num2,
    blank,
  })),
});

const correctAnswersFor = (qs: Triple[], t = 10) =>
  qs.map(([num1, num2, blank]) => ({
    num1,
    num2,
    blank,
    user_answer: correctAnswer(num1, num2, blank),
    time_taken: t,
  }));

describe('verifyAndScore (blank mode)', () => {
  it('judges correctness against the hidden term, not the sum', () => {
    // blank=1 → the hidden term is num1 (=5)
    const t1 = buildToken(2, [[5, 3, 1]]);
    const judge = (a: number) =>
      verifyAndScore(
        t1,
        [{ num1: 5, num2: 3, blank: 1, user_answer: a, time_taken: 10 }],
        true
      ).verifiedLogs[0].is_correct;
    expect(judge(5)).toBe(true); // the hidden addend
    expect(judge(8)).toBe(false); // the sum is NOT the answer in blank mode
    expect(judge(3)).toBe(false); // the visible addend

    // blank=2 → the hidden term is num2 (=3)
    const t2 = buildToken(2, [[5, 3, 2]]);
    const judge2 = (a: number) =>
      verifyAndScore(
        t2,
        [{ num1: 5, num2: 3, blank: 2, user_answer: a, time_taken: 10 }],
        true
      ).verifiedLogs[0].is_correct;
    expect(judge2(3)).toBe(true);
    expect(judge2(5)).toBe(false);
  });

  it('accepts only the exact (num1,num2,□) triple the server generated', () => {
    const token = buildToken(2, [[5, 3, 1]]);
    const ok = verifyAndScore(token, correctAnswersFor([[5, 3, 1]]), true);
    expect(ok.verified).toBe(true);
  });

  it('rejects a swapped □ position as tampering', () => {
    const token = buildToken(2, [[5, 3, 1]]); // pool only has 5_3_1
    const r = verifyAndScore(
      token,
      [{ num1: 5, num2: 3, blank: 2, user_answer: 3, time_taken: 10 }],
      true
    );
    expect(r.verified).toBe(false);
  });

  it('rejects downgrading a blank question to normal (blank=0) for sum scoring', () => {
    const token = buildToken(2, [[5, 3, 1]]);
    const r = verifyAndScore(
      token,
      [{ num1: 5, num2: 3, blank: 0, user_answer: 8, time_taken: 10 }],
      true
    );
    expect(r.verified).toBe(false);
  });

  it('rejects numbers that were never generated', () => {
    const token = buildToken(2, [[5, 3, 1]]);
    const r = verifyAndScore(
      token,
      [{ num1: 9, num2: 9, blank: 1, user_answer: 9, time_taken: 10 }],
      true
    );
    expect(r.verified).toBe(false);
  });

  it('produces an identical score to normal mode for the same numbers/time/stage', () => {
    // Same (num1,num2) pairs, same stage & time; only the mode differs.
    // This pins score/time-bonus/必殺技ゲージ(+multiplier) parity across modes.
    const pairs: [number, number][] = [
      [5, 3], [12, 4], [7, 9], [2, 2], [8, 8], [6, 1], [9, 3],
    ];
    const normalQs = pairs.map(([a, b]) => [a, b, 0] as Triple);
    const blankQs = pairs.map(([a, b], i) => [a, b, (i % 2 ? 2 : 1)] as Triple);

    const rn = verifyAndScore(buildToken(4, normalQs), correctAnswersFor(normalQs), true);
    const rb = verifyAndScore(buildToken(4, blankQs), correctAnswersFor(blankQs), true);

    expect(rn.verified).toBe(true);
    expect(rb.verified).toBe(true);
    expect(rb.stageScore).toBe(rn.stageScore);
    expect(rb.finalCumulative).toBe(rn.finalCumulative);
    expect(rb.stageScore).toBeGreaterThan(0);
  });

  it('time bonus is identical across modes (t<10 path)', () => {
    const rn = verifyAndScore(buildToken(5, [[5, 3, 0]]), correctAnswersFor([[5, 3, 0]], 2), true);
    const rb = verifyAndScore(buildToken(5, [[5, 3, 1]]), correctAnswersFor([[5, 3, 1]], 2), true);
    expect(rb.stageScore).toBe(rn.stageScore);
  });

  it('backward compat: a legacy token/answer without blank scores as normal', () => {
    const legacy: PlayToken = {
      stage: 1,
      carriedScore: 0,
      questions: [{ num1: 2, num2: 3, answer: 5 } as any], // no blank field
    };
    const r = verifyAndScore(
      legacy,
      [{ num1: 2, num2: 3, user_answer: 5, time_taken: 10 }], // no blank field
      true
    );
    expect(r.verified).toBe(true);
    expect(r.verifiedLogs[0].is_correct).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Blank mode generation (spec: 虫食い算問題の生成と表示) — tasks 1.1 / 1.2
// ---------------------------------------------------------------------------
describe('genQuestion (blank mode)', () => {
  it('hides exactly one addend (blank ∈ {1,2}), never the sum', () => {
    for (let i = 0; i < 200; i++) {
      const q = genQuestion(2, 'blank');
      expect([1, 2]).toContain(q.blank);
      expect(q.answer).toBe(q.num1 + q.num2); // sum is never hidden / always consistent
    }
  });

  it('over many draws both □ positions actually occur (not stuck on one)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(genQuestion(3, 'blank').blank);
    expect(seen).toEqual(new Set([1, 2]));
  });

  it('the hidden addend is recoverable from the visible term and sum', () => {
    for (let i = 0; i < 200; i++) {
      const q = genQuestion(6, 'blank');
      const hidden = q.blank === 1 ? q.num1 : q.num2;
      const visible = q.blank === 1 ? q.num2 : q.num1;
      expect(q.answer - visible).toBe(hidden);
    }
  });

  it('addends stay ≥ 1, so a blank is never just "□ = sum" (hidden 0)', () => {
    for (let stage = 1; stage <= 12; stage++) {
      for (let i = 0; i < 100; i++) {
        const q = genQuestion(stage, 'blank');
        expect(q.num1).toBeGreaterThanOrEqual(1);
        expect(q.num2).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('normal mode (and unknown/garbage mode) never sets a blank', () => {
    expect(genQuestion(2).blank).toBe(0);
    expect(genQuestion(2, 'normal').blank).toBe(0);
    expect(genQuestion(2, 'wat' as any).blank).toBe(0); // graceful fallback
    expect(normalizeMode('wat')).toBe('normal');
    expect(normalizeMode(undefined)).toBe('normal');
    expect(normalizeMode('blank')).toBe('blank');
  });
});

// ---------------------------------------------------------------------------
// Public payload must never leak the hidden value (spec: 隠した数を含まない公開
// ペイロード) — tasks 1.3 / 1.4
// ---------------------------------------------------------------------------
describe('publicQuestions (blank mode)', () => {
  const make = (num1: number, num2: number, blank: 0 | 1 | 2): Question => ({
    num1,
    num2,
    answer: num1 + num2,
    blank,
  });

  it('blank=1 sends {num2, sum, blank} and omits the hidden first addend', () => {
    const [p] = publicQuestions([make(5, 3, 1)]) as any[];
    expect(p).toEqual({ num2: 3, sum: 8, blank: 1 });
    expect(p).not.toHaveProperty('num1'); // hidden term absent
    expect(p).not.toHaveProperty('answer');
  });

  it('blank=2 sends {num1, sum, blank} and omits the hidden second addend', () => {
    const [p] = publicQuestions([make(5, 3, 2)]) as any[];
    expect(p).toEqual({ num1: 5, sum: 8, blank: 2 });
    expect(p).not.toHaveProperty('num2');
    expect(p).not.toHaveProperty('answer');
  });

  it('blank=0 (normal) sends only the two addends — no sum, no blank', () => {
    const [p] = publicQuestions([make(5, 3, 0)]) as any[];
    expect(p).toEqual({ num1: 5, num2: 3 });
    expect(p).not.toHaveProperty('sum');
    expect(p).not.toHaveProperty('blank');
    expect(p).not.toHaveProperty('answer');
  });

  it('a real blank batch never exposes the hidden addend as a field value', () => {
    for (const q of genBatch(8, 'blank')) {
      const [p] = publicQuestions([q]) as any[];
      const hiddenKey = q.blank === 1 ? 'num1' : 'num2';
      expect(p).not.toHaveProperty(hiddenKey);
      expect(p).not.toHaveProperty('answer');
    }
  });
});
