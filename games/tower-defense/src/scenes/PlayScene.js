import Phaser from 'phaser';
import { GRID, GAME_WIDTH, GAME_HEIGHT, STARTING_LIVES, STARTING_GOLD, CRYPTO_BUILD } from '../config.js';
import { loadOwnedTowers } from '../data/chainLoader.js';
import { rarityColor } from '../data/rarity.js';
import { nearestInRange, shotDamage, applyDamage, waveSpec } from '../logic/targeting.js';

// Tile codes for the fixed 2D grid map.
const G = 0; // grass (decorative, not buildable)
const P = 1; // path  (enemies walk here)
const B = 2; // build (placeable cell)

// Fixed map fixture: GRID.rows x GRID.cols. A path snakes left->right; B cells flank it.
// 16 cols x 12 rows.
const MAP = [
  [G, G, G, G, G, G, G, G, G, G, G, G, G, G, G, G],
  [B, B, B, B, B, B, B, B, B, B, B, B, B, B, B, G],
  [P, P, P, P, P, P, P, P, P, P, P, P, P, P, B, G],
  [B, B, B, B, B, B, B, B, B, B, B, B, B, P, B, G],
  [B, P, P, P, P, P, P, P, P, P, P, P, P, P, B, G],
  [B, P, B, B, B, B, B, B, B, B, B, B, B, B, B, G],
  [B, P, B, B, B, B, B, B, B, B, B, B, B, B, B, G],
  [B, P, P, P, P, P, P, P, P, P, P, P, P, P, B, G],
  [B, B, B, B, B, B, B, B, B, B, B, B, B, P, B, G],
  [B, B, B, B, B, B, B, B, B, B, B, B, B, P, P, P],
  [B, B, B, B, B, B, B, B, B, B, B, B, B, B, B, G],
  [G, G, G, G, G, G, G, G, G, G, G, G, G, G, G, G],
];

