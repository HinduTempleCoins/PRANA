// Track model: serialization, canonical JSON, content hashing, point simplification, and
// localStorage persistence. The canonical JSON + hash are the settled on-chain format (see
// the TrackRegistry interface documented in the README) — DO NOT change the field order or
// number formatting without bumping `v` and updating the contract spec.

import { keccak256Hex } from '../lib/keccak.js';
import { LINE_NORMAL, LINE_BOOST } from './physics.js';

export const TRACK_VERSION = 1;

// Round a coordinate to an integer for the canonical form. Tracks are drawn in whole pixels;
// integers make the JSON compact AND make the hash insensitive to sub-pixel float noise.
const ci = (n) => Math.round(n);

// --- canonical serialization ------------------------------------------------------------ //
// Canonical shape (compact, deterministic key/element order):
//   { "v":1, "lines":[[x1,y1,x2,y2,"type"],...], "start":[x,y], "finish":[x,y] }
// CANONICAL = "exactly these bytes for this content". CRUCIAL NUANCE: we do NOT sort lines.
// Draw order IS content here — two tracks with the same segments in a different order are
// DIFFERENT tracks (they ride identically, but a registry treats authorship/identity by the
// bytes the author committed). The tests assert reordering changes the hash; that is by
// design, and it is documented for the contract so nobody "normalizes" by sorting later.
export function toCanonicalJSON(track) {
  const lines = (track.lines || []).map((l) => {
    const [x1, y1, x2, y2, type] = l;
    const t = type === LINE_BOOST ? LINE_BOOST : LINE_NORMAL;
    return [ci(x1), ci(y1), ci(x2), ci(y2), t];
  });
  const start = track.start ? [ci(track.start[0]), ci(track.start[1])] : null;
  const finish = track.finish ? [ci(track.finish[0]), ci(track.finish[1])] : null;

  // Build the string by hand so key order and array formatting are byte-deterministic and
  // independent of JS engine object-key ordering quirks.
  const linesStr = lines
    .map(([a, b, c, d, t]) => `[${a},${b},${c},${d},"${t}"]`)
    .join(',');
  const startStr = start ? `[${start[0]},${start[1]}]` : 'null';
  const finishStr = finish ? `[${finish[0]},${finish[1]}]` : 'null';
  return `{"v":${TRACK_VERSION},"lines":[${linesStr}],"start":${startStr},"finish":${finishStr}}`;
}

// Parse a canonical (or compatible) JSON string/object back into a track object.
export function fromCanonicalJSON(jsonOrObj) {
  const obj = typeof jsonOrObj === 'string' ? JSON.parse(jsonOrObj) : jsonOrObj;
  return {
    v: obj.v ?? TRACK_VERSION,
    lines: (obj.lines || []).map((l) => [l[0], l[1], l[2], l[3], l[4] === LINE_BOOST ? LINE_BOOST : LINE_NORMAL]),
    start: obj.start ? [obj.start[0], obj.start[1]] : null,
    finish: obj.finish ? [obj.finish[0], obj.finish[1]] : null,
  };
}

// trackHash = keccak256(abi.encodePacked(canonicalJsonString)).
// abi.encodePacked of a lone string is just its UTF-8 bytes, so hashing the canonical
// string's UTF-8 bytes is byte-identical to what the TrackRegistry contract would compute.
export function trackHash(track) {
  return keccak256Hex(toCanonicalJSON(track));
}

// --- point simplification (used while drawing) ------------------------------------------ //
// Drop points closer than `minDist` to the previously kept point. This is the cheap
// distance-threshold simplification done live during a pointer drag (NOT Douglas-Peucker —
// we want O(n) streaming and predictable segment density). Always keeps first + last.
export function simplifyPoints(points, minDist) {
  if (points.length <= 2) return points.slice();
  const min2 = minDist * minDist;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    const dx = points[i][0] - last[0];
    const dy = points[i][1] - last[1];
    if (dx * dx + dy * dy >= min2) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// Turn a simplified point list into track line segments of a given type.
export function pointsToLines(points, type = LINE_NORMAL) {
  const lines = [];
  for (let i = 0; i < points.length - 1; i++) {
    lines.push([points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], type]);
  }
  return lines;
}

// --- empty track helper ----------------------------------------------------------------- //
export function emptyTrack() {
  return { v: TRACK_VERSION, lines: [], start: null, finish: null };
}

// --- localStorage persistence ----------------------------------------------------------- //
const LS_PREFIX = 'prana.leyrider.track.';
const LS_BEST_PREFIX = 'prana.leyrider.best.';

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// Save a named track. Stored as the canonical JSON string so what we hash == what we persist.
export function saveTrack(name, track) {
  const ls = safeStorage();
  if (!ls) return false;
  ls.setItem(LS_PREFIX + name, toCanonicalJSON(track));
  return true;
}

export function loadTrack(name) {
  const ls = safeStorage();
  if (!ls) return null;
  const raw = ls.getItem(LS_PREFIX + name);
  return raw ? fromCanonicalJSON(raw) : null;
}

export function listTracks() {
  const ls = safeStorage();
  if (!ls) return [];
  const names = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && k.startsWith(LS_PREFIX)) names.push(k.slice(LS_PREFIX.length));
  }
  return names.sort();
}

export function deleteTrack(name) {
  const ls = safeStorage();
  if (!ls) return;
  ls.removeItem(LS_PREFIX + name);
}

// Best time per track, keyed by trackHash so it survives renames and follows the content.
export function getBestTime(hash) {
  const ls = safeStorage();
  if (!ls) return null;
  const raw = ls.getItem(LS_BEST_PREFIX + hash);
  return raw ? Number(raw) : null;
}

export function recordBestTime(hash, timeMs) {
  const ls = safeStorage();
  if (!ls) return timeMs;
  const prev = getBestTime(hash);
  if (prev == null || timeMs < prev) {
    ls.setItem(LS_BEST_PREFIX + hash, String(timeMs));
    return timeMs;
  }
  return prev;
}

// Export / import (the in-memory object <-> canonical string used by the UI buttons).
export const exportTrack = toCanonicalJSON;
export const importTrack = fromCanonicalJSON;
