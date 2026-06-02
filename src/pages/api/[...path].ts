import { Hono } from 'hono';
import type { APIContext } from 'astro';
import { encrypt, decrypt, sha256Hex } from '../../utils/crypto';
import { query } from '../../utils/db';

export const prerender = false;

const ONI_HP_PER_STAGE = 700;
const QUESTIONS_PER_BATCH = 5;
const MAX_STAGE = 12;

type Question = { num1: number; num2: number; answer: number };
type PlayToken = { stage: number; questions: Question[]; carriedScore: number };
type CarryToken = { carriedScore: number; nextStage: number };

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

function genQuestion(stage: number): Question {
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
  return { num1: a, num2: b, answer: a + b };
}

function genBatch(stage: number, count = QUESTIONS_PER_BATCH): Question[] {
  return Array.from({ length: count }, () => genQuestion(stage));
}

// Strip answers before sending to the client.
function publicQuestions(qs: Question[]) {
  return qs.map((q) => ({ num1: q.num1, num2: q.num2 }));
}

const app = new Hono().basePath('/api');

app.post('/stages/start', async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  let stage = Number(body.stage) || 1;
  let carriedScore = 0;

  if (body.carry_token) {
    const carry = decrypt<CarryToken>(body.carry_token);
    if (carry) {
      carriedScore = Number(carry.carriedScore) || 0;
      stage = carry.nextStage;
    }
  }
  if (stage < 1) stage = 1;
  if (stage > MAX_STAGE) stage = MAX_STAGE;

  const questions = genBatch(stage);
  const token = encrypt({ stage, questions, carriedScore } as PlayToken);

  return c.json({
    stage,
    questions: publicQuestions(questions),
    oni_max_hp: stage * ONI_HP_PER_STAGE,
    session_token: token,
  });
});

app.post('/stages/more', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = decrypt<PlayToken>(body.session_token);
  if (!token) {
    return c.json({ error: 'invalid_token' }, 400);
  }
  const more = genBatch(token.stage);
  const merged: PlayToken = {
    stage: token.stage,
    questions: [...token.questions, ...more],
    carriedScore: token.carriedScore,
  };
  return c.json({
    questions: publicQuestions(more),
    session_token: encrypt(merged),
  });
});

const SPECIAL_MULT = 3;

type VerifiedLog = {
  num1: number;
  num2: number;
  user_answer: number;
  is_correct: boolean;
  time_taken: number;
};

type VerifyResult = {
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
function verifyAndScore(
  token: PlayToken,
  answers: any[],
  isGameOver: boolean
): VerifyResult {
  const stage = token.stage;
  const oniMaxHp = stage * ONI_HP_PER_STAGE;

  // Build a multiset of generated (num1,num2) pairs for verification.
  const pool = new Map<string, number>();
  for (const q of token.questions) {
    const key = `${q.num1}_${q.num2}`;
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
    const userAnswer = Number(ans.user_answer);
    let t = Number(ans.time_taken);
    if (!Number.isFinite(t) || t < 0) t = 10;

    const key = `${num1}_${num2}`;
    const remaining = pool.get(key) || 0;
    if (remaining <= 0) {
      // Answer references a question the server never generated -> tampering.
      verified = false;
      continue;
    }
    pool.set(key, remaining - 1);

    const isCorrect = userAnswer === num1 + num2;
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
function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 20);
}

// Default display name when the player registers without a nickname:
// 「ゲスト-」 + last 4 chars of player_id (never the raw UUID).
function guestName(playerId: string): string {
  const tail = playerId.replace(/[^0-9a-zA-Z]/g, '').slice(-4) || '0000';
  return `ゲスト-${tail}`;
}

app.post('/stages/clear', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = decrypt<PlayToken>(body.session_token);
  if (!token) {
    return c.json({ error: 'invalid_token', verified: false }, 400);
  }

  const isGameOver = body.is_game_over === true;
  const answers: any[] = Array.isArray(body.answers) ? body.answers : [];
  const r = verifyAndScore(token, answers, isGameOver);

  // No DB writes here anymore: persistence happens only when the player opts
  // to register their score via /scores/submit.
  return c.json({
    verified: r.verified,
    cleared: r.defeated,
    is_game_over: isGameOver,
    game_completed: r.gameCompleted,
    stage_score: r.stageScore,
    defeat_bonus: r.defeatBonus,
    final_score: r.finalCumulative,
    oni_max_hp: r.oniMaxHp,
    carry_token: r.carryToken,
  });
});

app.post('/scores/submit', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = decrypt<PlayToken>(body.session_token);
  if (!token) {
    return c.json({ error: 'invalid_token', saved: false }, 400);
  }

  const isGameOver = body.is_game_over === true;
  const answers: any[] = Array.isArray(body.answers) ? body.answers : [];
  const r = verifyAndScore(token, answers, isGameOver);

  // Re-verify the result; never trust a client-sent raw score.
  if (!r.verified) {
    return c.json({ error: 'verification_failed', saved: false }, 400);
  }
  // Only a finished game (game over or all-clear) may be registered.
  if (!r.terminal) {
    return c.json({ error: 'not_terminal', saved: false }, 400);
  }

  const playerId = String(body.player_id || 'anonymous').slice(0, 255);
  const username = sanitizeDisplayName(body.display_name) || guestName(playerId);
  // Deterministic dedup key over the exact result (token + answers). The token
  // embeds a random IV, so each distinct game produces a unique hash.
  const resultHash = sha256Hex(
    `${body.session_token}|${JSON.stringify(answers)}`
  );

  try {
    const result = await query(
      `INSERT INTO scores (player_id, username, score, stage, result_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (result_hash) DO NOTHING
       RETURNING id`,
      [playerId, username, r.finalCumulative, r.reachedStage, resultHash]
    );
    const scoreId: number | null = result.rows[0]?.id ?? null;
    if (scoreId === null) {
      // Unique constraint hit: this exact result was already registered.
      // Return the existing row's id so the client can still show its rank.
      const existing = await query(
        'SELECT id FROM scores WHERE result_hash = $1',
        [resultHash]
      );
      return c.json(
        { error: 'already_submitted', saved: false, score_id: existing.rows[0]?.id ?? null },
        409
      );
    }

    // Async (non-blocking) bulk insert of question logs.
    if (r.verifiedLogs.length > 0) {
      const values: any[] = [];
      const placeholders = r.verifiedLogs
        .map((log, i) => {
          const o = i * 6;
          values.push(
            scoreId,
            log.num1,
            log.num2,
            log.user_answer,
            log.is_correct,
            log.time_taken
          );
          return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
        })
        .join(', ');
      void query(
        `INSERT INTO question_logs (score_id, num1, num2, user_answer, is_correct, time_taken) VALUES ${placeholders}`,
        values
      ).catch((err) => console.error('question_logs insert failed', err));
    }

    return c.json({
      saved: true,
      username,
      score: r.finalCumulative,
      stage: r.reachedStage,
      score_id: scoreId,
    });
  } catch (err) {
    console.error('score submit failed', err);
    return c.json({ error: 'save_failed', saved: false }, 500);
  }
});

app.get('/scores', async (c) => {
  try {
    const result = await query(
      'SELECT username, score, stage, created_at FROM scores ORDER BY score DESC, stage DESC, created_at ASC LIMIT 10'
    );
    return c.json({ scores: result.rows });
  } catch (err) {
    console.error('scores fetch failed', err);
    return c.json({ scores: [] });
  }
});

export const ALL = (context: APIContext) => app.fetch(context.request);
