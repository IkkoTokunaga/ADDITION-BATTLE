import { Hono } from 'hono';
import type { APIContext } from 'astro';
import { encrypt, decrypt, sha256Hex } from '../../utils/crypto';
import { query } from '../../utils/db';
import {
  ONI_HP_PER_STAGE,
  MAX_STAGE,
  genBatch,
  publicQuestions,
  verifyAndScore,
  sanitizeDisplayName,
  guestName,
  type PlayToken,
  type CarryToken,
} from '../../lib/game-logic';

export const prerender = false;

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
