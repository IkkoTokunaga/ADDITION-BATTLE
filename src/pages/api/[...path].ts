import { Hono } from 'hono';
import { encrypt, decrypt } from '../../utils/crypto';
import { query } from '../../utils/db';

const app = new Hono().basePath('/api');

interface Question {
  id: number;
  num1: number;
  num2: number;
  answer: number;
}

// Generate a random math question according to stage difficulty rules
function generateQuestion(stage: number, id: number): Question {
  let num1 = 0;
  let num2 = 0;

  switch (stage) {
    case 1:
      // 1桁 + 1桁 (繰り上がりなし、和が9以下)
      num1 = Math.floor(Math.random() * 8) + 1; // 1..8
      num2 = Math.floor(Math.random() * (9 - num1)) + 1; // 1..(9-num1)
      break;
    case 2:
      // 1桁 + 1桁 (制限なし、繰り上がり可能)
      num1 = Math.floor(Math.random() * 9) + 1; // 1..9
      num2 = Math.floor(Math.random() * 9) + 1; // 1..9
      break;
    case 3:
      // 1桁 + 2桁 (繰り上がりなし)
      num1 = Math.floor(Math.random() * 9) + 1; // 1..9
      const tens3 = Math.floor(Math.random() * 9) + 1; // 1..9
      const units3 = Math.floor(Math.random() * (10 - num1)); // 0..9-num1
      num2 = tens3 * 10 + units3;
      if (Math.random() > 0.5) {
        const tmp = num1;
        num1 = num2;
        num2 = tmp;
      }
      break;
    case 4:
      // 1桁 + 2桁 (制限なし)
      num1 = Math.floor(Math.random() * 9) + 1; // 1..9
      num2 = Math.floor(Math.random() * 90) + 10; // 10..99
      if (Math.random() > 0.5) {
        const tmp = num1;
        num1 = num2;
        num2 = tmp;
      }
      break;
    case 5:
      // 2桁 + 2桁 (繰り上がりなし)
      const u1_5 = Math.floor(Math.random() * 9) + 1;
      const u2_5 = Math.floor(Math.random() * (10 - u1_5));
      const t1_5 = Math.floor(Math.random() * 8) + 1;
      const t2_5 = Math.floor(Math.random() * (9 - t1_5)) + 1;
      num1 = t1_5 * 10 + u1_5;
      num2 = t2_5 * 10 + u2_5;
      break;
    case 6:
      // 2桁 + 2桁 (制限なし)
      num1 = Math.floor(Math.random() * 90) + 10;
      num2 = Math.floor(Math.random() * 90) + 10;
      break;
    case 7:
      // 3桁 + 2桁 (繰り上がりなし)
      const u1_7 = Math.floor(Math.random() * 9) + 1;
      const u2_7 = Math.floor(Math.random() * (10 - u1_7));
      const t1_7 = Math.floor(Math.random() * 9) + 1;
      const t2_7 = Math.floor(Math.random() * (10 - t1_7));
      const h1_7 = Math.floor(Math.random() * 9) + 1;
      num1 = h1_7 * 100 + t1_7 * 10 + u1_7;
      num2 = t2_7 * 10 + u2_7;
      if (Math.random() > 0.5) {
        const tmp = num1;
        num1 = num2;
        num2 = tmp;
      }
      break;
    case 8:
      // 3桁 + 2桁 (制限なし)
      num1 = Math.floor(Math.random() * 900) + 100;
      num2 = Math.floor(Math.random() * 90) + 10;
      if (Math.random() > 0.5) {
        const tmp = num1;
        num1 = num2;
        num2 = tmp;
      }
      break;
    case 9:
      // 3桁 + 3桁 (繰り上がりなし, 和が1000以下)
      const u1_9 = Math.floor(Math.random() * 9) + 1;
      const u2_9 = Math.floor(Math.random() * (10 - u1_9));
      const t1_9 = Math.floor(Math.random() * 9) + 1;
      const t2_9 = Math.floor(Math.random() * (10 - t1_9));
      const h1_9 = Math.floor(Math.random() * 8) + 1;
      const h2_9 = Math.floor(Math.random() * (9 - h1_9)) + 1;
      num1 = h1_9 * 100 + t1_9 * 10 + u1_9;
      num2 = h2_9 * 100 + t2_9 * 10 + u2_9;
      break;
    case 10:
      // 3桁 + 3桁 (和が1000以下)
      num1 = Math.floor(Math.random() * 800) + 100; // 100..899
      num2 = Math.floor(Math.random() * (1001 - num1 - 100)) + 100; // 100..1000-num1
      break;
    case 11:
      // 3桁 + 3桁 (制限なし)
      num1 = Math.floor(Math.random() * 900) + 100;
      num2 = Math.floor(Math.random() * 900) + 100;
      break;
    case 12:
    default:
      // 1〜999 + 1〜999 (制限なし)
      num1 = Math.floor(Math.random() * 999) + 1;
      num2 = Math.floor(Math.random() * 999) + 1;
      break;
  }

  return {
    id,
    num1,
    num2,
    answer: num1 + num2
  };
}

