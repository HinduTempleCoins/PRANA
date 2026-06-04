import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, CRYPTO_BUILD } from '../config.js';

// Menu: title, skin-slot selector (spirit + lantern preview), and play.
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;
    this.skins = this.registry.get('skins') || [];
    this.selected = this.registry.get('selectedSkinIndex') ?? 0;

    this.add
      .text(cx, GAME_HEIGHT * 0.12, 'SPIRIT BOP', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '38px',
        color: '#d6bfff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, GAME_HEIGHT * 0.2, 'Bop the spirits. Spare the lantern. Keep the combo.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#8f6fc8',
      })
      .setOrigin(0.5);

    // --- skin slots ------------------------------------------------------------------ //
    this.add
      .text(cx, GAME_HEIGHT * 0.33, 'SPIRIT', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#6a548a',
      })
      .setOrigin(0.5);

    this.previews = [];
    const n = this.skins.length;
    const spacing = 86;
    const startX = cx - ((n - 1) * spacing) / 2;
    this.skins.forEach((skin, i) => {
      const x = startX + i * spacing;
      const y = GAME_HEIGHT * 0.44;
      const swatch = this.add
        .image(x, y, `spirit_${skin.itemId}_${skin.face}`)
        .setScale(0.62)
        .setInteractive({ useHandCursor: true });
      // little lantern hint next to it (the one NOT to bop)
      this.add.image(x + 24, y + 16, `lantern_${skin.itemId}`).setScale(0.32).setAlpha(0.85);
      const label = this.add
        .text(x, y + 40, skin.name, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '10px',
          color: '#b69fe8',
          align: 'center',
          wordWrap: { width: spacing - 6 },
        })
        .setOrigin(0.5);
      swatch.on('pointerup', () => this.selectSkin(i));
      this.previews.push({ swatch, label });
    });
    this.selectSkin(this.selected);

    // --- play button ----------------------------------------------------------------- //
    const btn = this.add
      .text(cx, GAME_HEIGHT * 0.68, '▶  PLAY', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#05080f',
        backgroundColor: '#b07fff',
        padding: { x: 24, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#cbaaff' }));
    btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#b07fff' }));
    btn.on('pointerup', () => this.scene.start('Play'));

    this.add
      .text(cx, GAME_HEIGHT * 0.8, 'Tap / click a spirit to bop · 60-second round', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#6a548a',
      })
      .setOrigin(0.5);

    // In the crypto build, hint that runs settle to a reward voucher. Stripped in clean.
    if (CRYPTO_BUILD) {
      this.add
        .text(cx, GAME_HEIGHT * 0.88, 'Crypto build: scores settle to a signed reward voucher.', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '11px',
          color: '#5a3f8a',
        })
        .setOrigin(0.5);
    }
  }

  selectSkin(i) {
    this.selected = i;
    this.registry.set('selectedSkinIndex', i);
    this.previews.forEach((p, idx) => {
      p.swatch.setScale(idx === i ? 0.82 : 0.62);
      p.swatch.setAlpha(idx === i ? 1 : 0.6);
      p.label.setColor(idx === i ? '#e6d6ff' : '#b69fe8');
    });
  }
}
