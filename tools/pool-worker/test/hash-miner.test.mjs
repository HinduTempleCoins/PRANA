// Tests for the real HASH lane: supervising a miner the contributor already has.
//
// The part that rots is the output parsing — miners reformat their logs between versions
// and a pattern that stops matching turns a working GPU into a silently uncredited one.
// So these pin real captured output lines from each supported miner. No process is
// spawned: spawnFn is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseMinerLine, minerArgs, HashMiner } from '../src/hash-miner.mjs';

const ADDR = '0xd0f70C197138f70cDB90317c07feecCE6A2bF2ef';

test('accepted-share lines from every supported miner are recognised', () => {
  const accepted = [
    'SUBMIT RESPONSE <- {"result":true,"id":3}',                       // testminer
    '[12:01:33] Accepted    #42  GPU0  23.4 MH/s',                     // lolMiner
    '20260917 12:01:33 OK 42/42 - 23.41 MH/s, 0.12s',                  // T-Rex
    'Share accepted (34 ms)',                                          // GMiner
    '[2026-09-17 12:01:33] Accepted 42/42 (100%) diff 2147',           // SRBMiner
  ];
  for (const line of accepted) {
    assert.equal(parseMinerLine(line).accepted, true, `should accept: ${line}`);
    assert.equal(parseMinerLine(line).rejected, false, `should not reject: ${line}`);
  }
});

// A rejection line usually carries a running "accepted" tally too. If the accept pattern
// wins, every rejected share is credited as accepted and the worker over-reports.
test('a rejection is never counted as an acceptance', () => {
  const rejections = [
    '[12:01:33] Rejected #43  GPU0  (accepted 42, rejected 1)',
    'Share rejected: stale share',
    '20260917 12:01:33 Invalid share 43/44',
  ];
  for (const line of rejections) {
    const r = parseMinerLine(line);
    assert.equal(r.rejected, true, `should reject: ${line}`);
    assert.equal(r.accepted, false, `must not double-count: ${line}`);
  }
});

test('hashrate is parsed across units and thousands separators', () => {
  assert.equal(parseMinerLine('speed 980 H/s').hashrate, 980);
  assert.equal(parseMinerLine('speed 23.4 MH/s').hashrate, 23_400_000);
  assert.equal(parseMinerLine('speed 1,024 kH/s').hashrate, 1_024_000);
  assert.equal(parseMinerLine('speed 1.5 GH/s').hashrate, 1_500_000_000);
  assert.equal(parseMinerLine('no rate here').hashrate, null);
});

test('argv is built correctly for each miner', () => {
  const base = { binary: '/usr/bin/m', pool: 'pool.soapbox.community:3333', workerAddr: ADDR, workerName: 'rig1' };
  assert.deepEqual(minerArgs({ ...base, kind: 'lolminer' }),
    ['/usr/bin/m', '--algo', 'ETCHASH', '--pool', 'stratum+tcp://pool.soapbox.community:3333', '--user', `${ADDR}.rig1`]);
  assert.deepEqual(minerArgs({ ...base, kind: 'trex' }),
    ['/usr/bin/m', '-a', 'etchash', '-o', 'stratum+tcp://pool.soapbox.community:3333', '-u', ADDR, '-w', 'rig1']);
  assert.deepEqual(minerArgs({ ...base, kind: 'testminer', extraArgs: ['/dag'] }),
    ['/usr/bin/m', 'pool.soapbox.community:3333', ADDR, '/dag']);
  assert.throws(() => minerArgs({ ...base, kind: 'nope' }), /unknown miner kind/);
});

test('custom miners substitute the pool and address into operator-supplied args', () => {
  const argv = minerArgs({
    binary: '/opt/x', kind: 'custom', pool: 'p:3333', workerAddr: ADDR,
    extraArgs: ['--url', 'stratum+tcp://{POOL}', '--wallet', '{ADDR}'],
  });
  assert.deepEqual(argv, ['/opt/x', '--url', 'stratum+tcp://p:3333', '--wallet', ADDR]);
});

/** A fake child process whose stdout we drive by hand. */
function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = (sig) => { p.killedWith = sig; p.emit('exit', 0, sig); return true; };
  return p;
}

