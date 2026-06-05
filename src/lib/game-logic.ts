// Pure game logic (generation + scoring/verification), extracted from the
// Astro API route so it can be unit-tested in isolation. No behavior change
// from the original inline implementation.
import { encrypt } from '../utils/crypto';

export const ONI_HP_PER_STAGE = 700;
export const QUESTIONS_PER_BATCH = 5;
export const MAX_STAGE = 12;
const SPECIAL_MULT = 3;

export type GameMode = 'normal' | 'blank';
// Which term is hidden behind □: 0 = nothing (normal), 1 = first addend
// (num1), 2 = second addend (num2). The sum is never hidden.
export type BlankPos = 0 | 1 | 2;
export type Question = { num1: number; num2: number; answer: number; blank: BlankPos };
// `mode` is optional so legacy tokens (issued before blank mode shipped) decrypt
// cleanly; readers normalize a missing/invalid value to 'normal' via normalizeMode.
export type PlayToken = {
  stage: number;
  questions: Question[];
  carriedScore: number;
  mode?: GameMode;
};
export type CarryToken = { carriedScore: number; nextStage: number; mode?: GameMode };

// Normalize an untrusted mode value. Anything other than 'blank' is normal,
// so unknown/garbage/undefined safely falls back to the legacy behavior.
export function normalizeMode(mode: unknown): GameMode {
  return mode === 'blank' ? 'blank' : 'normal';
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Generate two numbers (da >= db digits) such that no column produces a carry.
function genNoCarry(da: number, db: number): { a: number; b: number } {
  const aDigits: number[] = [];
  const bDigits: number[] = [];
  for (let i = 0; i < da; i++) {
    const hasB = i < db;
    const aMin = i === da - 1 ? 1 : 0;
    const bMin = hasB && i === db - 1 ? 1 : 0;
    const bMax = hasB ? Math.min(9, 9 - aMin) : 0;
    const bDigit = hasB ? randInt(bMin, Math.max(bMin, bMax)) : 0;
    const aMax = Math.min(9, 9 - bDigit);
    const aDigit = randInt(aMin, Math.max(aMin, aMax));
    aDigits[i] = aDigit;
    bDigits[i] = bDigit;
  }
  let a = 0;
  let b = 0;
  for (let i = da - 1; i >= 0; i--) a = a * 10 + aDigits[i];
  for (let i = db - 1; i >= 0; i--) b = b * 10 + bDigits[i];
  return { a, b };
}

export function genQuestion(stage: number, mode: GameMode = 'normal'): Question {
  let a = 0;
  let b = 0;
  switch (stage) {
    case 1:
      a = randInt(1, 8);
      b = randInt(1, 9 - a);
      break;
    case 2:
      a = randInt(1, 9);
      b = randInt(1, 9);
      break;
    case 3:
      ({ a, b } = genNoCarry(2, 1));
      break;
    case 4:
      a = randInt(10, 99);
      b = randInt(1, 9);
      break;
    case 5:
      ({ a, b } = genNoCarry(2, 2));
      break;
    case 6:
      a = randInt(10, 99);
      b = randInt(10, 99);
      break;
    case 7:
      ({ a, b } = genNoCarry(3, 2));
      break;
    case 8:
      a = randInt(100, 999);
      b = randInt(10, 99);
      break;
    case 9:
      ({ a, b } = genNoCarry(3, 3));
      break;
    case 10:
      do {
        a = randInt(100, 999);
        b = randInt(100, 999);
      } while (a + b > 1000);
      break;
    case 11:
      a = randInt(100, 999);
      b = randInt(100, 999);
      break;
    case 12:
    default:
      a = randInt(1, 999);
      b = randInt(1, 999);
      break;
  }
  // In blank mode, hide exactly one addend (□). The sum is never hidden.
  const blank: BlankPos = mode === 'blank' ? (randInt(1, 2) as BlankPos) : 0;
  return { num1: a, num2: b, answer: a + b, blank };
}

export function genBatch(
  stage: number,
  mode: GameMode = 'normal',
  count = QUESTIONS_PER_BATCH
): Question[] {
  return Array.from({ length: count }, () => genQuestion(stage, mode));
}

// Build the client-facing payload. Never include the hidden value:
//  - blank=0 (normal): only the two addends ({num1, num2}); the player computes
//    the sum, which is never sent.
//  - blank=1: the first addend is hidden, so send the visible addend + sum
//    ({num2, sum, blank}); num1 (the answer) is omitted.
//  - blank=2: the second addend is hidden ({num1, sum, blank}); num2 omitted.
// The literal `answer` field is never present in any mode.
export function publicQuestions(qs: Question[]) {
  return qs.map((q) => {
    const blank: BlankPos = q.blank ?? 0;
    if (blank === 1) return { num2: q.num2, sum: q.answer, blank };
    if (blank === 2) return { num1: q.num1, sum: q.answer, blank };
    return { num1: q.num1, num2: q.num2 };
  });
}

export type VerifiedLog = {
  num1: number;
  num2: number;
  user_answer: number;
  is_correct: boolean;
  time_taken: number;
};

export type VerifyResult = {
  verified: boolean;
  stage: number;
  oniMaxHp: number;
  stageScore: number;
  defeated: boolean;
  defeatBonus: number;
  finalCumulative: number;
  gameCompleted: boolean;
  terminal: boolean;
  reachedStage: number;
  carryToken: string | null;
  verifiedLogs: VerifiedLog[];
};

// Re-run the deterministic scoring against the questions baked into the token.
// This is the single source of truth used by both /stages/clear (progression)
// and /scores/submit (ranking save) so a client can never inflate its score.
export function verifyAndScore(
  token: PlayToken,
  answers: any[],
  isGameOver: boolean
): VerifyResult {
  const stage = token.stage;
  const oniMaxHp = stage * ONI_HP_PER_STAGE;

  // Build a multiset of generated (num1,num2,□position) triples. Including the
  // blank position means a client that swaps which term it claims was hidden —
  // or downgrades a blank question to normal (blank=0) to be scored on the sum —
  // produces a key the server never generated, and is caught as tampering.
  const pool = new Map<string, number>();
  for (const q of token.questions) {
    const blank: BlankPos = q.blank ?? 0;
    const key = `${q.num1}_${q.num2}_${blank}`;
    pool.set(key, (pool.get(key) || 0) + 1);
  }

  let verified = true;
  let stageScore = 0;
  // Mirror of the client's 必殺技 gauge. Gain is deterministic so the special
  // multiplier triggers on exactly the same answers as the client.
  let specialGauge = 0;
  const verifiedLogs: VerifiedLog[] = [];

  for (const ans of answers) {
    const num1 = Number(ans.num1);
    const num2 = Number(ans.num2);
    // Missing/NaN blank -> 0, preserving the legacy (normal-only) behavior.
    const blank: BlankPos = (Number(ans.blank) || 0) as BlankPos;
    const userAnswer = Number(ans.user_answer);
    let t = Number(ans.time_taken);
    if (!Number.isFinite(t) || t < 0) t = 10;

    const key = `${num1}_${num2}_${blank}`;
    const remaining = pool.get(key) || 0;
    if (remaining <= 0) {
      // Answer references a question the server never generated -> tampering.
      verified = false;
      continue;
    }
    pool.set(key, remaining - 1);

    // Expected answer depends on the mode: blank mode wants the hidden addend
    // (num1 for blank=1, num2 for blank=2), normal mode wants the sum. The
    // scoring formula below is identical regardless of which it is.
    const expected = blank === 1 ? num1 : blank === 2 ? num2 : num1 + num2;
    const isCorrect = userAnswer === expected;
    if (isCorrect) {
      const baseScore = stage * 100;
      const timeBonus = t < 10 ? ((10 - t) * stage) / 10 : 0;
      let gained = Math.round(baseScore + timeBonus);
      specialGauge += 10 + ((num1 + num2) % 16);
      if (specialGauge >= 100) {
        gained *= SPECIAL_MULT;
        specialGauge = 0;
      }
      stageScore += gained;
    }
    verifiedLogs.push({
      num1,
      num2,
      user_answer: userAnswer,
      is_correct: isCorrect,
      time_taken: t,
    });
  }

  const defeated = !isGameOver && stageScore >= oniMaxHp;
  const defeatBonus = defeated ? Math.round(oniMaxHp / 2) : 0;
  const finalCumulative = token.carriedScore + stageScore + defeatBonus;
  const gameCompleted = defeated && stage >= MAX_STAGE;
  const terminal = isGameOver || gameCompleted;

  let carryToken: string | null = null;
  if (defeated && !gameCompleted) {
    carryToken = encrypt({
      carriedScore: finalCumulative,
      nextStage: stage + 1,
    } as CarryToken);
  }

  return {
    verified,
    stage,
    oniMaxHp,
    stageScore,
    defeated,
    defeatBonus,
    finalCumulative,
    gameCompleted,
    terminal,
    reachedStage: gameCompleted ? MAX_STAGE : stage,
    carryToken,
    verifiedLogs,
  };
}

// Trim, strip control characters, and cap the length of a user-supplied
// display name. Empty result -> caller falls back to a player_id-derived name.
export function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 20);
}

// Default display name when the player registers without a nickname:
// 「ゲスト-」 + last 4 chars of player_id (never the raw UUID).
export function guestName(playerId: string): string {
  const tail = playerId.replace(/[^0-9a-zA-Z]/g, '').slice(-4) || '0000';
  return `ゲスト-${tail}`;
}
