import { audioManager } from './audio';

// Oni max HP per stage. Must match ONI_HP_PER_STAGE in src/pages/api/[...path].ts
// so client-side defeat detection agrees with server-side verification.
const ONI_HP_PER_STAGE = 700;

// Helper to generate a unique player ID if none exists in localStorage
function getOrGeneratePlayerId() {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem('addition_battle_player_id');
  if (!id) {
    id = 'player_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
    localStorage.setItem('addition_battle_player_id', id);
  }
  return id;
}

export function gameStore() {
  return {
    // Game state
    username: typeof window !== 'undefined' ? localStorage.getItem('addition_battle_username') || '' : '',
    playerId: getOrGeneratePlayerId(),
    stage: 1,
    score: 0,
    lives: 3,
    oniHp: ONI_HP_PER_STAGE,
    oniMaxHp: ONI_HP_PER_STAGE,

    // Last cleared-stage results, shown in the STAGE CLEAR modal
    lastStageScore: 0,
    lastDefeatBonus: 0,

    // UI input & questions
    userInput: '',
    currentQuestion: null,
    questionQueue: [],
    questionIndex: 0,
    answersLog: [],
    sessionToken: '',
    nextStageToken: '',
    
    // Timers & states
    questionStartTime: 0,
    playing: false,
    loading: false,
    gameOver: false,
    stageCleared: false,
    gameCompleted: false,
    rankings: [],
    
    // Visual effects
    shakeOni: false,
    showMist: false,
    floatingTexts: [],
    floatingTextId: 0,
    
    // Initialize rankings
    async init() {
      this.fetchRankings();
    },

    // Fetch leaderboard
    async fetchRankings() {
      try {
        const res = await fetch('/api/scores');
        if (res.ok) {
          const data = await res.json();
          this.rankings = data.rankings || [];
        }
      } catch (err) {
        console.error('Failed to fetch rankings:', err);
      }
    },

    // Start a brand new game
    async startNewGame(username) {
      if (!username.trim()) return;
      this.username = username.trim();
      if (typeof window !== 'undefined') {
        localStorage.setItem('addition_battle_username', this.username);
      }
      
      // Initialize audio context
      audioManager.init();
      await audioManager.resume();
      
      this.stage = 1;
      this.score = 0;
      this.nextStageToken = '';
      this.gameCompleted = false;
      
      // Play stage entry sound
      audioManager.play('stage_intro');
      
      // Start Stage 1
      await this.loadStage(1);
    },

    // Load questions for a specific stage from the server
    async loadStage(stageNum) {
      this.loading = true;
      this.gameOver = false;
      this.stageCleared = false;
      this.stage = stageNum;
      this.lives = 3;
      this.oniMaxHp = stageNum * ONI_HP_PER_STAGE;
      this.oniHp = this.oniMaxHp;
      this.userInput = '';
      this.questionQueue = [];
      this.questionIndex = 0;
      this.answersLog = [];
      
      try {
        const res = await fetch('/api/stages/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stage: stageNum,
            previous_token: this.nextStageToken
          })
        });

        if (!res.ok) {
          throw new Error('Failed to load stage');
        }

        const data = await res.json();
        this.questionQueue = data.questions || [];
        this.sessionToken = data.session_token || '';
        
        // Setup BGM based on stage
        this.setupBGM();

        this.playing = true;
        this.loading = false;
        
        // Start first question
        this.nextQuestion();
      } catch (err) {
        console.error('Error loading stage:', err);
        this.loading = false;
        alert('ステージのロードに失敗しました。');
      }
    },

    // Dynamic BGM control based on stage
    setupBGM() {
      if (typeof window === 'undefined') return;
      const bgmPlayer = document.getElementById('bgm-player');
      if (!bgmPlayer) return;
      
      let bgmSrc = '/sounds/ステージ1-1.mp3';
      
      // Assign BGM tracks based on stage
      if (this.stage === 1) bgmSrc = '/sounds/ステージ1-1.mp3';
      else if (this.stage === 2) bgmSrc = '/sounds/ステージ2-1.mp3';
      else if (this.stage === 3) bgmSrc = '/sounds/ステージ3-1.mp3';
      else if (this.stage === 4) bgmSrc = '/sounds/ステージ4-1.mp3';
      else if (this.stage === 5) bgmSrc = '/sounds/ステージ5.mp3';
      else if (this.stage === 6) bgmSrc = '/sounds/ステージ6.mp3';
      else if (this.stage === 7) bgmSrc = '/sounds/ステージ7.mp3';
      else if (this.stage === 8) bgmSrc = '/sounds/ステージ8.mp3';
      else if (this.stage === 9) bgmSrc = '/sounds/ステージ9.mp3';
      else if (this.stage === 10) bgmSrc = '/sounds/ステージ10.mp3';
      else if (this.stage === 11) bgmSrc = '/sounds/ステージ11.mp3';
      else bgmSrc = '/sounds/ステージ12.mp3';
      
      if (bgmPlayer.getAttribute('src') !== bgmSrc) {
        bgmPlayer.setAttribute('src', bgmSrc);
        bgmPlayer.volume = 0.45;
        bgmPlayer.play().catch(e => console.log('BGM Autoplay blocked initially, will resume on click.', e));
      }
    },

    // Move to next question in queue
    nextQuestion() {
      this.userInput = '';  // clear before changing currentQuestion so both land in the same render frame
      if (this.questionIndex < this.questionQueue.length) {
        this.currentQuestion = this.questionQueue[this.questionIndex];
        this.questionStartTime = Date.now();
        
        // Trigger pre-fetching 5 more questions when player starts the 4th question (index 3) of the queue
        if (this.questionIndex === this.questionQueue.length - 2) {
          this.prefetchQuestions();
        }
      } else {
        // Out of questions (fallback: fetch more automatically)
        this.prefetchQuestions().then(() => {
          this.nextQuestion();
        });
      }
    },

    // Prefetch additional questions in the background
    async prefetchQuestions() {
      try {
        const res = await fetch('/api/stages/more', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_token: this.sessionToken
          })
        });

        if (res.ok) {
          const data = await res.json();
          this.questionQueue = [...this.questionQueue, ...(data.questions || [])];
          this.sessionToken = data.session_token || '';
        }
      } catch (err) {
        console.error('Failed to prefetch questions:', err);
      }
    },

    // Keypad digit input
    inputDigit(digit) {
      audioManager.play('keypad');
      if (this.userInput.length < 6) {
        this.userInput += digit;
      }
    },

    // Keypad backspace
    backspace() {
      audioManager.play('cancel');
      if (this.userInput.length > 0) {
        this.userInput = this.userInput.slice(0, -1);
      }
    },

    // Keypad clear all
    clearInput() {
      audioManager.play('cancel');
      this.userInput = '';
    },

    // Handle physical keyboard inputs
    handleKeyboard(e) {
      if (this.gameOver || this.stageCleared || this.loading) return;
      
      if (e.key >= '0' && e.key <= '9') {
        this.inputDigit(e.key);
      } else if (e.key === 'Backspace') {
        this.backspace();
      } else if (e.key === 'Enter') {
        this.submitAnswer();
      }
    },

    // Submit user's answer
    async submitAnswer() {
      if (this.userInput === '' || this.loading) return;

      const userAnsVal = parseInt(this.userInput, 10);
      this.userInput = '';  // clear immediately after parsing, before any reactive changes
      const q = this.currentQuestion;
      const isCorrect = userAnsVal === q.num1 + q.num2;
      const timeTaken = Math.max(0.1, (Date.now() - this.questionStartTime) / 1000);
      
      // Log this answer for backend verification
      this.answersLog.push({
        num1: q.num1,
        num2: q.num2,
        user_answer: userAnsVal,
        time_taken: timeTaken
      });

      // Calculate score changes locally
      if (isCorrect) {
        audioManager.play('correct');
        
        // Score calculation: stage * 100 + time bonus
        const baseScore = this.stage * 100;
        let timeBonus = 0;
        if (timeTaken < 10) {
          timeBonus = Math.round(((10 - timeTaken) * this.stage) / 10);
        }
        
        const damage = baseScore + timeBonus;
        this.oniHp = Math.max(0, this.oniHp - damage);
        this.score += damage;
        
        // Trigger screen floating text
        this.addFloatingText(`-${damage}`, 'correct');
        
        // Shake Oni
        this.shakeOni = true;
        setTimeout(() => this.shakeOni = false, 500);
        
        // Growl sound effect
        const randomGrowl = 'growl' + (Math.floor(Math.random() * 6) + 1);
        audioManager.play(randomGrowl);
      } else {
        audioManager.play('incorrect');
        audioManager.play('oni_attack');
        
        this.lives = Math.max(0, this.lives - 1);
        
        // Trigger damage text and toxic overlay
        this.addFloatingText('MISS!', 'incorrect');
        this.showMist = true;
        setTimeout(() => this.showMist = false, 800);
      }

      // Check stage progression status
      if (this.lives === 0) {
        // Game Over
        await this.endGame();
      } else if (this.oniHp === 0) {
        // Stage Clear!
        await this.clearStage();
      } else {
        // Continue playing current stage
        this.questionIndex++;
        this.nextQuestion();
      }
    },

    // Trigger floating damage text animation
    addFloatingText(text, type) {
      const id = this.floatingTextId++;
      // Random coordinates inside the enemy preview area
      const x = Math.floor(Math.random() * 80) + 10; // percentage
      const y = Math.floor(Math.random() * 40) + 20; // percentage
      
      this.floatingTexts.push({ id, text, x, y, type });
      
      // Garbage collect text after animation finishes
      setTimeout(() => {
        this.floatingTexts = this.floatingTexts.filter(t => t.id !== id);
      }, 1200);
    },

    // Handle game over state
    async endGame() {
      this.loading = true;
      this.gameOver = true;
      this.playing = false;
      
      // Stop stage BGM and play game over/clear screen BGM
      const bgmPlayer = document.getElementById('bgm-player');
      if (bgmPlayer) {
        bgmPlayer.setAttribute('src', '/sounds/クリア画面.mp3');
        bgmPlayer.play().catch(e => console.log('BGM Autoplay blocked.', e));
      }
      
      try {
        const res = await fetch('/api/stages/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_token: this.sessionToken,
            answers: this.answersLog,
            username: this.username,
            player_id: this.playerId,
            is_game_over: true
          })
        });

        if (res.ok) {
          const data = await res.json();
          this.score = data.final_score; // Set final verified score
        }
      } catch (err) {
        console.error('Failed to submit game over score:', err);
      } finally {
        this.loading = false;
        this.fetchRankings();
      }
    },

    // Handle stage clear state
    async clearStage() {
      this.loading = true;

      // Play the defeat blast; the explosion animation runs while we verify with the server.
      audioManager.play('laser');

      try {
        const res = await fetch('/api/stages/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_token: this.sessionToken,
            answers: this.answersLog,
            username: this.username,
            player_id: this.playerId,
            is_game_over: false
          })
        });

        if (!res.ok) {
          this.loading = false;
          return;
        }

        const data = await res.json();
        this.score = data.final_score; // Verified cumulative score
        this.lastDefeatBonus = data.defeat_bonus || 0;
        this.lastStageScore = data.stage_score || 0;
        this.nextStageToken = data.next_stage_token || '';

        if (this.stage === 12) {
          // Stage 12 cleared means the whole game is finished.
          const bgmPlayer = document.getElementById('bgm-player');
          if (bgmPlayer) {
            bgmPlayer.setAttribute('src', '/sounds/クリア画面.mp3');
            bgmPlayer.play().catch(e => console.log('BGM Autoplay blocked.', e));
          }
          this.gameCompleted = true;
          this.playing = false;
          this.loading = false;
          this.fetchRankings();
        } else {
          // Keep input locked while the explosion plays, then reveal the modal.
          setTimeout(() => {
            this.stageCleared = true;
            this.loading = false;
          }, 1100);
        }
      } catch (err) {
        console.error('Failed to submit stage clear score:', err);
        this.loading = false;
      }
    },

    // Proceed to next stage (triggered from the STAGE CLEAR modal button)
    async proceedToNextStage() {
      if (this.stage >= 12) return;
      this.stageCleared = false;
      audioManager.play('stage_intro');
      await this.loadStage(this.stage + 1);
    },

    // Back to title/start screen
    goBackToTitle() {
      const bgmPlayer = document.getElementById('bgm-player');
      if (bgmPlayer) {
        bgmPlayer.setAttribute('src', '/sounds/HOME-BGM.mp3');
        bgmPlayer.volume = 0.5;
        bgmPlayer.play().catch(e => console.log(e));
      }
      this.playing = false;
      this.gameOver = false;
      this.stageCleared = false;
      this.gameCompleted = false;
      this.fetchRankings();
      
      // Navigate back to title screen
      if (typeof window !== 'undefined' && !['/', '/index.html'].includes(window.location.pathname)) {
        if (window.astroNavigate) {
          window.astroNavigate('/');
        } else {
          window.location.href = '/';
        }
      }
    }
  };
}
