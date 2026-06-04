import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  makeRng,
  gapCenterFor,
  initialState,
  stepWorld,
} from '../logic/flight.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

// The play area excludes the ground strip.
const PLAY_H = RULES.groundY;

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    // Seed the run. The gap RNG is seeded so the sequence is reproducible/verifiable; we keep
    // the seed to ship in the settlement payload (attester can replay the exact gaps).
    this.seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.gapRng = makeRng(this.seed);

    // Pre-generate enough pairs to fill the screen; we top up as the bird advances.
    const firstX = GAME_WIDTH + 80;
    const initialPairs = 6;
    const gaps = [];
    for (let i = 0; i < initialPairs; i++) gaps.push(gapCenterFor(this.gapRng(), RULES, PLAY_H));

    this.state = initialState(RULES, gaps, firstX);
    this.flapQueued = false;
    this.started = false; // first flap unfreezes gravity (a grace pause at spawn)
    this.gameOver = false;
    this.runStart = Date.now();
  }

  create() {
    this.add.image(GAME_WIDTH / 2, RULES.groundY + 14, 'ground').setDepth(8);

    this.birdSprite = this.add.image(RULES.birdX, this.state.y, 'ibis').setDepth(6);

    // One container of sprites per pillar pair (top + bottom + caps), pooled by index.
    this.pairViews = this.state.pillars.map(() => this.makePairView());
    this.syncPillars();

    this.scoreText = this.add
      .text(GAME_WIDTH / 2, 40, '0', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '44px',
        color: '#cfe0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(10);

    this.hint = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT * 0.55, 'TAP TO FLAP', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#9be4ff',
      })
      .setOrigin(0.5)
      .setDepth(10);

    this.bindInput();
  }

  makePairView() {
    const top = this.add.image(0, 0, 'pillar').setOrigin(0.5, 1).setDepth(5);
    const bottom = this.add.image(0, 0, 'pillar').setOrigin(0.5, 0).setDepth(5);
    const capTop = this.add.image(0, 0, 'pillar_cap').setOrigin(0.5, 1).setDepth(5);
    const capBottom = this.add.image(0, 0, 'pillar_cap').setOrigin(0.5, 0).setDepth(5);
    return { top, bottom, capTop, capBottom };
  }

  bindInput() {
    const flap = () => this.queueFlap();
    this.input.on('pointerdown', flap);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE).on('down', flap);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.UP).on('down', flap);
  }

  queueFlap() {
    if (this.gameOver) {
      this.scene.start('Menu');
      return;
    }
    if (!this.started) {
      this.started = true;
      if (this.hint) this.hint.setVisible(false);
    }
    this.flapQueued = true;
  }

  update(_time, deltaMs) {
    if (this.gameOver) return;
    const dt = Math.min(deltaMs, 40) / 1000;

    if (!this.started) {
      // Grace pause: bird hovers (gentle bob) until the first flap.
      this.birdSprite.setPosition(RULES.birdX, this.state.y + Math.sin(_time / 200) * 4);
      return;
    }

    const flapped = this.flapQueued;
    this.flapQueued = false;

    const prevScore = this.state.score;
    this.state = stepWorld(this.state, { flapped }, dt, RULES, RULES.birdX);

    this.recyclePillars();

    if (this.state.score !== prevScore) {
      this.scoreText.setText(`${this.state.score}`);
      this.cameras.main.flash(80, 40, 120, 200);
    }

    // Bird rotation reflects vertical velocity (dive/climb feel).
    const tilt = Phaser.Math.Clamp(this.state.vy / 600, -0.5, 0.9);
    this.birdSprite.setRotation(tilt);
    this.birdSprite.setPosition(RULES.birdX, this.state.y);

    this.syncPillars();

    if (this.state.dead) this.die();
  }

  // When the leftmost pair scrolls fully off-screen, recycle it to the right with a fresh
  // seeded gap. This keeps the world infinite while the gap sequence stays deterministic.
  recyclePillars() {
    let changed = false;
    for (let i = 0; i < this.state.pillars.length; i++) {
      const p = this.state.pillars[i];
      if (p.x + RULES.pillarW < -40) {
        // Furthest-right current x, to append behind it at one spacing.
        let maxX = -Infinity;
        for (const q of this.state.pillars) maxX = Math.max(maxX, q.x);
        this.state.pillars[i] = {
          x: maxX + RULES.pillarSpacing,
          gapCenter: gapCenterFor(this.gapRng(), RULES, PLAY_H),
          passed: false,
        };
        changed = true;
      }
    }
    if (changed) {
      // Ensure a view exists for every pair (count is stable, so this is a no-op normally).
      while (this.pairViews.length < this.state.pillars.length) this.pairViews.push(this.makePairView());
    }
  }

  syncPillars() {
    for (let i = 0; i < this.state.pillars.length; i++) {
      const p = this.state.pillars[i];
      const v = this.pairViews[i];
      const cx = p.x + RULES.pillarW / 2;
      const gapTop = p.gapCenter - RULES.gapHeight / 2;
      const gapBottom = p.gapCenter + RULES.gapHeight / 2;

      // Top pillar: from ceiling down to gapTop (origin bottom => height = gapTop).
      v.top.setPosition(cx, gapTop).setDisplaySize(RULES.pillarW, Math.max(1, gapTop));
      v.capTop.setPosition(cx, gapTop);
      // Bottom pillar: from gapBottom down to the ground.
      const bottomH = Math.max(1, RULES.groundY - gapBottom);
      v.bottom.setPosition(cx, gapBottom).setDisplaySize(RULES.pillarW, bottomH);
      v.capBottom.setPosition(cx, gapBottom);
    }
  }

  async die() {
    this.gameOver = true;
    this.cameras.main.shake(220, 0.012);
    this.birdSprite.setTint(0xff6a7a);

    this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72)
      .setDepth(20)
      .setInteractive();
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 56, 'GROUNDED', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 8, `Pillars passed: ${this.state.score}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(21);

    // Settlement (crypto build only). The clean build dead-code-eliminates this whole path.
    if (CRYPTO_BUILD) {
      const status = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 28, 'Settling score…', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: '#7f97c8',
        })
        .setOrigin(0.5)
        .setDepth(21);
      const voucher = await requestScoreVoucher({
        player: SETTLEMENT.player,
        score: this.state.score,
        runHash: this.computeRunHash(),
        seed: this.seed,
      });
      if (voucher) {
        const tag = voucher.fixture ? ' (demo)' : '';
        status.setText(`Reward voucher ready${tag} — claim in your wallet.`).setColor('#9be4ff');
      } else {
        status.setText('No settlement endpoint configured.').setColor('#54689a');
      }
    }

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 66, 'Tap to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#05080f',
        backgroundColor: '#62d0ff',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(21);
  }

  // Lightweight non-cryptographic integrity digest of the run. Attester re-derives server-side
  // (it can fully replay the gaps from `seed`).
  computeRunHash() {
    const durationMs = Date.now() - this.runStart;
    const seed = `${this.state.score}:${this.seed}:${durationMs}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return '0x' + h.toString(16).padStart(8, '0');
  }
}
