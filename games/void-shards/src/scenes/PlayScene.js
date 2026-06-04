import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  stepShip,
  spawnBolt,
  stepBolts,
  stepShards,
  resolveBoltShardHits,
  shipShardCollision,
  spawnWave,
  saucerFire,
  integratePos,
} from '../logic/shards.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

const W = GAME_WIDTH;
const H = GAME_HEIGHT;

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.score = 0;
    this.lives = RULES.lives;
    this.wave = 1;
    this.gameOver = false;
    this.runStart = Date.now();

    this.resetShip();
    this.bolts = []; // player bolts {pos,vel,born,radius}
    this.hostileBolts = []; // saucer bolts
    this.shards = spawnWave(this.wave, RULES, W, H);
    this.lastFire = -9999;
    this.invulnUntil = performance.now() + RULES.respawnInvulnMs;

    this.saucer = null;
    this.lastSaucerSpawn = performance.now();
    this.lastSaucerFire = 0;

    // sprite pools
    this.shardSprites = new Map(); // id -> sprite
    this.boltSprites = [];
    this.hostileBoltSprites = [];
  }

  resetShip() {
    this.ship = {
      pos: { x: W / 2, y: H / 2 },
      vel: { x: 0, y: 0 },
      angle: -Math.PI / 2, // pointing up
    };
  }

  create() {
    this.add.image(W / 2, H / 2, 'star_field').setDepth(0);

    this.shipSprite = this.add.image(this.ship.pos.x, this.ship.pos.y, 'ship').setDepth(6);

    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#cfe0ff' };
    this.hudScore = this.add.text(10, 6, '', style).setDepth(20);
    this.hudInfo = this.add.text(W - 200, 6, '', style).setDepth(20);
    this.refreshHud();

    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyW = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.keyA = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyFire = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.keyFire.on('down', () => this.tryFire());

    this.input.on('pointerup', () => {
      if (this.gameOver) this.restart();
    });
  }

  refreshHud() {
    this.hudScore.setText(`Score ${this.score}`);
    this.hudInfo.setText(`Lives ${this.lives}  ·  Wave ${this.wave}`);
  }

  tryFire() {
    if (this.gameOver) return;
    const now = performance.now();
    if (now - this.lastFire < RULES.bolt.cooldownMs) return;
    if (this.bolts.length >= RULES.bolt.max) return;
    this.lastFire = now;
    this.bolts.push(spawnBolt(this.ship, RULES.bolt, now));
  }

  update(_time, deltaMs) {
    if (this.gameOver) return;
    const dt = Math.min(deltaMs, 50) / 1000; // clamp dt so a stall can't tunnel collisions
    const now = performance.now();

    // --- ship physics ---
    const input = {
      rotateLeft: this.cursors.left.isDown || this.keyA.isDown,
      rotateRight: this.cursors.right.isDown || this.keyD.isDown,
      thrust: this.cursors.up.isDown || this.keyW.isDown,
    };
    this.ship = stepShip(this.ship, input, RULES.ship, dt, W, H);

    // --- bolts ---
    this.bolts = stepBolts(this.bolts, RULES.bolt, dt, now, W, H);
    this.hostileBolts = stepBolts(
      this.hostileBolts,
      { lifeMs: RULES.saucer.boltLifeMs },
      dt,
      now,
      W,
      H,
    );

    // --- shards drift ---
    this.shards = stepShards(this.shards, dt, W, H);

    // --- bolt/shard collisions ---
    const hit = resolveBoltShardHits(this.bolts, this.shards, RULES.shards, W, H);
    if (hit.scored > 0) {
      this.bolts = hit.bolts;
      for (const d of hit.destroyed) this.popShard(d.pos, d.size);
      this.shards = hit.shards;
      this.score += hit.scored;
      this.refreshHud();
    }

    // --- saucer logic ---
    this.updateSaucer(dt, now);

    // --- collisions against the ship (only when vulnerable) ---
    const vulnerable = now >= this.invulnUntil;
    if (vulnerable) {
      const shIdx = shipShardCollision(this.ship, RULES.ship.radius, this.shards, W, H);
      let dead = shIdx !== -1;
      // saucer body
      if (!dead && this.saucer) {
        if (shipShardCollision(this.ship, RULES.ship.radius, [{ pos: this.saucer.pos, radius: RULES.saucer.radius }], W, H) !== -1) {
          dead = true;
        }
      }
      // hostile bolts
      if (!dead) {
        if (shipShardCollision(this.ship, RULES.ship.radius, this.hostileBolts.map((b) => ({ pos: b.pos, radius: b.radius })), W, H) !== -1) {
          dead = true;
        }
      }
      if (dead) {
        this.loseLife();
        if (this.gameOver) return;
      }
    }

    // --- wave clear: all shards gone -> next wave (+1 large) ---
    if (this.shards.length === 0) {
      this.wave += 1;
      this.shards = spawnWave(this.wave, RULES, W, H);
      this.refreshHud();
    }

    this.render(now);
  }

  updateSaucer(dt, now) {
    // spawn a saucer occasionally
    if (!this.saucer && now - this.lastSaucerSpawn >= RULES.saucer.spawnIntervalMs) {
      this.lastSaucerSpawn = now;
      const fromLeft = Math.random() < 0.5;
      this.saucer = {
        pos: { x: fromLeft ? 0 : W, y: Math.random() * H },
        vel: { x: (fromLeft ? 1 : -1) * RULES.saucer.speed, y: (Math.random() - 0.5) * RULES.saucer.speed * 0.6 },
      };
      this.lastSaucerFire = now;
      if (this.saucerSprite) this.saucerSprite.setVisible(true);
    }
    if (!this.saucer) return;

    this.saucer.pos = integratePos(this.saucer.pos, this.saucer.vel, dt, W, H);

    // fire at the ship
    if (now - this.lastSaucerFire >= RULES.saucer.fireIntervalMs) {
      this.lastSaucerFire = now;
      const shots = saucerFire(this.saucer.pos, this.ship.pos, RULES.saucer, now, W, H);
      this.hostileBolts.push(...shots);
    }

    // a player bolt can destroy the saucer
    for (let i = 0; i < this.bolts.length; i++) {
      const b = this.bolts[i];
      if (shipShardCollision({ pos: b.pos }, b.radius, [{ pos: this.saucer.pos, radius: RULES.saucer.radius }], W, H) !== -1) {
        this.bolts.splice(i, 1);
        this.popShard(this.saucer.pos, 'saucer');
        this.score += RULES.saucer.score;
        this.killSaucer();
        this.refreshHud();
        break;
      }
    }

    // despawn after it crosses the field (track lifetime loosely by distance traveled)
    if (this.saucer && now - this.lastSaucerSpawn > RULES.saucer.spawnIntervalMs * 0.55) {
      // it has had its time on screen; retire it
      this.killSaucer();
    }
  }

  killSaucer() {
    this.saucer = null;
    if (this.saucerSprite) this.saucerSprite.setVisible(false);
  }

  loseLife() {
    this.lives -= 1;
    this.cameras.main.shake(240, 0.012);
    this.refreshHud();
    if (this.lives <= 0) {
      this.die();
      return;
    }
    // respawn at center with brief invulnerability
    this.resetShip();
    this.invulnUntil = performance.now() + RULES.respawnInvulnMs;
  }

  // --- rendering --------------------------------------------------------------------- //
  render(now) {
    // ship
    const thrusting = this.cursors.up.isDown || this.keyW.isDown;
    this.shipSprite.setTexture(thrusting ? 'ship_thrust' : 'ship');
    this.shipSprite.setPosition(this.ship.pos.x, this.ship.pos.y);
    this.shipSprite.setRotation(this.ship.angle);
    // blink while invulnerable
    if (now < this.invulnUntil) {
      this.shipSprite.setAlpha(Math.floor(now / 120) % 2 === 0 ? 1 : 0.3);
    } else {
      this.shipSprite.setAlpha(1);
    }

    // shards: reconcile sprite pool by id
    const live = new Set();
    for (const s of this.shards) {
      live.add(s.id);
      let spr = this.shardSprites.get(s.id);
      if (!spr) {
        spr = this.add.image(0, 0, `shard_${s.size}`).setDepth(4);
        spr.rotSpeed = (Math.random() - 0.5) * 1.2;
        this.shardSprites.set(s.id, spr);
      }
      spr.setPosition(s.pos.x, s.pos.y);
      spr.rotation += spr.rotSpeed * 0.016;
    }
    for (const [id, spr] of this.shardSprites) {
      if (!live.has(id)) {
        spr.destroy();
        this.shardSprites.delete(id);
      }
    }

    this.syncBolts(this.bolts, this.boltSprites, 'bolt');
    this.syncBolts(this.hostileBolts, this.hostileBoltSprites, 'hostile_bolt');

    // saucer
    if (this.saucer) {
      if (!this.saucerSprite) this.saucerSprite = this.add.image(0, 0, 'saucer').setDepth(5);
      this.saucerSprite.setVisible(true).setPosition(this.saucer.pos.x, this.saucer.pos.y);
    } else if (this.saucerSprite) {
      this.saucerSprite.setVisible(false);
    }
  }

  syncBolts(bolts, pool, key) {
    while (pool.length < bolts.length) pool.push(this.add.image(0, 0, key).setDepth(7));
    while (pool.length > bolts.length) pool.pop().destroy();
    for (let i = 0; i < bolts.length; i++) pool[i].setPosition(bolts[i].pos.x, bolts[i].pos.y);
  }

  popShard(pos, size) {
    const key = size === 'saucer' ? 'hostile_bolt' : 'bolt';
    const fx = this.add.image(pos.x, pos.y, key).setDepth(8);
    this.tweens.add({
      targets: fx,
      scale: { from: 1, to: size === 'large' ? 5 : 3 },
      alpha: { from: 0.9, to: 0 },
      duration: 300,
      ease: 'Quad.out',
      onComplete: () => fx.destroy(),
    });
  }

  // --- death / settlement ------------------------------------------------------------ //
  async die() {
    this.gameOver = true;
    this.cameras.main.shake(300, 0.02);

    const overlay = this.add
      .rectangle(W / 2, H / 2, W, H, 0x000000, 0.72)
      .setDepth(30)
      .setInteractive();
    this.add
      .text(W / 2, H / 2 - 60, 'GAME OVER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '42px',
        color: '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(31);
    this.add
      .text(W / 2, H / 2 - 10, `Score ${this.score}  ·  reached wave ${this.wave}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(31);

    // Settlement (crypto build only). The clean build dead-code-eliminates this whole path.
    if (CRYPTO_BUILD) {
      const status = this.add
        .text(W / 2, H / 2 + 30, 'Settling score…', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: '#7f97c8',
        })
        .setOrigin(0.5)
        .setDepth(31);
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
      .text(W / 2, H / 2 + 74, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#04060e',
        backgroundColor: '#62d0ff',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(31)
      .setInteractive({ useHandCursor: true });
    retry.on('pointerup', () => this.restart());
    overlay.on('pointerup', () => this.restart());
  }

  // Lightweight non-cryptographic integrity digest of the run. The attester re-derives /
  // re-checks server-side; this only has to be a stable per-run reference, not secure.
  computeRunHash() {
    const durationMs = Date.now() - this.runStart;
    const seed = `${this.score}:${this.wave}:${this.lives}:${durationMs}`;
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
