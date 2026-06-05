import { Hono } from 'hono';
import { encrypt, decrypt, sha256Hex } from '../utils/crypto';
import { query } from '../utils/db';
import {
  ONI_HP_PER_STAGE,
  MAX_STAGE,
  genBatch,
  publicQuestions,
  verifyAndScore,
  normalizeMode,
  sanitizeDisplayName,
  guestName,
  type PlayToken,
  type CarryToken,
  type GameMode,
} from './game-logic';

export const app = new Hono().basePath('/api');

app.post('/stages/start', async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  let stage = Number(body.stage) || 1;
  let carriedScore = 0;
  // New game: mode comes from the request. Continuing to a next stage: the mode
  // is carried in the (server-issued) carry token and overrides any client claim.
  let mode: GameMode = normalizeMode(body.mode);

  if (body.carry_token) {
    const carry = decrypt<CarryToken>(body.carry_token);
    if (carry) {
      carriedScore = Number(carry.carriedScore) || 0;
      stage = carry.nextStage;
      mode = normalizeMode(carry.mode);
    }
  }
  if (stage < 1) stage = 1;
  if (stage > MAX_STAGE) stage = MAX_STAGE;

  const questions = genBatch(stage, mode);
  const token = encrypt({ stage, questions, carriedScore, mode } as PlayToken);

  return c.json({
    stage,
    mode,
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
  const mode = normalizeMode(token.mode);
  const more = genBatch(token.stage, mode);
  const merged: PlayToken = {
    stage: token.stage,
    questions: [...token.questions, ...more],
    carriedScore: token.carriedScore,
    mode,
  };
  return c.json({
    questions: publicQuestions(more),
    session_token: encrypt(merged),
  });
});

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
      `INSERT INTO scores (player_id, username, score, stage, mode, result_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (result_hash) DO NOTHING
       RETURNING id`,
      // mode comes from the verified token (r.mode), never from the client body.
      [playerId, username, r.finalCumulative, r.reachedStage, r.mode, resultHash]
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
      mode: r.mode,
      score_id: scoreId,
    });
  } catch (err) {
    console.error('score submit failed', err);
    return c.json({ error: 'save_failed', saved: false }, 500);
  }
});

app.get('/scores', async (c) => {
  // Rankings are separated by mode; default to the normal board.
  const mode = normalizeMode(c.req.query('mode'));
  try {
    const result = await query(
      `SELECT username, score, stage, created_at
       FROM scores
       WHERE mode = $1
       ORDER BY score DESC, stage DESC, created_at ASC
       LIMIT 10`,
      [mode]
    );
    return c.json({ mode, scores: result.rows });
  } catch (err) {
    console.error('scores fetch failed', err);
    return c.json({ mode, scores: [] });
  }
});