// Waypoints (grid col/row) tracing the path above, in order. Enemies lerp between them.
const WAYPOINTS = [
  [0, 2], [13, 2], [13, 3], [13, 4],
  [1, 4], [1, 7], [13, 7], [13, 9], [15, 9],
];

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.lives = STARTING_LIVES;
    this.gold = STARTING_GOLD;
    this.wave = 0;
    this.enemies = [];
    this.towers = [];
    this.bullets = [];
    this.occupied = new Set(); // "col,row" cells already holding a tower
    this.spawning = false;
    this.toSpawn = 0;
    this.gameOver = false;
    this.towerDefs = [];
    this.selectedDefIndex = 0;
  }

  async create() {
    this.drawMap();
    this.path = WAYPOINTS.map(([c, r]) => this.cellCenter(c, r));

    // EE2/EE3: pull tower definitions from the loader. In the clean build this resolves to
    // the fixture; in the crypto build it tries the chain then falls back to the fixture.
    this.towerDefs = await loadOwnedTowers();
    this.selectedDefIndex = 0;

    this.buildHud();
    this.bindInput();
    this.startWave();

    this.events.on('update', this.step, this);
  }

  // --- map / grid -------------------------------------------------------------------- //
  drawMap() {
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) {
        const code = MAP[r][c];
        const key = code === P ? 'tile_path' : code === B ? 'tile_build' : 'tile_grass';
        const { x, y } = this.cellCenter(c, r);
        this.add.image(x, y, key).setAlpha(code === G ? 0.5 : 1);
      }
    }
  }

  cellCenter(col, row) {
    return { x: col * GRID.tile + GRID.tile / 2, y: row * GRID.tile + GRID.tile / 2 };
  }

  cellAt(px, py) {
    return { col: Math.floor(px / GRID.tile), row: Math.floor(py / GRID.tile) };
  }

  // --- HUD --------------------------------------------------------------------------- //
  buildHud() {
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '16px', color: '#cfe0ff' };
    this.hudLives = this.add.text(10, 6, '', style).setDepth(10);
    this.hudGold = this.add.text(180, 6, '', style).setDepth(10);
    this.hudWave = this.add.text(330, 6, '', style).setDepth(10);

    // Tower selector chips (one per loaded definition).
    this.selectorChips = [];
    this.towerDefs.forEach((def, i) => {
      const x = 10 + i * 150;
      const y = GAME_HEIGHT - 26;
      const chip = this.add
        .text(x, y, this.chipLabel(def), {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '12px',
          color: '#0b1020',
          backgroundColor: '#' + rarityColor(def.rarity).toString(16).padStart(6, '0'),
          padding: { x: 6, y: 4 },
        })
        .setDepth(10)
        .setInteractive({ useHandCursor: true });
      chip.on('pointerup', () => this.selectDef(i));
      this.selectorChips.push(chip);
    });
    this.selectDef(0);
    this.refreshHud();
  }

  chipLabel(def) {
    // Rarity stays in both builds (game design). Token id is shown only in the crypto build.
    const id = CRYPTO_BUILD ? ` #${def.tokenId}` : '';
    return `${def.name}${id}\n${def.rarity} · ${def.stats.damage}dmg`;
  }

  selectDef(i) {
    this.selectedDefIndex = i;
    this.selectorChips.forEach((chip, idx) => chip.setAlpha(idx === i ? 1 : 0.55));
  }

  refreshHud() {
    this.hudLives.setText(`Lives: ${this.lives}`);
    this.hudGold.setText(`Gold: ${this.gold}`);
    this.hudWave.setText(`Wave: ${this.wave}`);
  }

  // --- input: place towers ----------------------------------------------------------- //
  bindInput() {
    this.input.on('pointerdown', (pointer) => {
      if (this.gameOver) return;
      const { col, row } = this.cellAt(pointer.x, pointer.y);
      if (row < 0 || row >= GRID.rows || col < 0 || col >= GRID.cols) return;
      if (MAP[row][col] !== B) return; // only buildable cells
      const cellKey = `${col},${row}`;
      if (this.occupied.has(cellKey)) return;

      const def = this.towerDefs[this.selectedDefIndex];
      const cost = this.towerCost(def);
      if (this.gold < cost) return;

      this.gold -= cost;
      this.occupied.add(cellKey);
      this.placeTower(def, col, row);
      this.refreshHud();
    });
  }

  towerCost(def) {
    // Simple cost curve from rarity/damage.
    return 40 + def.stats.damage;
  }

  placeTower(def, col, row) {
    const { x, y } = this.cellCenter(col, row);
    const sprite = this.add.image(x, y, `tower_${def.rarity}`).setDepth(5);
    // faint range ring
    const ring = this.add.circle(x, y, def.stats.range, rarityColor(def.rarity), 0.06).setDepth(1);
    this.towers.push({
      x,
      y,
      stats: def.stats,
      rarity: def.rarity,
      cooldown: 0, // seconds until next shot
      sprite,
      ring,
    });
  }

  // --- waves ------------------------------------------------------------------------- //
  startWave() {
    this.wave += 1;
    this.spec = waveSpec(this.wave);
    this.toSpawn = this.spec.count;
    this.spawning = true;
    this.spawnAcc = 0;
    this.refreshHud();
  }

  spawnEnemy() {
    const start = this.path[0];
    const sprite = this.add.image(start.x, start.y, 'enemy').setDepth(4);
    // hp bar (background + fill)
    const barBg = this.add.rectangle(start.x, start.y - 16, 28, 4, 0x000000, 0.6).setDepth(6);
    const barFill = this.add.rectangle(start.x, start.y - 16, 28, 4, 0x49ff7a).setDepth(7);
    this.enemies.push({
      x: start.x,
      y: start.y,
      hp: this.spec.hp,
      maxHp: this.spec.hp,
      speed: this.spec.speed,
      bounty: this.spec.bounty,
      seg: 0, // current path segment index
      alive: true,
      sprite,
      barBg,
      barFill,
    });
  }

  // --- main loop --------------------------------------------------------------------- //
  step(_time, deltaMs) {
    if (this.gameOver) return;
    const dt = deltaMs / 1000;

    this.updateSpawning(dt);
    this.updateEnemies(dt);
    this.updateTowers(dt);
    this.updateBullets(dt);

    // Wave complete -> next wave once all spawned & cleared.
    if (!this.spawning && this.enemies.length === 0) {
      this.startWave();
    }
  }

  updateSpawning(dt) {
    if (!this.spawning) return;
    this.spawnAcc += dt;
    const interval = 0.7;
    while (this.spawnAcc >= interval && this.toSpawn > 0) {
      this.spawnAcc -= interval;
      this.toSpawn -= 1;
      this.spawnEnemy();
    }
    if (this.toSpawn <= 0) this.spawning = false;
  }

  updateEnemies(dt) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const target = this.path[e.seg + 1];
      if (!target) {
        this.enemyReachedEnd(e);
        continue;
      }
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const move = e.speed * dt;
      if (move >= dist) {
        e.x = target.x;
        e.y = target.y;
        e.seg += 1;
      } else {
        e.x += (dx / dist) * move;
        e.y += (dy / dist) * move;
      }
      e.sprite.setPosition(e.x, e.y);
      this.updateHpBar(e);
    }
    this.enemies = this.enemies.filter((e) => e.alive);
  }

  updateHpBar(e) {
    const frac = Math.max(0, e.hp / e.maxHp);
    e.barBg.setPosition(e.x, e.y - 16);
    e.barFill.setPosition(e.x - 14 + (28 * frac) / 2, e.y - 16);
    e.barFill.width = 28 * frac;
    e.barFill.fillColor = frac > 0.5 ? 0x49ff7a : frac > 0.25 ? 0xffd24a : 0xff5a5a;
  }

  enemyReachedEnd(e) {
    this.killEnemySprites(e);
    e.alive = false;
    this.lives -= 1;
    this.refreshHud();
    if (this.lives <= 0) this.endGame(false);
  }

  updateTowers(dt) {
    for (const tower of this.towers) {
      tower.cooldown -= dt;
      if (tower.cooldown > 0) continue;
      const target = nearestInRange(tower, this.enemies);
      if (!target) continue;
      this.fire(tower, target);
      tower.cooldown = 1 / Math.max(0.1, tower.stats.fireRate);
    }
  }

  fire(tower, target) {
    const sprite = this.add.image(tower.x, tower.y, 'bullet').setDepth(8);
    this.bullets.push({
      x: tower.x,
      y: tower.y,
      target,
      damage: shotDamage(tower.stats),
      speed: 420,
      sprite,
    });
  }

  updateBullets(dt) {
    for (const b of this.bullets) {
      if (!b.target.alive) {
        b.dead = true;
        b.sprite.destroy();
        continue;
      }
      const dx = b.target.x - b.x;
      const dy = b.target.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const move = b.speed * dt;
      if (move >= dist) {
        this.hitEnemy(b.target, b.damage);
        b.dead = true;
        b.sprite.destroy();
      } else {
        b.x += (dx / dist) * move;
        b.y += (dy / dist) * move;
        b.sprite.setPosition(b.x, b.y);
      }
    }
    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  hitEnemy(e, dmg) {
    if (!e.alive) return;
    const { hp, killed } = applyDamage(e.hp, dmg);
    e.hp = hp;
    if (killed) {
      e.alive = false;
      this.gold += e.bounty;
      this.killEnemySprites(e);
      this.refreshHud();
    } else {
      this.updateHpBar(e);
    }
  }

  killEnemySprites(e) {
    e.sprite.destroy();
    e.barBg.destroy();
    e.barFill.destroy();
  }

  // --- game over --------------------------------------------------------------------- //
  endGame(won) {
    this.gameOver = true;
    const overlay = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.7).setDepth(20);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 30, won ? 'VICTORY' : 'GAME OVER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: won ? '#62ffa0' : '#ff6a6a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 16, `Reached wave ${this.wave}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(21);
    const retry = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#0b1020',
        backgroundColor: '#62d0ff',
        padding: { x: 14, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setInteractive({ useHandCursor: true });
    retry.on('pointerup', () => this.scene.restart());
    overlay.setInteractive();
  }
}
