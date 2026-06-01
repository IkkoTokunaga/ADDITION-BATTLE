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

    // special attack gauge (0-100). Fills on each correct answer; at 100 the
    // next correct answer auto-fires the 必殺技. Gain is DETERMINISTIC so the
    // server (see /api/stages/clear) can replicate it and stay in sync.
    specialGauge: 0,
    // Visual mirror of specialGauge shown by the gauge bar. Lags behind the
    // logic value so it only advances once the light-orb effect reaches it.
    specialGaugeDisplay: 0,

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
        this.username = localStorage.getItem('username') || '';
      }
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
      this.cutIn = false;
      this.superAttacking = false;
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
          // Special flow: cut-in plays first, THEN the oni is struck, THEN we
          // advance. fireSpecialAttack drives the whole sequence.
          this.specialGaugeDisplay = 100;
          this.fireSpecialAttack(dmg);
          return;
        }

        if (this.audio) this.audio.playSE('correct');
        // Light orbs gather to the teacher and advance the 必殺技 gauge.
        this.spawnGaugeOrbs(this.specialGauge);
        // 女教師 fires a beam at the oni; damage only lands on impact.
        this.attacking = true;
        this.fireBeam(() => {
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
    // Spawn small light orbs scattered around the screen, gather them to the
    // center into one larger orb, then send it flying into the 必殺技 gauge.
    // The gauge's displayed value only advances to `targetGauge` once the orb
    // arrives. Everything here is styled INLINE and the container uses
    // `contain: strict` + overflow:hidden, so it can never affect page scroll
    // and does not depend on any (possibly cached) global stylesheet.
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

      // Gather toward the mascot (女教師) rather than the screen center.
      const mascot = document.querySelector('[data-mascot]');
      let cx;
      let cy;
      if (mascot) {
        const mr = mascot.getBoundingClientRect();
        cx = mr.left + mr.width / 2;
        cy = mr.top + mr.height / 2;
      } else {
        cx = vw / 2;
        cy = vh / 2;
      }

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
        if (self.audio) self.audio.playSE('keypad');
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
        // Orbs merge at the mascot: a gentle pop then fade. The gauge advances
        // on completion (no orb is sent to the gauge bar).
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

    // Correct answer: 女教師 fires a beam at the 鬼. `onHit` runs the instant
    // the beam reaches the oni (applies damage + resolves the turn).
    fireBeam(onHit) {
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
      const sx = tr.right - tr.width * 0.12;
      const sy = tr.top + tr.height * 0.42;
      const ex = or.left + or.width * 0.5;
      const ey = or.top + or.height * 0.5;
      const dist = Math.hypot(ex - sx, ey - sy);
      const ang = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI;

      const layer = this._makeFxLayer();
      const self = this;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        layer.remove();
      };

      if (self.audio) self.audio.playSE('laser');

      const beam = document.createElement('div');
      beam.style.cssText =
        `position:absolute;left:${sx}px;top:${sy}px;height:7px;width:${dist}px;` +
        'transform-origin:0 50%;border-radius:9999px;' +
        'background:linear-gradient(90deg,rgba(255,255,255,0.95),rgba(0,245,212,0.9) 45%,rgba(0,187,249,0.85));' +
        'box-shadow:0 0 14px rgba(0,245,212,0.85),0 0 26px rgba(0,187,249,0.55);' +
        'filter:blur(0.4px);will-change:transform,opacity;';
      layer.appendChild(beam);
      beam.animate(
        [
          { transform: `translateY(-50%) rotate(${ang}deg) scaleX(0)`, opacity: 0.3 },
          { transform: `translateY(-50%) rotate(${ang}deg) scaleX(1)`, opacity: 1, offset: 0.35 },
          { transform: `translateY(-50%) rotate(${ang}deg) scaleX(1)`, opacity: 1, offset: 0.72 },
          { transform: `translateY(-50%) rotate(${ang}deg) scaleX(1)`, opacity: 0 },
        ],
        { duration: 420, easing: 'ease-out', fill: 'forwards' }
      );

      let hit = false;
      const strike = () => {
        if (hit) return;
        hit = true;
        const flash = document.createElement('div');
        flash.style.cssText =
          `position:absolute;left:${ex}px;top:${ey}px;width:96px;height:96px;border-radius:9999px;` +
          'background:radial-gradient(circle,rgba(255,255,255,0.9),rgba(0,245,212,0.5) 42%,rgba(0,245,212,0) 70%);' +
          'will-change:transform,opacity;';
        layer.appendChild(flash);
        flash.animate(
          [
            { transform: 'translate(-50%,-50%) scale(0.3)', opacity: 0.9 },
            { transform: 'translate(-50%,-50%) scale(1.15)', opacity: 0 },
          ],
          { duration: 360, easing: 'ease-out', fill: 'forwards' }
        );
        onHit();
        setTimeout(cleanup, 420);
      };
      // Beam reaches the oni when scaleX hits 1 (~35% of 420ms).
      setTimeout(strike, 150);
      // Safety net in case the timer is starved.
      setTimeout(() => {
        strike();
        cleanup();
      }, 1200);
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
    fireSpecialAttack(dmg) {
      // Phase 1 (0-1.3s): diagonal-band cut-in only. The oni is NOT hit yet,
      // so the attack itself stays visible afterwards. Input is locked via the
      // cutIn flag in `locked`.
      this.cutIn = true;
      if (this.audio) {
        this.audio.playSE('special');
        this.audio.playSE('charge');
      }
      setTimeout(() => {
        this.cutIn = false;
        // Phase 2 (1.3-2.2s): strike the oni now that the cut-in is done.
        this.score += dmg;
        this.totalDamage += dmg;
        this.oniHp = Math.max(0, this.oniMaxHp - this.totalDamage);
        this.superAttacking = true;
        // Gauge empties as the 必殺技 fires.
        this.specialGaugeDisplay = 0;
        if (this.audio) {
          this.audio.playSE('laser');
          this.audio.playSE('correct');
        }
        const id = ++this._floatId;
        this.floatingTexts.push({ id, value: dmg, special: true });
        setTimeout(() => {
          this.floatingTexts = this.floatingTexts.filter((f) => f.id !== id);
        }, 1200);
        // Phase 3: resolve (next question, or stage clear / explosion).
        setTimeout(() => {
          this.superAttacking = false;
          this.resolveAfterAttack();
        }, 1050);
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
