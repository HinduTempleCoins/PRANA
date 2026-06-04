#!/usr/bin/env node
// export-full.mjs — dump the ENTIRE conversation, verbatim, to one markdown file.
// Unlike brain-continue.mjs (which keeps only the last ~25 exchanges), this keeps
// EVERY user + assistant text turn, untruncated. The word-for-word archive.
//
//   node tools/brain/export-full.mjs
//   TRANSCRIPTS=/path OUT=/path/full-conversation.md node tools/brain/export-full.mjs

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const TRANSCRIPTS = process.env.TRANSCRIPTS
  || join(homedir(), '.claude', 'projects', '-workspaces-PRANA');
const OUT = process.env.OUT
  || join(process.cwd(), 'tools', 'brain', 'state', 'full-conversation.md');

function newest(dir) {
  const fs = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  if (!fs.length) return null;
  return fs.map(f => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
           .sort((a, b) => b.m - a.m)[0].f;
}
function textOf(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(b => b && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text).join('\n').trim();
}
function toolResultOnly(c) {
  return Array.isArray(c) && c.length > 0 && c.every(b => b && b.type === 'tool_result');
}
function injected(t) {
  const s = t.trimStart();
  return s.startsWith('<system-reminder>') || s.startsWith('<command-')
      || s.startsWith('Caveat:') || s.startsWith('[SYSTEM NOTIFICATION');
}

const file = newest(TRANSCRIPTS);
if (!file) { console.error('no transcript'); process.exit(0); }
const lines = readFileSync(file, 'utf8').split('\n');

const out = [
  '# PRANA — full conversation archive (verbatim)',
  `_Source transcript: ${file}_`,
  `_Exported mechanically; every user + assistant text turn, untruncated._`,
  '', '---', '',
];
let n = 0;
for (const line of lines) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.isMeta) continue;
  const m = o.message; if (!m || !m.content) continue;
  const ts = o.timestamp || '';
  if (o.type === 'user' && m.role === 'user') {
    if (toolResultOnly(m.content)) continue;
    const t = textOf(m.content);
    if (!t || injected(t)) continue;
    out.push(`## 🧑 USER  _(${ts})_`, '', t, '', '---', ''); n++;
  } else if (o.type === 'assistant' && m.role === 'assistant') {
    const t = textOf(m.content);
    if (!t) continue;
    out.push(`## 🤖 CLAUDE  _(${ts})_`, '', t, '', '---', ''); n++;
  }
}
out.push(`_Total turns: ${n}_`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out.join('\n'));
console.log(`wrote ${OUT}  (${n} turns)`);
