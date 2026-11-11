// A CLI export (docs/data/<pipeline>_cli.json, made from the real argparse) as a checker for command lines.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const B = createRequire(import.meta.url)(path.join(root, 'docs/assets/builder.js'));
export const readJson = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'));

export const findSub = (cli, name) => cli.subcommands[name] || Object.values(cli.subcommands).find((s) => (s.aliases || []).includes(name));
export const optionOf = (sub, flag) => sub.options.find((o) => o.flags.includes(flag));
const takesValue = (o) => ['store', 'append'].includes(o.action);

// problems of one command line against the CLI named by its first word (clis: {'lab-x': export}); other commands are not checked
export function problems(clis, line) {
  const words = B.shellWords(line);
  const cli = clis[words[0]?.v];
  if (!cli) return [];
  let sub = findSub(cli, words[1]?.v);
  if (!sub) return [`unknown subcommand "${words[1]?.v}" in: ${line}`];
  let i = 2;
  if (sub.subcommands) {
    sub = sub.subcommands[words[2]?.v];
    if (!sub) return [`unknown ${words[1].v} subcommand in: ${line}`];
    i = 3;
  }
  const out = [], positionals = sub.options.filter((o) => !o.flags[0].startsWith('-'));
  let seen = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (!w.quoted && w.v.startsWith('--')) {
      const opt = optionOf(sub, w.v);
      if (!opt) { out.push(`unknown flag ${w.v} in: ${line}`); continue; }
      if (takesValue(opt)) {
        const val = words[++i];
        if (!val) out.push(`${w.v} needs a value in: ${line}`);
        else if (opt.choices && !opt.choices.includes(val.v)) out.push(`${w.v} ${val.v} not in ${opt.choices} in: ${line}`);
      }
    } else seen++;
  }
  const needed = positionals.filter((o) => o.required).length;
  if (seen < needed) out.push(`${needed} positional argument(s) needed, got ${seen} in: ${line}`);
  if (!positionals.some((o) => o.nargs === '+') && seen > positionals.length) out.push(`too many positional arguments in: ${line}`);
  for (const o of sub.options) if (o.required && o.flags[0].startsWith('-') && !words.some((w) => w.v === o.flags[0])) {
    out.push(`required ${o.flags[0]} missing in: ${line}`);
  }
  return out;
}
