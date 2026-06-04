#!/usr/bin/env node
// brain-continue.mjs — the MECHANICAL maintainer for the PRANA "Continue" brain.
//
// It reads the newest Claude Code transcript for this repo and writes three
// plain files into state/. It ONLY copies real content (verbatim user words,
// the list of files changed, recent exchanges). It does NOT interpret — so a
// weak/automated run can never write something wrong into memory. The rich,
// curated handoff is written by the SMART layer (Claude) at checkpoints; this
// script guarantees a serviceable floor that always exists.
//
// Usage:
//   node brain-continue.mjs                 # uses default paths below
//   TRANSCRIPTS=/path STATE=/path node brain-continue.mjs
//
// Design principle: mechanical layer can't corrupt memory; the last ~25
// exchanges always survive so a fresh session never starts from zero.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TRANSCRIPTS = process.env.TRANSCRIPTS
  || join(homedir(), '.claude', 'projects', '-workspaces-PRANA');
const STATE = process.env.STATE
  || join(process.cwd(), 'tools', 'brain', 'state');
const TAIL_EXCHANGES = Number(process.env.TAIL_EXCHANGES || 25);

mkdirSync(STATE, { recursive: true });

// ---- find newest transcript ------------------------------------------------
function newestTranscript(dir) {
  let files;
  try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); }
  catch { return null; }
  if (!files.length) return null;
  return files
    .map(f => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0].f;
}

// ---- helpers to pull plain text out of a message.content -------------------
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
}
function isToolResultOnly(content) {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && content.every(b => b && b.type === 'tool_result');
}
// strip harness-injected wrappers so we keep the human's actual words
function looksInjected(t) {
  const s = t.trimStart();
  return s.startsWith('<system-reminder>')
    || s.startsWith('<command-')
    || s.startsWith('Caveat:')
    || s.startsWith('[SYSTEM NOTIFICATION');
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const file = newestTranscript(TRANSCRIPTS);
if (!file) {
  console.error(`brain-continue: no transcript in ${TRANSCRIPTS}`);
  process.exit(0); // not fatal — nothing to do yet
}

const lines = readFileSync(file, 'utf8').split('\n');
const turns = [];      // {role:'user'|'assistant', text, ts}
const changes = [];    // {ts, tool, path}
let lastUserText = '';
let lastUserTs = '';
let lastAssistantText = '';

for (const line of lines) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.isMeta) continue;
  const msg = o.message;
  if (!msg || !msg.content) continue;
  const ts = o.timestamp || '';

  if (o.type === 'user' && msg.role === 'user') {
    if (isToolResultOnly(msg.content)) continue;     // tool output, not the human
    const t = textOf(msg.content);
    if (!t || looksInjected(t)) continue;
    turns.push({ role: 'user', text: t, ts });
    lastUserText = t; lastUserTs = ts;
  } else if (o.type === 'assistant' && msg.role === 'assistant') {
    const t = textOf(msg.content);
    if (t) { turns.push({ role: 'assistant', text: t, ts }); lastAssistantText = t; }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) {
          const p = b.input && (b.input.file_path || b.input.notebook_path);
          if (p) changes.push({ ts, tool: b.name, path: p });
        }
      }
    }
  }
}

// ---- recent-tail.md : last ~N exchanges verbatim ---------------------------
const tail = turns.slice(-TAIL_EXCHANGES * 2); // a user+assistant pair ≈ 1 exchange
const tailMd = [
  '# recent-tail.md',
  `_Last ~${TAIL_EXCHANGES} exchanges, verbatim. Mechanical capture — the safety net._`,
  `_Source: ${file}_`, '',
  ...tail.map(t => {
    const who = t.role === 'user' ? '🧑 USER' : '🤖 CLAUDE';
    const when = t.ts ? ` _(${t.ts})_` : '';
    return `### ${who}${when}\n\n${t.text}\n`;
  }),
].join('\n');
writeFileSync(join(STATE, 'recent-tail.md'), tailMd);

// ---- code-log.md : running log of file changes -----------------------------
const codeMd = [
  '# code-log.md',
  '_Files changed this session (mechanical capture from Edit/Write tool calls)._', '',
  ...(changes.length
    ? changes.map(c => `- \`${c.ts}\`  **${c.tool}**  ${c.path}`)
    : ['- (no file edits captured yet)']),
].join('\n');
writeFileSync(join(STATE, 'code-log.md'), codeMd);

// ---- CONTINUE.md : the mechanical handoff floor ----------------------------
// Mechanical = copy, don't interpret. "What we're doing" = the user's last
// verbatim words. PENDING = the assistant's last verbatim message (usually the
// open question / proposed next step). The smart layer overwrites this with a
// curated handoff at "goodnight".
const uniqPaths = [...new Set(changes.map(c => c.path))];
const continueMd = [
  '# CONTINUE.md — PRANA handoff',
  '_Mechanical floor written by brain-continue.mjs. The smart layer (Claude) replaces',
  ' this with a curated handoff at checkpoints. If you are a fresh session: read this,',
  ' then recent-tail.md, then code-log.md, then resume._', '',
  `**Repo:** PRANA   **Transcript:** ${file.split('/').pop()}`,
  `**Captured:** ${lastUserTs || '(unknown)'}`, '',
  '## ▶ What we are doing right now (user\'s last words, verbatim)', '',
  '> ' + (lastUserText || '(none captured)').split('\n').join('\n> '), '',
  '## ⏳ PENDING (Claude\'s last message — usually the open question / next step)', '',
  (lastAssistantText
    ? lastAssistantText.split('\n').slice(0, 40).map(l => '> ' + l).join('\n')
    : '> (none captured)'), '',
  '## 🛠 Files touched this session', '',
  ...(uniqPaths.length ? uniqPaths.map(p => `- ${p}`) : ['- (none)']), '',
  '## 📍 Where to look', '',
  '- Full architecture + live build state: `CLAUDE.md` (repo root)',
  '- Verbatim recent exchanges: `state/recent-tail.md`',
  '- Code change log: `state/code-log.md`',
].join('\n');
writeFileSync(join(STATE, 'CONTINUE.md'), continueMd);

console.log(`brain-continue: wrote state to ${STATE}`);
console.log(`  exchanges captured: ${turns.length}, file-changes: ${changes.length}`);