test('shares emitted from stdout carry the coordinator submission shape', () => {
  const proc = fakeProc();
  const m = new HashMiner({
    binary: '/usr/bin/m', kind: 'lolminer', pool: 'p:3333', workerAddr: ADDR,
    difficulty: 2147, spawnFn: () => proc,
  });
  const shares = [];
  m.on('share', (s) => shares.push(s));
  m.start();

  proc.stdout.emit('data', '[12:00:01] Accepted    #1  GPU0  23.4 MH/s\n');
  assert.equal(shares.length, 1);
  assert.equal(shares[0].worker, ADDR);
  assert.equal(shares[0].lane, 'HASH');
  assert.equal(shares[0].difficulty, 2147);
  assert.equal(shares[0].meetsTarget, true);
  assert.equal(m.stats().hashrate, 23_400_000);
});

// Miner output arrives in arbitrary chunks. A share line split across two reads would be
// dropped, which undercounts exactly when the card is busiest and the writes are largest.
test('a share line split across two chunks is still counted once', () => {
  const proc = fakeProc();
  const m = new HashMiner({ binary: '/m', kind: 'lolminer', pool: 'p:3333', workerAddr: ADDR, spawnFn: () => proc });
  let n = 0;
  m.on('share', () => n++);
  m.start();

  proc.stdout.emit('data', '[12:00:01] Accep');
  assert.equal(n, 0, 'must not fire on a partial line');
  proc.stdout.emit('data', 'ted #1 GPU0\n');
  assert.equal(n, 1);
  proc.stdout.emit('data', '[12:00:02] Accepted #2\n[12:00:03] Accepted #3\n');
  assert.equal(n, 3, 'two complete lines in one chunk');
});

test('shares on stderr count — several miners log there', () => {
  const proc = fakeProc();
  const m = new HashMiner({ binary: '/m', kind: 'gminer', pool: 'p:3333', workerAddr: ADDR, spawnFn: () => proc });
  let n = 0;
  m.on('share', () => n++);
  m.start();
  proc.stderr.emit('data', 'Share accepted (34 ms)\n');
  assert.equal(n, 1);
});

// The switcher can ask for HASH on consecutive ticks. Spawning a second miner would double
// the card's load and halve everyone's rate.
test('start is idempotent and stop releases the card', async () => {
  let spawns = 0;
  const proc = fakeProc();
  const m = new HashMiner({ binary: '/m', kind: 'lolminer', pool: 'p:3333', workerAddr: ADDR,
    spawnFn: () => { spawns++; return proc; } });
  m.start();
  m.start();
  m.start();
  assert.equal(spawns, 1);
  assert.equal(m.running, true);

  await m.stop();
  assert.equal(proc.killedWith, 'SIGTERM', 'must ask politely so the pool session closes');
  assert.equal(m.running, false);
  await m.stop(); // stopping a stopped miner is not an error
});

// A card that is plainly working but never matches an accept pattern means the patterns
// need a case for that miner. Reporting it as zero hashrate would send someone hunting a
// hardware fault that does not exist.
test('undercounting is reported rather than looking like an idle card', () => {
  const proc = fakeProc();
  const m = new HashMiner({ binary: '/m', kind: 'custom', pool: 'p:3333', workerAddr: ADDR, spawnFn: () => proc });
  m.start();
  m.startedAt = Date.now() - 700_000; // 11+ minutes in
  proc.stdout.emit('data', 'mining at 45.0 MH/s\n');
  const s = m.stats();
  assert.equal(s.hashrate, 45_000_000);
  assert.equal(s.accepted, 0);
  assert.equal(s.undercounting, true);
});

test('a miner that dies is reported and leaves nothing running', () => {
  const proc = fakeProc();
  const m = new HashMiner({ binary: '/m', kind: 'lolminer', pool: 'p:3333', workerAddr: ADDR, spawnFn: () => proc });
  let exit = null;
  m.on('exit', (e) => { exit = e; });
  m.start();
  proc.emit('exit', 1, null);
  assert.deepEqual(exit, { code: 1, signal: null });
  assert.equal(m.running, false, 'a dead miner must not look running, or the switcher never restarts it');
});
