// keccak256 — minimal pure-JS implementation (no dependencies).
//
// WHY VENDORED: js-sha3 is NOT present in the dependency tree of phaser/vite (checked), and
// we deliberately ship zero runtime crypto/abi libraries in the game bundle. This is ~120
// lines of standard Keccak-f[1600] and produces output byte-for-byte identical to
// Solidity's keccak256 (the FIPS-202 Keccak with the original 0x01 padding, NOT SHA3's
// 0x06 padding — this is the distinction that matters for on-chain compatibility).
//
// ATTRIBUTION: algorithm per the Keccak reference (Bertoni, Daemen, Peeters, Van Assche,
// keccak.team). This implementation is original/standalone, structured after the public
// FIPS-202 round structure; it intentionally mirrors the behaviour of the well-known
// `js-sha3` package (emn178, MIT) so results match it exactly. Verified against published
// test vectors in test/keccak.test.mjs.
//
// Solidity equivalence:
//   keccak256(abi.encodePacked(someString))  ===  keccak256Hex(utf8Bytes(someString))
// abi.encodePacked of a single string is just that string's UTF-8 bytes (no length prefix,
// no padding), so hashing the UTF-8 bytes of our canonical JSON string is exactly what the
// contract would hash.

// Round constants (RC) for Keccak-f[1600], as [low32, high32] pairs (little-endian lanes).
const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000],
  [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000],
  [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000],
  [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000],
  [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000],
  [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000],
  [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];

// Rotation offsets for the rho step, in lane order.
const ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25,
  39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

// 64-bit left-rotate on a [low, high] lane.
function rotl64(lane, n) {
  const lo = lane[0] >>> 0;
  const hi = lane[1] >>> 0;
  if (n === 0) return [lo, hi];
  if (n === 32) return [hi, lo];
  if (n < 32) {
    const nlo = (lo << n) | (hi >>> (32 - n));
    const nhi = (hi << n) | (lo >>> (32 - n));
    return [nlo >>> 0, nhi >>> 0];
  }
  const m = n - 32;
  const nlo = (hi << m) | (lo >>> (32 - m));
  const nhi = (lo << m) | (hi >>> (32 - m));
  return [nlo >>> 0, nhi >>> 0];
}

const x64 = (a, b) => [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];

// Keccak-f[1600] permutation over a state of 25 lanes ([low, high] each).
function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    // theta
    const C = new Array(5);
    for (let x = 0; x < 5; x++) {
      C[x] = x64(x64(x64(x64(s[x], s[x + 5]), s[x + 10]), s[x + 15]), s[x + 20]);
    }
    const D = new Array(5);
    for (let x = 0; x < 5; x++) {
      const r = rotl64(C[(x + 1) % 5], 1);
      D[x] = x64(C[(x + 4) % 5], r);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) s[x + 5 * y] = x64(s[x + 5 * y], D[x]);
    }

    // rho + pi
    const B = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const idx = x + 5 * y;
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[idx], ROT[idx]);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const a = B[x + 5 * y];
        const b = B[((x + 1) % 5) + 5 * y];
        const c = B[((x + 2) % 5) + 5 * y];
        s[x + 5 * y] = [
          (a[0] ^ (~b[0] & c[0])) >>> 0,
          (a[1] ^ (~b[1] & c[1])) >>> 0,
        ];
      }
    }

    // iota
    s[0] = x64(s[0], RC[round]);
  }
  return s;
}

// keccak256 of a byte array (Uint8Array | number[]) -> 32-byte Uint8Array.
export function keccak256Bytes(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const rate = 136; // 1088-bit rate for keccak256 (1600 - 2*256 capacity), in bytes
  const state = new Array(25);
  for (let i = 0; i < 25; i++) state[i] = [0, 0];

  // Absorb.
  let offset = 0;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01; // Keccak (pre-SHA3) domain/padding start
  padded[padded.length - 1] ^= 0x80; // pad10*1 end bit

  while (offset < padded.length) {
    for (let i = 0; i < rate / 8; i++) {
      const j = offset + i * 8;
      const lo =
        (padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24)) >>> 0;
      const hi =
        (padded[j + 4] | (padded[j + 5] << 8) | (padded[j + 6] << 16) | (padded[j + 7] << 24)) >>> 0;
      state[i] = x64(state[i], [lo, hi]);
    }
    keccakF(state);
    offset += rate;
  }

  // Squeeze 32 bytes (fits in the first 4 lanes of the rate).
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const [lo, hi] = state[i];
    out[i * 8 + 0] = lo & 0xff;
    out[i * 8 + 1] = (lo >>> 8) & 0xff;
    out[i * 8 + 2] = (lo >>> 16) & 0xff;
    out[i * 8 + 3] = (lo >>> 24) & 0xff;
    out[i * 8 + 4] = hi & 0xff;
    out[i * 8 + 5] = (hi >>> 8) & 0xff;
    out[i * 8 + 6] = (hi >>> 16) & 0xff;
    out[i * 8 + 7] = (hi >>> 24) & 0xff;
  }
  return out;
}

// UTF-8 encode a string to bytes (uses TextEncoder where available; tiny fallback otherwise).
export function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  // Minimal fallback for environments without TextEncoder.
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      c = 0x10000 + ((c & 0x3ff) << 10) + (str.charCodeAt(++i) & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

const HEX = '0123456789abcdef';
export function toHex(bytes) {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) {
    s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return s;
}

// keccak256 of a UTF-8 string -> 0x-prefixed 32-byte hex (Solidity keccak256 of the same bytes).
export function keccak256Hex(str) {
  return toHex(keccak256Bytes(utf8Bytes(str)));
}
