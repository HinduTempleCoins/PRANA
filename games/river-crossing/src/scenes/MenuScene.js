import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, CRYPTO_BUILD } from '../config.js';
import { hexToInt } from '../data/skins.js';

// Menu: title, skin-slot selector (palette + shape preview), and play.
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;
    this.skins = this.registry.get('skins') || [];
    this.selected = this.registry.get('selectedSkinIndex') ?? 0;

    this.add
      .text(cx, GAME_HEIGHT * 0.14, 'RIVER CROSSING', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: '#bff0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, GAME_HEIGHT * 0.24, 'Dodge the traffic. Ride the river. Fill the far bank.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        color: '#6f8fc8',
      })
      .setOrigin(0.5);

    // --- skin slots ------------------------------------------------------------------ //
    this.add
      .text(cx, GAME_HEIGHT * 0.38, 'HOPPER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        color: '#54689a',
      })
      .setOrigin(0.5);

    this.previews = [];
    const n = this.skins.length;
    const spacing = 92;
    const startX = cx - ((n - 1) * spacing) / 2;
    this.skins.forEach((skin, i) => {
      const x = startX + i * spacing;
      const y = GAME_HEIGHT * 0.5;
      const swatch = this.add
        .image(x, y, `hopper_${skin.itemId}_${skin.shape}`)
        .setScale(1.2)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, y + 38, skin.name, {
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
      .text(cx, GAME_HEIGHT * 0.72, '▶  PLAY', {
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
      .text(cx, GAME_HEIGHT * 0.85, 'Arrows / WASD to hop · or swipe a direction', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#54689a',
      })
      .setOrigin(0.5);

    // In the crypto build, hint that runs settle to a reward voucher. Stripped in clean.
    if (CRYPTO_BUILD) {
      this.add
        .text(cx, GAME_HEIGHT * 0.92, 'Crypto build: scores settle to a signed reward voucher.', {
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
      p.swatch.setScale(idx === i ? 1.5 : 1.2);
      p.swatch.setAlpha(idx === i ? 1 : 0.6);
      p.label.setColor(idx === i ? '#cfe0ff' : '#9fb6e8');
    });
  }
}
