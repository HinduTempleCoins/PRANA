import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  DEFAULTS,
  PLATFORM,
  makeRng,
  newRun,
  stepPlayer,
  stepPlatform,
  fillPlatformsUpTo,
  prunePlatforms,
  speedScale,
  heightFor,
  hasFallen,
  cameraBottom,
} from '../logic/hop.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

// PlayScene runs the hopper world. World coordinates are absolute (y decreases upward); we
// render with a vertical OFFSET so the player stays ~40% down the screen — that offset IS the
// camera follow. Score = max height climbed. Fall below the camera bottom = game over.
export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.cfg = { ...DEFAULTS, ...RULES };
    this.rng = makeRng((Date.now() & 0x7fffffff) || 1);
    const run = newRun(this.rng, this.cfg);
    this.player = run.player;
    this.platforms = run.platforms;
    this.genState = run.genState;
    this.startY = run.startY;
    this.maxClimbY = this.player.y; // highest (smallest) y reached
    this.score = 0;
    this.gameOver = false;
    this.runStart = Date.now();
    this.platSprites = new Map(); // id -> sprite
    this.input.keyboard?.removeAllListeners?.();
  }

  create() {
    const skins = this.registry.get('skins') || [];
    const idx = this.registry.get('selectedSkinIndex') ?? 0;
    this.skin = skins[idx] || skins[0];

    this.cameras.main.setBackgroundColor('#070b18');
    this.drawBackdrop();

    this.playerSprite = this.add.image(0, 0, `hopper_${this.skin.itemId}`).setDepth(10);
    this.buildHud();
    this.bindInput();
    this.syncSprites();
  }

  // Faint vertical temple-stripe backdrop for a sense of depth.
  drawBackdrop() {
    const g = this.add.graphics().setDepth(0).setScrollFactor(0);
    for (let i = 0; i < 6; i++) {
      g.fillStyle(0x0c1426, 0.6);
      const w = GAME_WIDTH / 6;
      if (i % 2 === 0) g.fillRect(i * w, 0, w, GAME_HEIGHT);
    }
  }

  buildHud() {
    this.hudScore = this.add
      .text(12, 10, '', { fontFamily: 'system-ui, sans-serif', fontSize: '20px', color: '#cfe0ff', fontStyle: 'bold' })
      .setDepth(20)
      .setScrollFactor(0);
    this.hudSpeed = this.add
      .text(GAME_WIDTH - 12, 12, '', { fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#7f97c8' })
      .setOrigin(1, 0)
      .setDepth(20)
      .setScrollFactor(0);
  }

  bindInput() {
    const k = this.input.keyboard;
    this.steer = 0;
    const set = (v) => () => {
      this.steer = v;
    };
    const clear = (v) => () => {
      if (this.steer === v) this.steer = 0;
    };
    for (const code of ['LEFT', 'A']) {
      const key = k.addKey(Phaser.Input.Keyboard.KeyCodes[code]);
      key.on('down', set(-1));
      key.on('up', clear(-1));
    }
    for (const code of ['RIGHT', 'D']) {
      const key = k.addKey(Phaser.Input.Keyboard.KeyCodes[code]);
      key.on('down', set(1));
      key.on('up', clear(1));
    }
    // Pointer / tilt fallback: hold left/right half of the screen to steer; tap to restart.
    this.input.on('pointerdown', (p) => {
      if (this.gameOver) {
        this.restart();
        return;
      }
      this.steer = p.x < GAME_WIDTH / 2 ? -1 : 1;
    });
    this.input.on('pointerup', () => {
      this.steer = 0;
    });
  }

  // World y -> screen y. The camera keeps the player ~40% down; offset derives from maxClimbY.
  worldToScreenY(worldY) {
    const cameraTop = this.maxClimbY - GAME_HEIGHT * 0.4;
    return worldY - cameraTop;
  }

  update() {
    if (this.gameOver) return;
    const scale = speedScale(this.score, this.cfg);

    // advance moving platforms
    this.platforms = this.platforms.map((p) => stepPlatform(p, this.cfg, scale));

    // advance the player
    const r = stepPlayer(this.player, this.platforms, { dx: this.steer }, this.cfg, scale);
    this.player = r.player;
    this.platforms = r.platforms;
    if (r.bounced) this.onBounce();

    // camera follows max height
    if (this.player.y < this.maxClimbY) this.maxClimbY = this.player.y;
    this.score = heightFor(this.startY, this.maxClimbY);

    // keep the ladder filled above and prune what fell away below
    const fill = fillPlatformsUpTo(this.platforms, this.genState, this.maxClimbY - GAME_HEIGHT, this.rng, this.cfg);
    this.platforms = fill.platforms;
    this.genState = fill.state;
    const cull = cameraBottom(this.maxClimbY, this.cfg) + 80;
    this.platforms = prunePlatforms(this.platforms, cull);

    this.syncSprites();
    this.refreshHud(scale);

    if (hasFallen(this.player.y, this.maxClimbY, this.cfg)) this.die();
  }

  onBounce() {
    // drop a quick fading trail dot at the player's feet
    const sx = this.player.x;
    const sy = this.worldToScreenY(this.player.y + this.cfg.playerH);
    const dot = this.add.image(sx, sy, `trail_${this.skin.itemId}`).setDepth(9);
    this.tweens.add({ targets: dot, alpha: 0, scale: 0.3, duration: 320, onComplete: () => dot.destroy() });
  }

  // Reconcile platform sprites with the logic list, then place the player.
  syncSprites() {
    const live = new Set();
    for (const p of this.platforms) {
      if (!p.alive) {
        // crumbled — remove its sprite with a quick crumble fade
        const s = this.platSprites.get(p.id);
        if (s) {
          this.platSprites.delete(p.id);
          this.tweens.add({ targets: s, alpha: 0, y: s.y + 14, duration: 180, onComplete: () => s.destroy() });
        }
        continue;
      }
      live.add(p.id);
      let s = this.platSprites.get(p.id);
      if (!s) {
        const tex = p.type === PLATFORM.MOVING ? 'plat_moving' : p.type === PLATFORM.CRUMBLE ? 'plat_crumble' : 'plat_normal';
        s = this.add.image(0, 0, tex).setOrigin(0, 0).setDepth(5);
        this.platSprites.set(p.id, s);
      }
      s.setPosition(p.x, this.worldToScreenY(p.y));
    }
    // remove sprites whose platform was pruned away
    for (const [id, s] of this.platSprites) {
      if (!live.has(id) && this.platforms.every((p) => p.id !== id)) {
        s.destroy();
        this.platSprites.delete(id);
      }
    }
    this.playerSprite.setPosition(this.player.x, this.worldToScreenY(this.player.y) + this.cfg.playerH / 2);
  }

  refreshHud(scale) {
    this.hudScore.setText(`${this.score}`);
    this.hudSpeed.setText(`x${scale.toFixed(2)} speed`);
  }

  async die() {
    this.gameOver = true;
    this.cameras.main.shake(220, 0.008);

    const overlay = this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.74)
      .setDepth(30)
      .setScrollFactor(0)
      .setInteractive();
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 60, 'YOU FELL', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '36px',
        color: '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(31)
      .setScrollFactor(0);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 16, `Height ${this.score}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(31)
      .setScrollFactor(0);

    if (CRYPTO_BUILD) {
      const status = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 20, 'Settling score…', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: '#7f97c8',
        })
        .setOrigin(0.5)
        .setDepth(31)
        .setScrollFactor(0);
      const voucher = await requestScoreVoucher({
        player: SETTLEMENT.player,
        score: this.score,
        runHash: this.computeRunHash(),
      });
      if (voucher) {
        const tag = voucher.fixture ? ' (demo)' : '';
        status.setText(`Reward voucher ready${tag} — claim in your wallet.`).setColor('#9be4ff');
      } else {
        status.setText('No settlement endpoint configured.').setColor('#54689a');
      }
    }

    const retry = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 62, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#070b18',
        backgroundColor: '#62d0ff',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(31)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true });
    retry.on('pointerup', () => this.restart());
    overlay.on('pointerup', () => this.restart());
  }

  computeRunHash() {
    const durationMs = Date.now() - this.runStart;
    const seed = `${this.score}:${durationMs}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return '0x' + h.toString(16).padStart(8, '0');
  }

  restart() {
    this.scene.start('Menu');
  }
}
