class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    
    // Map of SE name to public URL path
    this.sounds = {
      keypad: '/sounds/テンキー.mp3',
      submit: '/sounds/決定ボタンを押す.mp3',
      correct: '/sounds/クイズ正解.mp3',
      incorrect: '/sounds/クイズ不正解.mp3',
      cancel: '/sounds/キャンセル.mp3',
      stage_intro: '/sounds/ステージ入り.mp3',
      stage_intro_mid: '/sounds/ステージ途中入り.mp3',
      oni_attack: '/sounds/鬼攻撃.mp3',
      laser: '/sounds/ビーム砲.mp3',
      charge: '/sounds/光玉溜め.mp3',
      clear_screen: '/sounds/クリア画面.mp3',
      growl1: '/sounds/鬼鳴き声1.mp3',
      growl2: '/sounds/鬼鳴き声2.mp3',
      growl3: '/sounds/鬼鳴き声3.mp3',
      growl4: '/sounds/鬼鳴き声4.mp3',
      growl5: '/sounds/鬼鳴き声5.mp3',
      growl6: '/sounds/鬼鳴き声6.mp3',
    };
  }

  /**
   * Initializes the AudioContext and starts fetching/decoding SE files.
   * This must be called from a user gesture event listener (e.g. click).
   */
  init() {
    if (this.ctx) return;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();
    } catch (e) {
      console.error('Web Audio API is not supported in this browser', e);
      return;
    }

    // Prefetch and cache sound files in memory
    Object.entries(this.sounds).forEach(([name, path]) => {
      fetch(path)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          return res.arrayBuffer();
        })
        .then(arrayBuffer => {
          return this.ctx.decodeAudioData(
            arrayBuffer,
            (buffer) => {
              this.buffers[name] = buffer;
            },
            (err) => {
              console.error(`Error decoding audio data for ${name}:`, err);
            }
          );
        })
        .catch(err => {
          console.error(`Failed to load sound: ${name} (${path})`, err);
        });
    });
  }

  /**
   * Resumes the AudioContext if it is suspended by the browser.
   */
  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /**
   * Plays a cached sound effect with zero delay.
   */
  play(name) {
    if (!this.ctx) {
      // Lazy init if AudioContext exists on window
      return;
    }
    
    // Ensure context is running
    this.resume();

    const buffer = this.buffers[name];
    if (!buffer) {
      console.warn(`Sound buffer for "${name}" is not loaded yet.`);
      return;
    }

    try {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ctx.destination);
      source.start(0);
    } catch (e) {
      console.error(`Failed to play sound "${name}":`, e);
    }
  }
}

export const audioManager = new AudioManager();
export default audioManager;
