import { audioManager } from './audio.js';

const MAX_INPUT_LEN = 7;
// Damage multiplier when the 必殺技 gauge fires. Kept in sync with the server
// (src/pages/api/[...path].ts).
const SPECIAL_MULT = 3;

function navigate(path) {
  if (typeof window === 'undefined') return;
  if (window.astroNavigate) window.astroNavigate(path);
  else window.location.href = path;
}

export function gameStore() {
  return {
    // identity
    playerId: '',
    // Nickname typed on the end screen (prefilled from the last one this
    // session). Empty -> a player_id-derived guest name is used on the server.
    nickname: '',

    // ranking submission flow
    submitting: false,
    submitted: false,
    submitError: '',
    savedName: '',

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

    // special attack gauge (0-100). Fills on each correct answer; at 100 the
    // next correct answer auto-fires the 必殺技. Gain is DETERMINISTIC so the
    // server (see /api/stages/clear) can replicate it and stay in sync.
    specialGauge: 0,
    // Visual mirror of specialGauge shown by the gauge bar. Lags behind the
    // logic value so it only advances once the light-orb effect reaches it.
    specialGaugeDisplay: 0,
    // True for ~750ms after the gauge reaches 100%: shows rainbow/sparkle and
    // locks input before the 必殺技 cut-in fires.
    gaugeFull: false,

    // effects
    _shakeTimer: null,
    shaking: false,
    takingDamage: false,
    // True while a beam/toxic-ball projectile is in flight; locks input so the
    // current question can't be answered twice before the hit resolves.
    attacking: false,
    explode: false,
    oniDefeated: false,
    oniImgReady: false,
    cutIn: false,
    superAttacking: false,
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
      }
      // Prefill the nickname with the last one entered this session.
      if (typeof sessionStorage !== 'undefined') {
        this.nickname = sessionStorage.getItem('nickname') || '';
      }
    },

    // Display name shown/used when the player registers without typing one.
    get defaultGuestName() {
      const tail = (this.playerId || '').replace(/[^0-9a-zA-Z]/g, '').slice(-4) || '0000';
      return `ゲスト-${tail}`;
    },

    // ---- helpers ----
    get oniHpPercent() {
      if (!this.oniMaxHp) return 0;
      return Math.max(0, (this.oniHp / this.oniMaxHp) * 100);
    },
    get locked() {
      return (
        this.loading ||
        this.stageCleared ||
        this.gameOver ||
        this.gameCompleted ||
        this.cutIn ||
        this.superAttacking ||
        this.attacking ||
        this.gaugeFull ||
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
      this.oniDefeated = false;
      this.oniImgReady = false;
      this.shaking = false;
      this.takingDamage = false;
      this.attacking = false;
      this.specialGauge = 0;
      this.specialGaugeDisplay = 0;
      this.gaugeFull = false;
      this.cutIn = false;
      this.superAttacking = false;
      this.submitting = false;
      this.submitted = false;
      this.submitError = '';
      this.savedName = '';
      if (this.audio) this.audio.playBGM('home');
    },

    async startNewGame() {
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
        // Keep the oni hidden until its NEW image actually loads (the <img>
        // @load handler flips oniImgReady), so the previous (defeated) oni's
        // stale frame never flashes during the swap.
        this.oniImgReady = false;
        this.stage = data.stage;
        this.oniMaxHp = data.oni_max_hp;
        this.oniHp = data.oni_max_hp;
        this.oniDefeated = false;
        this.totalDamage = 0;
        this.attacking = false;
        this.specialGauge = 0;
        this.specialGaugeDisplay = 0;
        this.gaugeFull = false;
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
          setTimeout(() => {
            if (this.audio) this.audio.playRandomGrowl();
          }, 700);
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
        let dmg = Math.round(base + timeBonus);

        // Deterministic gauge gain (10-25%). Must match the server.
        this.specialGauge += 10 + ((q.num1 + q.num2) % 16);
        const isSpecial = this.specialGauge >= 100;
        if (isSpecial) {
          dmg *= SPECIAL_MULT;
          this.specialGauge = 0;
        }

        if (isSpecial) {
          // Phase 0: fill gauge to 100, show rainbow + sparkle for ~750ms so
          // the player can see it's full, then hand off to fireSpecialAttack.
          this.specialGaugeDisplay = 100;
          this.gaugeFull = true;
          if (this.audio) this.audio.playSE('charge');
          this.sparkleGaugeFull();
          setTimeout(() => {
            this.gaugeFull = false;
            this.fireSpecialAttack(dmg);
          }, 750);
          return;
        }

        if (this.audio) this.audio.playSE('correct');
        // Light orbs gather to the 必殺技 gauge bar and advance it.
        this.spawnGaugeOrbs(this.specialGauge);
        // 女教師 がチョークを投げる；鬼に命中した瞬間にダメージが入る。
        this.attacking = true;
        this.throwChalk(() => {
          this.attacking = false;
          this.score += dmg;
          this.totalDamage += dmg;
          this.oniHp = Math.max(0, this.oniMaxHp - this.totalDamage);
          this.attackEffect(dmg);
          this.resolveAfterAttack();
        });
      } else {
        if (this.audio) this.audio.playSE('incorrect');
        // 鬼 hurls a toxic ball at the teacher; a life is lost only on impact.
        this.attacking = true;
        this.fireToxicBall(() => {
          this.attacking = false;
          this.lives -= 1;
          this.takeDamageEffect();
          this.resolveAfterAttack();
        });
      }
    },

    // Advance after a hit resolves: end the game, clear the stage, or move on.
    resolveAfterAttack() {
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
        // Explosion finished (oni faded to opacity 0). Hide the oni entirely so
        // it does NOT re-appear when the .is-exploding class is removed.
        this.oniDefeated = true;
        this.explode = false;
        if (completed) {
          this.loading = false;
          this.gameCompleted = true;
        } else {
          // No per-stage clear popup: leave the field empty for ~1s so the
          // player can see the oni is gone, then advance to the next oni.
          // loadStage clears `oniDefeated` once the next oni is ready.
          setTimeout(() => {
            this.proceedToNextStage();
          }, 1000);
        }
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
        });
        if (data && typeof data.final_score === 'number') {
          this.score = data.final_score;
        }
      } catch (e) {
        // keep client score if verification call fails
      } finally {
        this.loading = false;
      }
    },

    // Register this game's result to the ranking. Re-verified server-side; the
    // same result can't be submitted twice (dedup by result hash).
    async submitScore() {
      if (this.submitting || this.submitted) return;
      this.submitError = '';
      const name = (this.nickname || '').trim();
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('nickname', name);
      }
      this.submitting = true;
      try {
        const data = await this.api('/api/scores/submit', {
          session_token: this.sessionToken,
          answers: this.answersLog,
          is_game_over: this.gameOver,
          player_id: this.playerId,
          display_name: name,
        });
        if (data && data.saved) {
          this.submitted = true;
          this.savedName = data.username || name || this.defaultGuestName;
        } else if (data && data.error === 'already_submitted') {
          this.submitted = true;
          this.savedName = name || this.defaultGuestName;
          this.submitError = 'この結果は登録済みです';
        } else {
          this.submitError = '登録に失敗しました。もう一度お試しください';
        }
      } catch (e) {
        this.submitError = '通信エラーが発生しました';
      } finally {
        this.submitting = false;
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
    // Spawn small light orbs scattered around the screen, gather them directly
    // into the 必殺技 gauge bar. The gauge's displayed value only advances to
    // `targetGauge` once the orbs arrive. Everything here is styled INLINE and
    // the container uses `contain: strict` + overflow:hidden, so it can never
    // affect page scroll and does not depend on any (possibly cached) global
    // stylesheet.
    spawnGaugeOrbs(targetGauge) {
      if (typeof document === 'undefined' || typeof window === 'undefined') {
        this.specialGaugeDisplay = targetGauge;
        return;
      }
      const gaugeEl = document.querySelector('[data-special-gauge]');
      const self = this;

      const advance = () => {
        if (!self.cutIn && !self.superAttacking) {
          self.specialGaugeDisplay = Math.max(self.specialGaugeDisplay, targetGauge);
        }
      };

      if (!gaugeEl || typeof document.createElement('div').animate !== 'function') {
        advance();
        return;
      }

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 44;

      // Gather toward the 必殺技 gauge bar.
      const gr = gaugeEl.getBoundingClientRect();
      const cx = gr.left + gr.width / 2;
      const cy = gr.top + gr.height / 2;

      // Fresh, fully self-contained overlay. `contain: strict` guarantees its
      // contents cannot grow the document (no stray scrollbars); overflow:hidden
      // clips anything to the viewport box.
      const layer = document.createElement('div');
      layer.style.cssText =
        'position:fixed;inset:0;z-index:80;pointer-events:none;overflow:hidden;contain:strict;';
      document.body.appendChild(layer);

      const N = 8;
      const gatherDur = 620;
      let remaining = N;
      let cleaned = false;

      const orbBase =
        'position:absolute;top:0;left:0;width:20px;height:20px;border-radius:9999px;' +
        'background:radial-gradient(circle at 50% 50%,rgba(255,255,255,0.85) 0%,rgba(255,255,255,0.45) 32%,rgba(255,255,255,0.12) 58%,rgba(255,255,255,0) 74%);' +
        'box-shadow:0 0 8px rgba(255,255,255,0.45);' +
        'filter:blur(1px);will-change:transform,opacity;';
      const mergedBase =
        'position:absolute;top:0;left:0;width:32px;height:32px;border-radius:9999px;' +
        'background:radial-gradient(circle at 50% 50%,rgba(255,255,255,0.9) 0%,rgba(255,255,255,0.5) 34%,rgba(255,255,255,0.16) 60%,rgba(255,255,255,0) 76%);' +
        'box-shadow:0 0 12px rgba(255,255,255,0.5);' +
        'filter:blur(1.2px);will-change:transform,opacity;';

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        layer.remove();
      };

      const arrive = () => {
        advance();
        if (gaugeEl.animate) {
          gaugeEl.animate(
            [
              { transform: 'scale(1)', filter: 'brightness(1)' },
              { transform: 'scale(1.06)', filter: 'brightness(1.25)', offset: 0.4 },
              { transform: 'scale(1)', filter: 'brightness(1)' },
            ],
            { duration: 380, easing: 'ease-out' }
          );
        }
        cleanup();
      };

      const launchMerged = () => {
        const merged = document.createElement('div');
        merged.style.cssText = mergedBase;
        layer.appendChild(merged);
        // Orbs merge at the gauge bar: a gentle pop then fade. The gauge
        // advances on completion.
        const anim = merged.animate(
          [
            { transform: `translate(${cx}px,${cy}px) translate(-50%,-50%) scale(0.4)`, opacity: 0.45 },
            { transform: `translate(${cx}px,${cy}px) translate(-50%,-50%) scale(1.15)`, opacity: 0.8, offset: 0.4 },
            { transform: `translate(${cx}px,${cy}px) translate(-50%,-50%) scale(0.7)`, opacity: 0 },
          ],
          { duration: 460, easing: 'ease-out', fill: 'forwards' }
        );
        anim.onfinish = arrive;
      };

      for (let i = 0; i < N; i++) {
        const orb = document.createElement('div');
        orb.style.cssText = orbBase;
        const ang = Math.random() * Math.PI * 2;
        const rad = 80 + Math.random() * Math.min(vw, vh) * 0.3;
        // Clamp inside the viewport so nothing is ever placed off-screen.
        const sx = Math.max(margin, Math.min(vw - margin, cx + Math.cos(ang) * rad));
        const sy = Math.max(margin, Math.min(vh - margin, cy + Math.sin(ang) * rad));
        layer.appendChild(orb);
        const anim = orb.animate(
          [
            { transform: `translate(${sx}px,${sy}px) translate(-50%,-50%) scale(0.5)`, opacity: 0 },
            { transform: `translate(${sx}px,${sy}px) translate(-50%,-50%) scale(1)`, opacity: 0.6, offset: 0.2 },
            { transform: `translate(${cx}px,${cy}px) translate(-50%,-50%) scale(0.9)`, opacity: 0.6 },
          ],
          { duration: gatherDur, delay: i * 45, easing: 'cubic-bezier(0.5,0,0.3,1)', fill: 'forwards' }
        );
        anim.onfinish = () => {
          orb.remove();
          remaining -= 1;
          if (remaining === 0) launchMerged();
        };
      }

      // Safety net: if any animation event is missed, still advance the gauge
      // and remove the overlay.
      setTimeout(() => {
        advance();
        cleanup();
      }, 3000);
    },

    // A fresh full-viewport overlay for projectile effects. `contain: strict`
    // + overflow:hidden means its contents can never grow the document (no
    // stray scrollbars) and are clipped to the viewport box. All styling is
    // inline so it never depends on a (possibly cached) global stylesheet.
    _makeFxLayer() {
      const layer = document.createElement('div');
      layer.style.cssText =
        'position:fixed;inset:0;z-index:70;pointer-events:none;overflow:hidden;contain:strict;';
      document.body.appendChild(layer);
      return layer;
    },

    // Correct answer: 女教師 throws chalk at the 鬼. `onHit` runs the instant
    // the chalk reaches the oni (applies damage + resolves the turn).
    throwChalk(onHit) {
      if (typeof document === 'undefined' || typeof window === 'undefined') {
        onHit();
        return;
      }
      const teacher = document.querySelector('[data-mascot]');
      const oni = document.querySelector('[data-oni]');
      if (!teacher || !oni || typeof document.createElement('div').animate !== 'function') {
        onHit();
        return;
      }
      const tr = teacher.getBoundingClientRect();
      const or = oni.getBoundingClientRect();
      // Launch from the teacher's right hand area.
      const sx = tr.right - tr.width * 0.12;
      const sy = tr.top + tr.height * 0.42;
      // Aim at the oni's upper torso.
      const ex = or.left + or.width * 0.5;
      const ey = or.top + or.height * 0.35;
      const dx = ex - sx;
      const dy = ey - sy;

      const layer = this._makeFxLayer();
      const self = this;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        layer.remove();
      };

      // Chalk piece: small white-cream rectangle that spins during flight.
      const chalk = document.createElement('div');
      chalk.style.cssText =
        `position:absolute;left:${sx}px;top:${sy}px;width:22px;height:7px;border-radius:3px;` +
        'background:linear-gradient(135deg,#f0ede8 0%,#ffffff 45%,#e8e4df 100%);' +
        'box-shadow:0 1px 4px rgba(0,0,0,0.22),inset 0 1px 0 rgba(255,255,255,0.75);' +
        'transform-origin:50% 50%;will-change:transform,opacity;';
      layer.appendChild(chalk);

      const flightDur = 380;
      chalk.animate(
        [
          { transform: `translate(-50%,-50%) translate(0px,0px) rotate(0deg)`, opacity: 1 },
          { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(360deg)`, opacity: 1 },
        ],
        { duration: flightDur, easing: 'linear', fill: 'forwards' }
      );

      let hit = false;
      const strike = () => {
        if (hit) return;
        hit = true;
        if (self.audio) self.audio.playSE('chalk_hit');
        // Chalk dust: small white/cream particles scatter on impact.
        const dustCount = 7;
        for (let i = 0; i < dustCount; i++) {
          const dust = document.createElement('div');
          const ang = (i / dustCount) * Math.PI * 2;
          const speed = 28 + Math.random() * 36;
          const tdx = Math.cos(ang) * speed;
          const tdy = Math.sin(ang) * speed;
          const size = 5 + Math.round(Math.random() * 5);
          dust.style.cssText =
            `position:absolute;left:${ex}px;top:${ey}px;` +
            `width:${size}px;height:${size}px;border-radius:9999px;` +
            'background:rgba(255,255,255,0.88);' +
            'filter:blur(1px);will-change:transform,opacity;';
          layer.appendChild(dust);
          dust.animate(
            [
              { transform: `translate(-50%,-50%) translate(0px,0px) scale(1)`, opacity: 0.9 },
              { transform: `translate(-50%,-50%) translate(${tdx}px,${tdy}px) scale(0.2)`, opacity: 0 },
            ],
            { duration: 340, easing: 'ease-out', fill: 'forwards' }
          );
        }
        onHit();
        setTimeout(cleanup, 420);
      };
      // Chalk arrives after flightDur.
      setTimeout(strike, flightDur);
      // Safety net in case the timer is starved.
      setTimeout(() => {
        strike();
        cleanup();
      }, 1400);
    },

    // Special attack: barrage of chalk pieces fired in rapid succession.
    // `onAllHit` is called the moment the last chalk reaches the oni.
    fireChalkBarrage(onAllHit) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return;
      const teacher = document.querySelector('[data-mascot]');
      const oni = document.querySelector('[data-oni]');
      if (!teacher || !oni || typeof document.createElement('div').animate !== 'function') return;

      const tr = teacher.getBoundingClientRect();
      const or = oni.getBoundingClientRect();
      const sx = tr.right - tr.width * 0.12;
      const sy = tr.top + tr.height * 0.42;

      // Use a plain fixed layer at z-index 100 (above cut-in / all game UI).
      // No `contain:strict` so nothing clips the chalks unexpectedly.
      const layer = document.createElement('div');
      layer.style.cssText = 'position:fixed;inset:0;z-index:100;pointer-events:none;overflow:hidden;';
      document.body.appendChild(layer);
      const self = this;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        layer.remove();
      };

      const COUNT = 16;
      const STAGGER = 55;
      const FLIGHT = 420;

      const PASTEL_COLORS = [
        { bg: '#FFB3C6', glow: 'rgba(255,140,180,0.7)' }, // ピンク
        { bg: '#BAE1FF', glow: 'rgba(140,200,255,0.7)' }, // 水色
        { bg: '#FFF3A8', glow: 'rgba(255,230,100,0.7)' }, // 黄色
        { bg: '#B8F0B8', glow: 'rgba(140,230,140,0.7)' }, // 緑
        { bg: '#FFD4A8', glow: 'rgba(255,190,120,0.7)' }, // オレンジ
        { bg: '#DDB8FF', glow: 'rgba(200,140,255,0.7)' }, // 紫
        { bg: '#B5EAD7', glow: 'rgba(130,220,190,0.7)' }, // ミント
        { bg: '#FFDAC1', glow: 'rgba(255,200,160,0.7)' }, // ピーチ
      ];

      for (let i = 0; i < COUNT; i++) {
        setTimeout(() => {
          // Each chalk targets a random point spread across the oni's body.
          const targetX = or.left + or.width * (0.15 + Math.random() * 0.7);
          const targetY = or.top + or.height * (0.08 + Math.random() * 0.78);
          const dx = targetX - sx;
          const dy = targetY - sy;
          const spinDir = Math.random() > 0.5 ? 360 : -360;
          const color = PASTEL_COLORS[Math.floor(Math.random() * PASTEL_COLORS.length)];

          const chalk = document.createElement('div');
          chalk.style.cssText =
            `position:absolute;left:${sx}px;top:${sy}px;width:28px;height:9px;border-radius:4px;` +
            `background:${color.bg};` +
            `box-shadow:0 0 7px ${color.glow},0 2px 4px rgba(0,0,0,0.25);` +
            'transform-origin:50% 50%;will-change:transform,opacity;';
          layer.appendChild(chalk);
          chalk.animate(
            [
              { transform: `translate(-50%,-50%) translate(0px,0px) rotate(0deg)`, opacity: 1 },
              { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(${spinDir}deg)`, opacity: 1 },
            ],
            { duration: FLIGHT, easing: 'linear', fill: 'forwards' }
          );

          // Dust cloud on impact.
          setTimeout(() => {
            const isLast = i >= COUNT - 3;
            const dustCount = isLast ? 10 : 5;
            const hitX = sx + dx;
            const hitY = sy + dy;
            if (isLast && self.audio) self.audio.playSE('chalk_hit');
            for (let j = 0; j < dustCount; j++) {
              const dust = document.createElement('div');
              const ang = (j / dustCount) * Math.PI * 2;
              const speed = (isLast ? 40 : 24) + Math.random() * 28;
              const size = 5 + Math.round(Math.random() * (isLast ? 9 : 5));
              dust.style.cssText =
                `position:absolute;left:${hitX}px;top:${hitY}px;` +
                `width:${size}px;height:${size}px;border-radius:9999px;` +
                `background:${color.bg};` +
                `box-shadow:0 0 4px ${color.glow};` +
                'filter:blur(0.8px);will-change:transform,opacity;';
              layer.appendChild(dust);
              dust.animate(
                [
                  { transform: `translate(-50%,-50%) translate(0px,0px) scale(1)`, opacity: 0.95 },
                  { transform: `translate(-50%,-50%) translate(${Math.cos(ang) * speed}px,${Math.sin(ang) * speed}px) scale(0.2)`, opacity: 0 },
                ],
                { duration: 380, easing: 'ease-out', fill: 'forwards' }
              );
            }
            if (i === COUNT - 1) {
              if (onAllHit) onAllHit();
              setTimeout(cleanup, 500);
            }
          }, FLIGHT);
        }, i * STAGGER);
      }

      // Safety net.
      setTimeout(cleanup, COUNT * STAGGER + FLIGHT + 700);
    },

    // Show a white chalk-dust smoke cloud covering the oni, then call onDone
    // once the smoke fades. Used between the chalk barrage and the defeat animation.
    chalkSmokeOnOni(onDone) {
      if (typeof document === 'undefined' || typeof window === 'undefined') {
        onDone();
        return;
      }
      const oni = document.querySelector('[data-oni]');
      if (!oni || typeof document.createElement('div').animate !== 'function') {
        onDone();
        return;
      }
      const or = oni.getBoundingClientRect();
      const cx = or.left + or.width / 2;
      const cy = or.top + or.height / 2;

      const layer = document.createElement('div');
      layer.style.cssText = 'position:fixed;inset:0;z-index:100;pointer-events:none;overflow:hidden;';
      document.body.appendChild(layer);

      const SMOKE_COUNT = 10;
      const SMOKE_DUR = 900;
      const STAGGER_S = 60;

      for (let i = 0; i < SMOKE_COUNT; i++) {
        const puff = document.createElement('div');
        const size = 55 + Math.random() * 75;
        const ox = (Math.random() - 0.5) * or.width * 1.1;
        const oy = (Math.random() - 0.5) * or.height * 1.0;
        puff.style.cssText =
          `position:absolute;left:${cx + ox}px;top:${cy + oy}px;` +
          `width:${size}px;height:${size}px;border-radius:9999px;` +
          'background:rgba(255,255,255,0.75);filter:blur(14px);will-change:transform,opacity;';
        layer.appendChild(puff);
        puff.animate(
          [
            { transform: 'translate(-50%,-50%) scale(0.2)', opacity: 0, offset: 0 },
            { transform: 'translate(-50%,-50%) scale(1.1)', opacity: 0.85, offset: 0.25 },
            { transform: 'translate(-50%,-50%) scale(1.7)', opacity: 0, offset: 1 },
          ],
          { duration: SMOKE_DUR, delay: i * STAGGER_S, easing: 'ease-out', fill: 'forwards' }
        );
      }

      const totalMs = SMOKE_DUR + SMOKE_COUNT * STAGGER_S;
      setTimeout(() => {
        layer.remove();
        onDone();
      }, totalMs);
    },

    // Wrong answer: 鬼 hurls a toxic ball at 女教師. `onHit` runs when the ball
    // lands on the teacher (removes a life + resolves the turn).
    fireToxicBall(onHit) {
      if (typeof document === 'undefined' || typeof window === 'undefined') {
        onHit();
        return;
      }
      const teacher = document.querySelector('[data-mascot]');
      const oni = document.querySelector('[data-oni]');
      if (!teacher || !oni || typeof document.createElement('div').animate !== 'function') {
        onHit();
        return;
      }
      const tr = teacher.getBoundingClientRect();
      const or = oni.getBoundingClientRect();
      const sx = or.left + or.width * 0.4;
      const sy = or.top + or.height * 0.42;
      const ex = tr.left + tr.width * 0.5;
      const ey = tr.top + tr.height * 0.42;

      const layer = this._makeFxLayer();
      const self = this;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        layer.remove();
      };

      if (self.audio) self.audio.playSE('oni_attack');

      const DUR = 480;
      // A zero-size carrier point that travels straight from the oni to the
      // teacher. The main ball sits at its center and the satellites orbit it,
      // so they all move together while the satellites spin.
      const carrier = document.createElement('div');
      carrier.style.cssText =
        'position:absolute;top:0;left:0;width:0;height:0;will-change:transform;';
      layer.appendChild(carrier);
      carrier.animate(
        [
          { transform: `translate(${sx}px,${sy}px)` },
          { transform: `translate(${ex}px,${ey}px)` },
        ],
        { duration: DUR, easing: 'linear', fill: 'forwards' }
      );

      const ball = document.createElement('div');
      ball.style.cssText =
        'position:absolute;top:0;left:0;width:30px;height:30px;border-radius:9999px;' +
        'background:radial-gradient(circle at 38% 34%,rgba(214,255,138,0.95),rgba(118,255,3,0.85) 30%,rgba(155,93,229,0.85) 68%,rgba(91,20,140,0.9) 100%);' +
        'box-shadow:0 0 14px rgba(118,255,3,0.7),0 0 24px rgba(155,93,229,0.6);' +
        'filter:blur(0.3px);will-change:transform,opacity;';
      carrier.appendChild(ball);
      const anim = ball.animate(
        [
          { transform: 'translate(-50%,-50%) scale(0.6)', opacity: 0.3 },
          { transform: 'translate(-50%,-50%) scale(1.05)', opacity: 1, offset: 0.15 },
          { transform: 'translate(-50%,-50%) scale(0.95)', opacity: 1 },
        ],
        { duration: DUR, easing: 'linear', fill: 'forwards' }
      );

      // Smaller toxic orbs cling to the main ball, orbiting it at random radii,
      // phases, speeds and directions so they swirl around it during flight.
      const satCount = 4;
      for (let s = 0; s < satCount; s++) {
        const sat = document.createElement('div');
        const sz = 9 + Math.random() * 6;
        sat.style.cssText =
          `position:absolute;top:0;left:0;width:${sz}px;height:${sz}px;border-radius:9999px;` +
          'transform-origin:0 0;' +
          'background:radial-gradient(circle at 40% 36%,rgba(214,255,138,0.95),rgba(118,255,3,0.8) 38%,rgba(155,93,229,0.85) 100%);' +
          'box-shadow:0 0 8px rgba(118,255,3,0.6);filter:blur(0.3px);will-change:transform,opacity;';
        carrier.appendChild(sat);
        const R = 13 + Math.random() * 13;
        const phase = Math.random() * 360;
        const dir = Math.random() < 0.5 ? 1 : -1;
        const turns = 1.2 + Math.random() * 1.3;
        sat.animate(
          [
            { transform: `rotate(${phase}deg) translateX(${R}px) translate(-50%,-50%) scale(0.5)`, opacity: 0.3 },
            { transform: `rotate(${phase + dir * turns * 120}deg) translateX(${R}px) translate(-50%,-50%) scale(1)`, opacity: 0.9, offset: 0.18 },
            { transform: `rotate(${phase + dir * turns * 360}deg) translateX(${R}px) translate(-50%,-50%) scale(0.85)`, opacity: 0.9 },
          ],
          { duration: DUR, easing: 'linear', fill: 'forwards' }
        );
      }

      let hit = false;
      const splatAndHit = () => {
        if (hit) return;
        hit = true;
        const splat = document.createElement('div');
        splat.style.cssText =
          `position:absolute;left:${ex}px;top:${ey}px;width:74px;height:74px;border-radius:9999px;` +
          'background:radial-gradient(circle,rgba(118,255,3,0.8),rgba(155,93,229,0.5) 45%,rgba(155,93,229,0) 72%);' +
          'will-change:transform,opacity;';
        layer.appendChild(splat);
        splat.animate(
          [
            { transform: 'translate(-50%,-50%) scale(0.3)', opacity: 0.9 },
            { transform: 'translate(-50%,-50%) scale(1.25)', opacity: 0 },
          ],
          { duration: 380, easing: 'ease-out', fill: 'forwards' }
        );
        onHit();
        setTimeout(cleanup, 420);
      };
      anim.onfinish = splatAndHit;
      // Safety net in case onfinish never fires.
      setTimeout(() => {
        splatAndHit();
        cleanup();
      }, 1400);
    },

    attackEffect(dmg) {
      clearTimeout(this._shakeTimer);
      this.shaking = false;
      setTimeout(() => {
        this.shaking = true;
        this._shakeTimer = setTimeout(() => { this.shaking = false; }, 400);
      }, 0);
      const id = ++this._floatId;
      this.floatingTexts.push({ id, value: dmg });
      setTimeout(() => {
        this.floatingTexts = this.floatingTexts.filter((f) => f.id !== id);
      }, 1000);
    },
    // Burst of rainbow particle sparks around the 必殺技 gauge when it hits 100%.
    // Three waves spaced 300ms apart so sparks keep appearing for the full wait.
    sparkleGaugeFull() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return;
      const gaugeEl = document.querySelector('[data-special-gauge]');
      if (!gaugeEl || typeof document.createElement('div').animate !== 'function') return;

      const gr = gaugeEl.getBoundingClientRect();
      const colors = ['#ff0066', '#ff8800', '#ffee00', '#00f5d4', '#00aaff', '#aa00ff', '#f15bb5', '#ffffff'];

      const layer = document.createElement('div');
      layer.style.cssText =
        'position:fixed;inset:0;z-index:85;pointer-events:none;overflow:hidden;contain:strict;';
      document.body.appendChild(layer);

      const spawnBurst = (count, startDelay) => {
        for (let i = 0; i < count; i++) {
          setTimeout(() => {
            const spark = document.createElement('div');
            const color = colors[Math.floor(Math.random() * colors.length)];
            const sz = 4 + Math.random() * 5;
            spark.style.cssText =
              `position:absolute;top:0;left:0;width:${sz}px;height:${sz}px;border-radius:50%;` +
              `background:${color};box-shadow:0 0 ${sz * 2}px ${sz}px ${color};` +
              'will-change:transform,opacity;';
            layer.appendChild(spark);

            // Origin: random point along the gauge bar
            const ox = gr.left + Math.random() * gr.width;
            const oy = gr.top + gr.height / 2;
            const ang = Math.random() * Math.PI * 2;
            const endR = 22 + Math.random() * 50;
            const ex = ox + Math.cos(ang) * endR;
            const ey = oy + Math.sin(ang) * endR;

            const anim = spark.animate(
              [
                { transform: `translate(${ox}px,${oy}px) translate(-50%,-50%) scale(0)`, opacity: 0 },
                { transform: `translate(${ox + (ex - ox) * 0.25}px,${oy + (ey - oy) * 0.25}px) translate(-50%,-50%) scale(1.5)`, opacity: 1, offset: 0.2 },
                { transform: `translate(${ex}px,${ey}px) translate(-50%,-50%) scale(0)`, opacity: 0 },
              ],
              { duration: 420 + Math.random() * 230, easing: 'ease-out', fill: 'forwards' }
            );
            anim.onfinish = () => spark.remove();
          }, startDelay + i * 35);
        }
      };

      spawnBurst(10, 0);
      spawnBurst(10, 280);
      spawnBurst(8, 560);

      setTimeout(() => layer.remove(), 2200);
    },

    fireSpecialAttack(dmg) {
      // Phase 1 (0-1.3s): diagonal-band cut-in with its own sound. The main
      // 必殺技 sound is played later, synced to the ✕ slash impact (Phase 2).
      // The oni is NOT hit yet. Input is locked via `cutIn`.
      this.cutIn = true;
      if (this.audio) this.audio.playSE('special_cutin');
      setTimeout(() => {
        this.cutIn = false;
        // Phase 2 (1.3-2.2s): strike the oni now that the cut-in is done.
        this.score += dmg;
        this.totalDamage += dmg;
        this.oniHp = Math.max(0, this.oniMaxHp - this.totalDamage);
        this.superAttacking = true;
        // Gauge empties as the 必殺技 fires.
        this.specialGaugeDisplay = 0;
        if (this.audio) this.audio.playSE('special');
        const isKill = this.oniHp <= 0;
        // Phase 3: resolve after all chalk lands.
        // On a kill shot: last chalk hits → smoke cloud → defeat animation.
        // Otherwise: last chalk hits → next question immediately.
        let resolved = false;
        const resolve = () => {
          if (resolved) return;
          resolved = true;
          this.superAttacking = false;
          this.resolveAfterAttack();
        };
        this.fireChalkBarrage(() => {
          if (isKill) {
            this.chalkSmokeOnOni(resolve);
          } else {
            resolve();
          }
        });
        const id = ++this._floatId;
        this.floatingTexts.push({ id, value: dmg, special: true });
        setTimeout(() => {
          this.floatingTexts = this.floatingTexts.filter((f) => f.id !== id);
        }, 1200);
        // Safety net: resolve after 5s regardless, to prevent a stuck state.
        setTimeout(resolve, 5000);
      }, 1300);
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
