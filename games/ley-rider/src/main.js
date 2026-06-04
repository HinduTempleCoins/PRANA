import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from './config.js';
import BootScene from './scenes/BootScene.js';
import MenuScene from './scenes/MenuScene.js';
import TrackScene from './scenes/TrackScene.js';

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#070b16',
  pixelArt: false,
  scene: [BootScene, MenuScene, TrackScene],
};

// eslint-disable-next-line no-new
new Phaser.Game(config);
