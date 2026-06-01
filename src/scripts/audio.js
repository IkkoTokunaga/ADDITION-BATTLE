// Low-latency sound effects via Web Audio API + persistent BGM via <audio> element.

const SE_FILES = {
  keypad: 'テンキー',
  submit: '決定ボタンを押す',
  correct: 'クイズ正解',
  incorrect: 'クイズ不正解',
  cancel: 'キャンセル',
  stage_intro: 'ステージ入り',
  stage_intro_mid: 'ステージ途中入り',
  oni_attack: '鬼攻撃',
  laser: 'ビーム砲',
  charge: '光玉溜め',
  special: '必殺技',
  special_cutin: '必殺技カットイン',
  growl1: '鬼鳴き声1',
  growl2: '鬼鳴き声2',
  growl3: '鬼鳴き声3',
  growl4: '鬼鳴き声4',
  growl5: '鬼鳴き声5',
  growl6: '鬼鳴き声6',
};

// BGM track key -> filename (without extension).
const BGM_FILES = {
  home: 'HOME-BGM',
  clear: 'クリア画面',
  ranking: '記録画面-BGM',
  stage1: 'ステージ1-1',
  stage2: 'ステージ2-1',
  stage3: 'ステージ3-1',
  stage4: 'ステージ4-1',
  stage5: 'ステージ5',
  stage6: 'ステージ6',
  stage7: 'ステージ7',
  stage8: 'ステージ8',
  stage9: 'ステージ9',
  stage10: 'ステージ10',
  stage11: 'ステージ11',
  stage12: 'ステージ12',
};

const SOUND_PATH = '/sounds/';

class AudioManager {
  constructor() {
    this.ctx = null;
    this.seGain = null;
    this.buffers = new Map();
    this.currentBgmKey = null;
    this.muted = false;
    this.preloaded = false;
    this._unlocked = false;
    this._bgmPausedByVisibility = false;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          const el = this.bgmEl;
          if (el && !el.paused) {
            el.pause();
            this._bgmPausedByVisibility = true;
          }
        } else {
          if (this._bgmPausedByVisibility && this._unlocked) {
            this.bgmEl?.play().catch(() => {});
          }
          this._bgmPausedByVisibility = false;
        }
      });
    }
  }

  get bgmEl() {
    if (typeof document === 'undefined') return null;
    return document.getElementById('bgm-audio');
  }

  // Must be called from a user gesture to satisfy autoplay policies.
  unlock() {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        this.ctx = new Ctx();
        this.seGain = this.ctx.createGain();
        this.seGain.gain.value = this.muted ? 0 : 0.9;
        this.seGain.connect(this.ctx.destination);
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this._unlocked = true;
    if (!this.preloaded) this.preloadAll();
  }

  async preloadAll() {
    if (this.preloaded || !this.ctx) return;
    this.preloaded = true;
    await Promise.all(
      Object.entries(SE_FILES).map(([key, file]) => this._loadBuffer(key, file))
    );
  }

  async _loadBuffer(key, file) {
    if (this.buffers.has(key) || !this.ctx) return;
    try {
      const res = await fetch(`${SOUND_PATH}${encodeURIComponent(file)}.mp3`);
      const arr = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(arr);
      this.buffers.set(key, buf);
    } catch (e) {
      // Missing/undecodable file: skip silently so gameplay isn't blocked.
    }
  }

  playSE(name) {
    if (this.muted || !this.ctx || !this.seGain) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.seGain);
    src.start(0);
  }

  playRandomGrowl() {
    const n = 1 + Math.floor(Math.random() * 6);
    this.playSE(`growl${n}`);
  }

  playBGM(key) {
    const el = this.bgmEl;
    if (!el) return;
    const file = BGM_FILES[key];
    if (!file) return;
    if (this.currentBgmKey === key && !el.paused) return;
    this.currentBgmKey = key;
    const url = `${SOUND_PATH}${encodeURIComponent(file)}.mp3`;
    if (!el.src.endsWith(encodeURIComponent(file) + '.mp3')) {
      el.src = url;
    }
    el.loop = true;
    el.muted = this.muted;
    el.volume = this.muted ? 0 : 0.45;
    if (this._unlocked) {
      el.play().catch(() => {});
    }
  }

  bgmForStage(stage) {
    return `stage${Math.min(Math.max(stage, 1), 12)}`;
  }

  stopBGM() {
    const el = this.bgmEl;
    if (el) {
      el.pause();
    }
    this.currentBgmKey = null;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.seGain) this.seGain.gain.value = muted ? 0 : 0.9;
    const el = this.bgmEl;
    if (el) {
      el.muted = muted;
      el.volume = muted ? 0 : 0.45;
    }
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }
}

export function audioManager() {
  if (typeof window !== 'undefined') {
    if (!window.__audioManager) window.__audioManager = new AudioManager();
    return window.__audioManager;
  }
  // SSR fallback (no audio).
  return new AudioManager();
}
