import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, CRYPTO_BUILD } from '../config.js';
import { hexToInt } from '../data/skins.js';

// Menu: title, palette-skin selector, and play.
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;
    this.skins = this.registry.get('skins') || [];
    this.selected = this.registry.get('selectedSkinIndex') ?? 0;

    this.add
      .text(cx, GAME_HEIGHT * 0.16, 'WALLBREAKER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '52px',
        color: '#bff0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, GAME_HEIGHT * 0.27, 'Steer the ball with your paddle. Break the wall. Keep it in play.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#6f8fc8',
      })
      .setOrigin(0.5);

    // --- palette slots --------------------------------------------------------------- //
    this.add
      .text(cx, GAME_HEIGHT * 0.4, 'PALETTE', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        color: '#54689a',
      })
      .setOrigin(0.5);

    this.previews = [];
    const n = this.skins.length;
    const spacing = 120;
    const startX = cx - ((n - 1) * spacing) / 2;
    this.skins.forEach((skin, i) => {
      const x = startX + i * spacing;
      const y = GAME_HEIGHT * 0.52;
      const swatch = this.add
        .rectangle(x, y, 64, 64, hexToInt(skin.palette.bg))
        .setStrokeStyle(2, hexToInt(skin.palette.paddle))
        .setInteractive({ useHandCursor: true });
      this.add.rectangle(x, y + 14, 40, 8, hexToInt(skin.palette.paddle)); // mini paddle
      this.add.circle(x, y - 10, 7, hexToInt(skin.palette.ball)); // mini ball
      const label = this.add
        .text(x, y + 46, skin.name, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '11px',
          color: '#9fb6e8',
          align: 'center',
          wordWrap: { width: spacing - 8 },
        })
        .setOrigin(0.5);
      swatch.on('pointerup', () => this.selectSkin(i));
      this.previews.push({ swatch, label });
    });
    this.selectSkin(this.selected);

    // --- play button ----------------------------------------------------------------- //
    const btn = this.add
      .text(cx, GAME_HEIGHT * 0.74, '▶  PLAY', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#05080f',
        backgroundColor: '#62d0ff',
        padding: { x: 24, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#9be4ff' }));
    btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#62d0ff' }));
    btn.on('pointerup', () => this.scene.start('Play'));

    this.add
      .text(cx, GAME_HEIGHT * 0.88, 'Move the mouse / drag to steer · click or Space to launch', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#54689a',
      })
      .setOrigin(0.5);

    // In the crypto build, hint that runs settle to a reward voucher. Stripped in clean.
    if (CRYPTO_BUILD) {
      this.add
        .text(cx, GAME_HEIGHT * 0.94, 'Crypto build: scores settle to a signed reward voucher.', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '11px',
          color: '#3f5a8a',
        })
        .setOrigin(0.5);
    }
  }

  selectSkin(i) {
    this.selected = i;
    this.registry.set('selectedSkinIndex', i);
    this.previews.forEach((p, idx) => {
      p.swatch.setScale(idx === i ? 1.15 : 1);
      p.swatch.setAlpha(idx === i ? 1 : 0.6);
      p.label.setColor(idx === i ? '#cfe0ff' : '#9fb6e8');
    });
  }
}
