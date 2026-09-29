#!/usr/bin/env node
// Counts tagged evidence across interview notes, as a map of where to read.
//
//   node docs/research/tally.mjs docs/research/notes/*.md
//
// Reads lines shaped like the notes template's evidence lines:
//   - [D1] #theme/dashboards-first "quote or paraphrase"
//   - [D2] saw: marked the finding as noise
// and prints, per decision, each theme with how many interviews raised it
// (a theme said twice in one interview counts once) and every quote.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node docs/research/tally.mjs <notes.md>...');
  process.exit(1);
}

const LINE = /^\s*-\s*\[(D\d+)\]\s*(?:#theme\/([\w-]+))?\s*(.*)$/;
/** decision -> theme -> { interviews: Set, quotes: [] } */
const tally = new Map();
let untagged = 0;

for (const file of files) {
  const interview = basename(file, '.md');
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, decision, theme = '(no theme)', text] = match;
    if (theme === '(no theme)') untagged += 1;
    const themes = tally.get(decision) ?? new Map();
    tally.set(decision, themes);
    const entry = themes.get(theme) ?? { interviews: new Set(), quotes: [] };
    themes.set(theme, entry);
    entry.interviews.add(interview);
    entry.quotes.push(`${text.trim()} (${interview})`);
  }
}

const byNumber = (a, b) => Number(a.slice(1)) - Number(b.slice(1));
for (const decision of [...tally.keys()].sort(byNumber)) {
  const themes = [...tally.get(decision)].sort(([, a], [, b]) => b.interviews.size - a.interviews.size);
  const interviews = new Set(themes.flatMap(([, entry]) => [...entry.interviews]));
  console.log(`\n## ${decision} (${interviews.size} of ${files.length} interviews)\n`);
  for (const [theme, entry] of themes) {
    console.log(`- **${theme}**: ${entry.interviews.size} ${entry.interviews.size === 1 ? 'interview' : 'interviews'}`);
    for (const quote of entry.quotes) console.log(`  - ${quote}`);
  }
}

if (untagged > 0) console.log(`\n${untagged} evidence lines have no #theme/ tag yet.`);
