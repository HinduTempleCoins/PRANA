import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from './config.js';
import BootScene from './scenes/BootScene.js';
import MenuScene from './scenes/MenuScene.js';
import PlayScene from './scenes/PlayScene.js';

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#0a0e1a',
  pixelArt: false,
  scene: [BootScene, MenuScene, PlayScene],
};

// eslint-disable-next-line no-new
new Phaser.Game(config);
