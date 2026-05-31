import { audioManager } from './audio.js';

const MAX_INPUT_LEN = 7;

function navigate(path) {
  if (typeof window === 'undefined') return;
  if (window.astroNavigate) window.astroNavigate(path);
  else window.location.href = path;
}

export function gameStore() {
  return {
    // identity
    playerId: '',
    username: '',

    // run state
    started: false,
    stage: 1,
    score: 0,
    lives: 3,

    // oni
    oniMaxHp: 700,
    oniHp: 700,
    totalDamage: 0,

    // questions
    questionQueue: [],
    questionIndex: 0,
    currentQuestion: null,
    userInput: '',
    questionStartTime: 0,
    answersLog: [],
    sessionToken: null,
    carryToken: null,
    prefetching: false,

    // flow flags
    loading: false,
    stageCleared: false,
    gameOver: false,
    gameCompleted: false,

    // results
    lastStageScore: 0,
    lastDefeatBonus: 0,

    // effects
    shaking: false,
    takingDamage: false,
    explode: false,
    floatingTexts: [],
    brokenHeart: -1,
    _floatId: 0,

    audio: null,

    init() {
      this.audio = audioManager();
      if (typeof localStorage !== 'undefined') {
        let pid = localStorage.getItem('player_id');
        if (!pid) {
          pid =
            typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : 'p_' + Math.random().toString(36).slice(2) + Date.now();
          localStorage.setItem('player_id', pid);
        }
        this.playerId = pid;
        this.username = localStorage.getItem('username') || '';
      }
    },

    // ---- helpers ----
    get oniHpPercent() {
      if (!this.oniMaxHp) return 0;
      return Math.max(0, (this.oniHp / this.oniMaxHp) * 100);
    },
    get teacherHpPercent() {
      return Math.max(0, (this.lives / 3) * 100);
    },
    get locked() {
      return (
        this.loading ||
        this.stageCleared ||
        this.gameOver ||
        this.gameCompleted ||
        !this.currentQuestion
      );
    },

    async api(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    },

    // ---- lifecycle ----
    goBackToTitle() {
      this.started = false;
      this.stage = 1;
      this.score = 0;
      this.lives = 3;
      this.gameOver = false;
      this.gameCompleted = false;
      this.stageCleared = false;
      this.loading = false;
      this.questionQueue = [];
      this.questionIndex = 0;
      this.currentQuestion = null;
      this.userInput = '';
      this.answersLog = [];
      this.carryToken = null;
      this.sessionToken = null;
      this.floatingTexts = [];
      this.explode = false;
      this.shaking = false;
      this.takingDamage = false;
      if (this.audio) this.audio.playBGM('home');
    },

    async startNewGame(name) {
      this.username = name;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('username', name);
      }
      if (this.audio) this.audio.unlock();
      this.started = true;
      this.score = 0;
      this.gameOver = false;
      this.gameCompleted = false;
      this.carryToken = null;
      await this.loadStage(1, null);
    },

    async loadStage(stage, carryToken) {
      this.loading = true;
      this.stageCleared = false;
      this.explode = false;
      try {
        const data = await this.api('/api/stages/start', {
          stage,
          carry_token: carryToken,
        });
        this.stage = data.stage;
        this.oniMaxHp = data.oni_max_hp;
        this.oniHp = data.oni_max_hp;
        this.totalDamage = 0;
        this.sessionToken = data.session_token;
        this.questionQueue = data.questions || [];
        this.questionIndex = 0;
        this.answersLog = [];
        this.lives = 3;
        this.userInput = '';
        this.currentQuestion = this.questionQueue[0] || null;
        this.questionStartTime =
          typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (this.audio) {
          this.audio.playBGM(this.audio.bgmForStage(this.stage));
          this.audio.playSE('stage_intro');
          this.audio.playRandomGrowl();
        }
      } finally {
        this.loading = false;
      }
    },

    // ---- input ----
    pressKey(d) {
      if (this.locked) return;
      if (this.userInput.length >= MAX_INPUT_LEN) return;
      this.userInput += String(d);
      if (this.audio) this.audio.playSE('keypad');
    },
    backspace() {
      if (this.locked) return;
      if (!this.userInput) return;
      this.userInput = this.userInput.slice(0, -1);
      if (this.audio) this.audio.playSE('cancel');
    },
    clearInput() {
      if (this.locked) return;
      this.userInput = '';
      if (this.audio) this.audio.playSE('cancel');
    },

    // ---- core answer flow ----
    submitAnswer() {
      if (this.locked || this.userInput === '') return;
      if (this.audio) this.audio.playSE('submit');

      const q = this.currentQuestion;
      const userAnsVal = parseInt(this.userInput, 10);
      // Clear input IMMEDIATELY, before any other reactive change, to avoid
      // Alpine effect-ordering races where the next question renders with the
      // previous answer still showing.
      this.userInput = '';

      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      const t = (now - this.questionStartTime) / 1000;
      const correct = userAnsVal === q.num1 + q.num2;

      this.answersLog.push({
        num1: q.num1,
        num2: q.num2,
        user_answer: Number.isFinite(userAnsVal) ? userAnsVal : -1,
        is_correct: correct,
        time_taken: t,
      });

      if (correct) {
        const base = this.stage * 100;
        const timeBonus = t < 10 ? ((10 - t) * this.stage) / 10 : 0;
        const dmg = Math.round(base + timeBonus);
        this.score += dmg;
        this.totalDamage += dmg;
        this.oniHp = Math.max(0, this.oniMaxHp - this.totalDamage);
        if (this.audio) this.audio.playSE('correct');
        this.attackEffect(dmg);
      } else {
        this.lives -= 1;
        this.takeDamageEffect();
        if (this.audio) {
          this.audio.playSE('incorrect');
          this.audio.playSE('oni_attack');
        }
      }

      if (this.lives <= 0) {
        this.endGame();
        return;
      }
      if (this.oniHp <= 0) {
        this.clearStage();
        return;
      }

      this.questionIndex++;
      this.nextQuestion();

      if (this.questionIndex >= this.questionQueue.length - 2) {
        this.prefetchQuestions();
      }
    },

    nextQuestion() {
      // Clear input FIRST, before swapping the question.
      this.userInput = '';
      this.currentQuestion = this.questionQueue[this.questionIndex] || null;
      this.questionStartTime =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!this.currentQuestion && !this.prefetching) {
        // Queue exhausted unexpectedly; pull more then retry.
        this.loading = true;
        this.prefetchQuestions().then(() => {
          this.currentQuestion = this.questionQueue[this.questionIndex] || null;
          this.loading = false;
        });
      }
    },

    async prefetchQuestions() {
      if (this.prefetching || !this.sessionToken) return;
      this.prefetching = true;
      try {
        const data = await this.api('/api/stages/more', {
          session_token: this.sessionToken,
        });
        if (data && data.questions) {
          this.questionQueue = [...this.questionQueue, ...data.questions];
          this.sessionToken = data.session_token;
        }
      } catch (e) {
        // Non-fatal; queue still has remaining questions.
      } finally {
        this.prefetching = false;
      }
    },

    async clearStage() {
      this.loading = true;
      if (this.audio) {
        this.audio.playSE('charge');
        this.audio.playSE('laser');
      }
      this.explode = true;

      let data;
      try {
        data = await this.api('/api/stages/clear', {
          session_token: this.sessionToken,
          answers: this.answersLog,
          is_game_over: false,
          player_id: this.playerId,
          username: this.username,
        });
      } catch (e) {
        data = null;
      }

      if (data) {
        this.score = data.final_score;
        this.lastStageScore = data.stage_score;
        this.lastDefeatBonus = data.defeat_bonus;
        this.carryToken = data.carry_token;
      }

      const completed = data && data.game_completed;
      setTimeout(() => {
        this.explode = false;
        this.loading = false;
        if (completed) {
          this.gameCompleted = true;
        } else {
          this.stageCleared = true;
        }
        if (this.audio) this.audio.playBGM('clear');
      }, 1100);
    },

    async proceedToNextStage() {
      this.stageCleared = false;
      if (this.audio) this.audio.playSE('stage_intro');
      await this.loadStage(this.stage + 1, this.carryToken);
    },

    async endGame() {
      this.gameOver = true;
      this.loading = true;
      if (this.audio) this.audio.playSE('oni_attack');
      try {
        const data = await this.api('/api/stages/clear', {
          session_token: this.sessionToken,
          answers: this.answersLog,
          is_game_over: true,
          player_id: this.playerId,
          username: this.username,
        });
        if (data && typeof data.final_score === 'number') {
          this.score = data.final_score;
        }
      } catch (e) {
        // keep client score if save fails
      } finally {
        this.loading = false;
      }
    },

    playAgain() {
      this.goBackToTitle();
      navigate('/');
    },
    goRanking() {
      navigate('/ranking');
    },

    // ---- effects ----
    attackEffect(dmg) {
      this.shaking = true;
      setTimeout(() => {
        this.shaking = false;
      }, 400);
      const id = ++this._floatId;
      this.floatingTexts.push({ id, value: dmg });
      setTimeout(() => {
        this.floatingTexts = this.floatingTexts.filter((f) => f.id !== id);
      }, 1000);
      if (this.audio) this.audio.playRandomGrowl();
    },
    takeDamageEffect() {
      this.takingDamage = true;
      this.brokenHeart = this.lives; // index that just emptied (0-based)
      setTimeout(() => {
        this.takingDamage = false;
      }, 700);
      setTimeout(() => {
        this.brokenHeart = -1;
      }, 700);
    },
  };
}