// 1. POST /api/stages/start - Initialize a stage and generate the first 5 questions
app.post('/stages/start', async (c) => {
  try {
    const body = await c.req.json();
    const stage = parseInt(body.stage, 10) || 1;
    const previousToken = body.previous_token;

    let accumulatedScore = 0;

    // Verify previous token if stage > 1 to prevent arbitrary starting scores
    if (stage > 1) {
      if (!previousToken) {
        return c.json({ error: 'Missing previous stage token' }, 400);
      }
      const prevData = decrypt(previousToken);
      if (!prevData || prevData.stage !== stage - 1 || !prevData.cleared) {
        return c.json({ error: 'Invalid or uncleared previous stage token' }, 400);
      }
      accumulatedScore = prevData.final_score || 0;
    }

    const questions: Question[] = [];
    for (let i = 0; i < 5; i++) {
      questions.push(generateQuestion(stage, i + 1));
    }

    const tokenData = {
      stage,
      questions,
      accumulatedScore,
      createdAt: Date.now()
    };

    const sessionToken = encrypt(tokenData);

    return c.json({
      questions: questions.map(q => ({ id: q.id, num1: q.num1, num2: q.num2 })),
      session_token: sessionToken
    });
  } catch (err) {
    console.error('Error starting stage:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 2. POST /api/stages/more - Generate 5 more questions for the session
app.post('/stages/more', async (c) => {
  try {
    const body = await c.req.json();
    const sessionToken = body.session_token;

    if (!sessionToken) {
      return c.json({ error: 'Missing session token' }, 400);
    }

    const tokenData = decrypt(sessionToken);
    if (!tokenData || !tokenData.questions || !tokenData.stage) {
      return c.json({ error: 'Invalid session token' }, 400);
    }

    const stage = tokenData.stage;
    const currentQuestions = tokenData.questions;
    const nextStartId = currentQuestions.length + 1;

    const newQuestions: Question[] = [];
    for (let i = 0; i < 5; i++) {
      newQuestions.push(generateQuestion(stage, nextStartId + i));
    }

    const updatedTokenData = {
      ...tokenData,
      questions: [...currentQuestions, ...newQuestions]
    };

    const newSessionToken = encrypt(updatedTokenData);

    return c.json({
      questions: newQuestions.map(q => ({ id: q.id, num1: q.num1, num2: q.num2 })),
      session_token: newSessionToken
    });
  } catch (err) {
    console.error('Error fetching more questions:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 3. POST /api/stages/clear - Verify answers, calculate score, and persist results
app.post('/stages/clear', async (c) => {
  try {
    const body = await c.req.json();
    const { session_token, answers, username, player_id, is_game_over } = body;

    if (!session_token || !answers || !username || !player_id) {
      return c.json({ error: 'Missing required parameters' }, 400);
    }

    const tokenData = decrypt(session_token);
    if (!tokenData || !tokenData.questions || !tokenData.stage) {
      return c.json({ error: 'Invalid session token' }, 400);
    }

    const stage = tokenData.stage;
    const generatedQuestions = tokenData.questions;
    const accumulatedScore = tokenData.accumulatedScore || 0;

    // Check that we didn't receive more answers than questions generated
    if (answers.length > generatedQuestions.length) {
      return c.json({ error: 'Discrepancy in answers length' }, 400);
    }

    let stageScore = 0;
    let totalDamage = 0;
    let lives = 3;
    const verifiedLogs: Array<{ num1: number, num2: number, user_answer: number, is_correct: boolean, time_taken: number }> = [];

    // Verify each answer
    for (let i = 0; i < answers.length; i++) {
      const uAns = answers[i];
      const gQuest = generatedQuestions[i];

      // Validate matching question numbers
      if (uAns.num1 !== gQuest.num1 || uAns.num2 !== gQuest.num2) {
        return c.json({ error: 'Submitted question does not match generated question' }, 400);
      }

      const isCorrect = uAns.user_answer === gQuest.answer;
      
      let questionScore = 0;
      if (isCorrect) {
        const baseScore = stage * 100;
        let timeBonus = 0;
        if (uAns.time_taken < 10 && uAns.time_taken >= 0) {
          timeBonus = ((10 - uAns.time_taken) * stage) / 10;
        }
        questionScore = Math.round(baseScore + timeBonus);
        stageScore += questionScore;
        totalDamage += questionScore;
      } else {
        lives--;
      }

      verifiedLogs.push({
        num1: gQuest.num1,
        num2: gQuest.num2,
        user_answer: uAns.user_answer,
        is_correct: isCorrect,
        time_taken: uAns.time_taken
      });
    }

    // Determine final score and clear status
    const oniMaxHp = stage * 1010;
    const isStageCleared = !is_game_over && lives > 0 && totalDamage >= oniMaxHp;
    
    let defeatBonus = 0;
    if (isStageCleared) {
      defeatBonus = Math.round(oniMaxHp / 2);
    }

    const stageTotalScore = stageScore + defeatBonus;
    const finalScore = accumulatedScore + stageTotalScore;

    // TODO(security): Parameterized query prevents SQL injection when inserting scores
    const scoreResult = await query(
      `INSERT INTO scores (player_id, username, score, stage) VALUES ($1, $2, $3, $4) RETURNING id`,
      [player_id, username, finalScore, isStageCleared ? stage + 1 : stage]
    );
    const scoreId = scoreResult.rows[0].id;

    // Asynchronously insert question logs to keep the response fast (non-blocking)
    const logBulkInsert = async () => {
      try {
        for (const log of verifiedLogs) {
          // TODO(security): Parameterized query prevents SQL injection when inserting question logs
          await query(
            `INSERT INTO question_logs (score_id, num1, num2, user_answer, is_correct, time_taken) VALUES ($1, $2, $3, $4, $5, $6)`,
            [scoreId, log.num1, log.num2, log.user_answer, log.is_correct, log.time_taken]
          );
        }
      } catch (err) {
        console.error('Failed to save question logs:', err);
      }
    };
    logBulkInsert();

    if (isStageCleared) {
      // Generate a next stage token
      const nextStageTokenData = {
        stage: stage,
        cleared: true,
        final_score: finalScore,
        createdAt: Date.now()
      };
      const nextStageToken = encrypt(nextStageTokenData);

      return c.json({
        verified: true,
        final_score: finalScore,
        next_stage_token: nextStageToken,
        is_game_over: false
      });
    } else {
      return c.json({
        verified: true,
        final_score: finalScore,
        is_game_over: true
      });
    }
  } catch (err) {
    console.error('Error verifying stage clear:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 4. GET /api/scores - Retrieve top 10 rankings
app.post('/scores', async (c) => { // Using POST for compatibility or standard GET? The spec says GET /api/scores
  // We will support both GET /api/scores and POST /api/scores just in case
  return getScoresHandler(c);
});

app.get('/scores', async (c) => {
  return getScoresHandler(c);
});

async function getScoresHandler(c: any) {
  try {
    const result = await query(
      `SELECT username, score, stage, created_at FROM scores ORDER BY score DESC, stage DESC LIMIT 10`
    );
    return c.json({ rankings: result.rows });
  } catch (err) {
    console.error('Error fetching rankings:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
}

export const ALL = (context: any) => app.fetch(context.request);
