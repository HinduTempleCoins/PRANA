import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, CRYPTO_BUILD } from '../config.js';
import { hexToInt } from '../data/skins.js';

// Menu: title, skin-slot selector (palette + glyph preview), and play.
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;
    this.skins = this.registry.get('skins') || [];
    this.selected = this.registry.get('selectedSkinIndex') ?? 0;

    this.add
      .text(cx, GAME_HEIGHT * 0.12, 'MERGESTONE', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '46px',
        color: '#bfe0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, GAME_HEIGHT * 0.22, 'Slide the stones. Merge the runes. Climb the tiers.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#6f8fc8',
      })
      .setOrigin(0.5);

    // --- skin slots ------------------------------------------------------------------ //
    this.add
      .text(cx, GAME_HEIGHT * 0.34, 'STONE', {
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
      const y = GAME_HEIGHT * 0.46;
      // preview a mid-tier stone of this skin
      const img = this.add
        .image(x, y, `stone_${skin.itemId}_4`)
        .setScale(0.62)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, y + 50, skin.name, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '12px',
          color: '#9fb6e8',
          align: 'center',
          wordWrap: { width: spacing - 8 },
        })
        .setOrigin(0.5);
      img.on('pointerup', () => this.selectSkin(i));
      this.previews.push({ img, label, glow: hexToInt(skin.palette.glow) });
    });
    this.selectSkin(this.selected);

    // --- play button ----------------------------------------------------------------- //
    const btn = this.add
      .text(cx, GAME_HEIGHT * 0.66, '▶  PLAY', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#0a0e1a',
        backgroundColor: '#62d0ff',
        padding: { x: 24, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#9be4ff' }));
    btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#62d0ff' }));
    btn.on('pointerup', () => this.scene.start('Play'));

    this.add
      .text(cx, GAME_HEIGHT * 0.78, 'Arrow keys / WASD to slide · or swipe a direction', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#54689a',
      })
      .setOrigin(0.5);

    // In the crypto build, hint that runs settle to a reward voucher. Stripped in clean.
    if (CRYPTO_BUILD) {
      this.add
        .text(cx, GAME_HEIGHT * 0.86, 'Crypto build: scores settle to a signed reward voucher.', {
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
      p.img.setScale(idx === i ? 0.74 : 0.62);
      p.img.setAlpha(idx === i ? 1 : 0.6);
      p.label.setColor(idx === i ? '#cfe0ff' : '#9fb6e8');
    });
  }
}
