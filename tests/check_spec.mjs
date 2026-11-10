// Run with: node --test tests/
// 1. every subcommand and flag the page can emit exists in docs/data/rnaseq_cli.json (exported from the real argparse);
// 2. the command assembly: quoting, and which lines appear for which inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = createRequire(import.meta.url)(path.join(root, 'docs/assets/builder.js'));
const spec = JSON.parse(readFileSync(path.join(root, 'docs/data/rnaseq.json'), 'utf8'));
const cli = JSON.parse(readFileSync(path.join(root, 'docs/data/rnaseq_cli.json'), 'utf8'));
// every section.key the pipeline's config schema accepts, with its type (README: how it is generated)
const cfgKeys = JSON.parse(readFileSync(path.join(root, 'docs/data/rnaseq_config_keys.json'), 'utf8')).keys;

// ---------------------------------------------------------------- the CLI model
const subs = cli.subcommands;
function findSub(name) {                       // a subcommand or one of its aliases
  if (subs[name]) return subs[name];
  return Object.values(subs).find((s) => (s.aliases || []).includes(name));
}
function optionOf(sub, flag) {
  return sub.options.find((o) => o.flags.includes(flag));
}
const takesValue = (o) => ['store', 'append'].includes(o.action);

// check one command (shell words) against the CLI; returns a list of problems
function problems(line) {
  const words = B.shellWords(line);
  const out = [];
  if (words[0]?.v !== 'lab-rnaseq') return out;          // conda, git, cd ...
  let sub = findSub(words[1]?.v);
  if (!sub) return [`unknown subcommand "${words[1]?.v}" in: ${line}`];
  let i = 2;
  if (sub.subcommands) {
    const inner = sub.subcommands[words[2]?.v];
    if (!inner) return [`unknown ${words[1].v} subcommand "${words[2]?.v}" in: ${line}`];
    sub = inner; i = 3;
  }
  const positionals = sub.options.filter((o) => !o.flags[0].startsWith('-'));
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
  const nplus = positionals.some((o) => o.nargs === '+');
  if (seen < needed) out.push(`${needed} positional argument(s) needed, got ${seen} in: ${line}`);
  if (!nplus && seen > positionals.length) out.push(`too many positional arguments in: ${line}`);
  for (const o of sub.options) if (o.required && o.flags[0].startsWith('-') && !words.some((w) => w.v === o.flags[0])) {
    out.push(`required ${o.flags[0]} missing in: ${line}`);
  }
  return out;
}

const cmdLines = (res) => res.blocks.flatMap((b) => b.lines.filter((l) => l.kind === 'cmd').map((l) => l.text));
const build = (over = {}) => B.assemble(spec, { ...over });
const text = (over) => B.render(build(over).blocks);

// ---------------------------------------------------------------- 1. spec against the CLI
test('the CLI export is for lab-rnaseq and has the subcommands the page uses', () => {
  assert.equal(cli.pipeline, 'lab-rnaseq');
  for (const s of ['setup', 'samplesheet', 'map', 'config', 'check', 'expression', 'isoforms', 'status', 'report', 'next', 'resume', 'run']) {
    assert.ok(findSub(s), `subcommand ${s} missing from rnaseq_cli.json`);
  }
  assert.ok(subs.config.subcommands.set, 'config set missing');
});

test('every lab-rnaseq line written in the spec templates uses real subcommands and flags', () => {
  let n = 0;
  const seenCommented = [];
  for (const step of spec.steps) for (const b of step.blocks) for (const l of b.lines) {
    if (l.comment !== undefined) {
      const m = /^lab-rnaseq\s+(\S+)/.exec(l.comment);
      if (m) { n++; assert.ok(findSub(m[1]), `commented command lab-rnaseq ${m[1]} is not a subcommand`); seenCommented.push(m[1]); }
      continue;
    }
    const lit = (l.words || []).filter((w) => typeof w === 'string');
    if (lit[0] !== 'lab-rnaseq') continue;
    n++;
    let sub = findSub(lit[1]);
    assert.ok(sub, `spec uses unknown subcommand ${lit[1]}`);
    if (sub.subcommands) { sub = sub.subcommands[lit[2]]; assert.ok(sub, `spec uses unknown ${lit[1]} subcommand ${lit[2]}`); }
    for (const w of l.words) {
      const flag = typeof w === 'string' ? (w.startsWith('--') ? w : null) : w.flag;
      if (flag) assert.ok(optionOf(sub, flag), `spec emits ${flag}, which \`lab-rnaseq ${lit[1]}\` does not accept`);
    }
  }
  assert.ok(n >= 15, 'the spec should hold the pipeline commands');
  assert.deepEqual([...new Set(seenCommented)].sort(), ['next', 'resume']);
});

test('config keys the spec writes exist in the pipeline defaults the page documents', () => {
  const keys = new Set();
  for (const step of spec.steps) for (const b of step.blocks) for (const l of b.lines) {
    const w = l.words || [];
    if (w[1] === 'config' && w[2] === 'set') keys.add(w[3]);
  }
  for (const c of Object.values(spec.config)) assert.ok(keys.has(c.key), `config key ${c.key} is never written`);
  for (const k of keys) assert.match(k, /^[a-z0-9_]+\.[a-z0-9_]+$/, `${k} must be section.key`);
  for (const k of keys) assert.ok(k in cfgKeys, `${k} is not a key of the pipeline's config schema (docs/data/rnaseq_config_keys.json)`);
});

test('module names in the spec are the ones the CLI documents', () => {
  const iso = subs.isoforms.options.find((o) => o.dest === 'modules');
  for (const m of spec.moduleOrder) assert.ok(iso.help.includes(m), `${m} not in the --modules help of isoforms`);
  const setup = subs.setup.options.find((o) => o.dest === 'modules');
  for (const m of spec.moduleOrder) assert.ok(setup.help.includes(m), `${m} not in the --modules help of setup`);
  assert.deepEqual(Object.keys(spec.moduleRequires).sort(), ['sashimi', 'spliceimpact']);
});

test('dropdown values the page offers are accepted by the CLI where it states choices', () => {
  const strand = subs.samplesheet.options.find((o) => o.dest === 'strandedness');
  const f = B.allFields(spec).find((x) => x.id === 'strandedness');
  assert.deepEqual(f.options, strand.choices);
  const org = subs.run.options.find((o) => o.dest === 'organism');
  for (const o of B.allFields(spec).find((x) => x.id === 'organism').options) assert.ok(org.help.includes(o), `organism ${o}`);
  const genome = subs.map.options.find((o) => o.dest === 'genome');
  for (const g of B.allFields(spec).find((x) => x.id === 'genome').options) assert.ok(genome.help.includes(g) || g === genome.default, `genome ${g}`);
});

test('every command the page can emit, over all combinations of options, is a valid lab-rnaseq command line', () => {
  const bools = ['install', 'stage_refs', 'single_end', 'isoforms', 'rmats', 'spliceimpact', 'sashimi', 'apa', 'ipa', 'isoformswitch', 'design'];
  const selects = {
    genome: ['hg38', 'mm10', 'hg38_dm6'], organism: ['human', 'mouse', 'drosophila', 'rat', 'zebrafish'],
    strandedness: ['auto', 'forward', 'reverse', 'unstranded'], style: ['', 'paper', 'paper_single', 'grant', 'slide']
  };
  const texts = [{}, { account: 'acct', partition: 'part', email: 'a@b.org', nfcore: '/x/y', exp: '/e', fastq_dir: '/f', matrix: '/m', metadata: '/md' }];
  let states = 0, commands = 0;
  for (const input of ['fastq', 'nfcore', 'matrix']) {
    for (let mask = 0; mask < 1 << bools.length; mask++) {
      const st = { input, go: ['MF'], collections: mask & 1 ? ['H', 'C2'] : ['C5'], fgsea: mask & 2 ? [] : ['HALLMARK'] };
      bools.forEach((b, i) => { st[b] = !!(mask & (1 << i)); });
      Object.entries(selects).forEach(([k, v], j) => { st[k] = v[(mask + j) % v.length]; });
      Object.assign(st, texts[(mask >> 3) & 1]);
      for (const line of cmdLines(build(st))) {
        commands++;
        assert.deepEqual(problems(line), []);
      }
      states++;
    }
  }
  assert.ok(states === 3 * 2048 && commands > 50000);
});

test('the checker itself rejects an unknown flag, subcommand and missing positional', () => {
  assert.ok(problems('lab-rnaseq map --nope').length);
  assert.ok(problems('lab-rnaseq mapp').length);
  assert.ok(problems('lab-rnaseq samplesheet').length);
  assert.ok(problems('lab-rnaseq config set only.key').length);
  assert.ok(problems('lab-rnaseq samplesheet d --strandedness sideways').length);
  assert.deepEqual(problems('lab-rnaseq samplesheet d --strandedness reverse --single-end'), []);
});

// ---------------------------------------------------------------- 2. assembly
test('quoting: single quotes, embedded quotes escaped, tilde left to the shell', () => {
  assert.equal(B.shellQuote('plain'), "'plain'");
  assert.equal(B.shellQuote("it's"), "'it'\\''s'");
  assert.equal(B.shellQuote('a b; rm -rf $HOME `x` "y"'), "'a b; rm -rf $HOME `x` \"y\"'");
  assert.equal(B.shellQuote('~/data set'), "~/'data set'");
  assert.equal(B.shellQuote('~'), '~');
  assert.equal(B.shellQuote('line1\nline2'), "'line1 line2'");
  const evil = ["x'; touch /tmp/pwn; '", 'a "b" $(c)', '--flag-like', 'sp ace'];
  for (const v of evil) assert.deepEqual(B.shellWords(B.shellQuote(v)), [{ v, quoted: true }]);
});

test('user values land in commands as exactly one quoted word', () => {
  const evil = "my 'lab' $(id)";
  const res = build({ input: 'fastq', exp: evil, fastq_dir: evil, account: evil, partition: evil, email: evil });
  const lines = cmdLines(res);
  for (const needle of ['cd ', 'lab-rnaseq samplesheet ', 'lab-rnaseq map ', 'lab-rnaseq config set project.email ', 'lab-rnaseq config set project.slurm_account ']) {
    const line = lines.find((l) => l.startsWith(needle));
    assert.ok(line, needle);
    const hits = B.shellWords(line).filter((w) => w.v === evil);
    assert.ok(hits.length >= 1 && hits.every((w) => w.quoted), `quoted in: ${line}`);
  }
  // the raw text never has an unquoted $( or ;
  for (const l of lines) assert.ok(B.shellWords(l).every((w) => w.quoted || !/[;$`]/.test(w.v)), l);
});

test('empty fields give placeholders, never lab paths, accounts or hosts', () => {
  const t = text({ input: 'fastq' });
  assert.match(t, /cd \/path\/to\/experiment\n/);
  assert.match(t, /samplesheet \/path\/to\/fastqs/);
  const m = text({ input: 'matrix' });
  assert.match(m, /--count-matrix \/path\/to\/counts\.tsv --metadata \/path\/to\/metadata\.csv/);
  assert.ok(!/--account|--partition|slurm_account|project\.email/.test(t + m), 'no account/partition/email lines when empty');
  for (const bad of [/\/home\//, /\/gpfs|\/hpc|\/data\//, /einstein|\.edu/i]) assert.ok(!bad.test(t + m + text({ input: 'nfcore' })));
});

test('session line is always shown; install block only when asked', () => {
  assert.ok(cmdLines(build()).includes('conda activate lab_pipelines'));
  assert.ok(!text({}).includes('git clone'));
  const t = text({ install: true });
  assert.match(t, /git clone https:\/\/github\.com\/Shechterlab\/lab_pipelines\.git && cd lab_pipelines && bash setup\.sh --only rnaseq\n/);
  assert.ok(!t.includes('--stage-references'));
  assert.match(text({ install: true, stage_refs: true }), /setup\.sh --only rnaseq --stage-references\n/);
  assert.ok(text({ install: true }).indexOf('git clone') < text({ install: true }).indexOf('conda activate'));
  assert.ok(!text({ stage_refs: true }).includes('--stage-references'), 'stage_refs without install is ignored');
});

test('FASTQ input: samplesheet, map dry run, map, status, then the nf-core steps', () => {
  const lines = cmdLines(build({ input: 'fastq', exp: '/e', fastq_dir: '/f', genome: 'mm10', organism: 'mouse', account: 'acc', partition: 'p1' }));
  const i = (s) => lines.findIndex((l) => l.startsWith(s));
  assert.deepEqual(lines.slice(0, 7), [
    'conda activate lab_pipelines',
    "cd '/e'",
    "lab-rnaseq samplesheet '/f'",
    "lab-rnaseq map --dry-run --genome mm10 --account 'acc' --partition 'p1'",
    "lab-rnaseq map --genome mm10 --account 'acc' --partition 'p1'",
    'lab-rnaseq map --status --watch',
    'lab-rnaseq setup --organism mouse'
  ]);
  assert.ok(i('lab-rnaseq setup') < i('lab-rnaseq check') && i('lab-rnaseq check') < i('lab-rnaseq expression --dry-run'));
  assert.ok(!lines.some((l) => l.includes('--nfcore-results')), 'setup finds nfcore_rnaseq/ after map');
  assert.ok(!lines.some((l) => l.includes('--reference-preset')), 'map records the genome');
  assert.ok(lines.includes("lab-rnaseq config set project.slurm_account 'acc'"));
  assert.ok(text({ input: 'fastq' }).includes('<group>_REP<n>'));
  assert.ok(lines.includes('lab-rnaseq report') && lines.includes('lab-rnaseq status --watch'));
});

test('samplesheet flags: strandedness only when not auto, single-end only when ticked', () => {
  const sheet = (o) => cmdLines(build({ input: 'fastq', fastq_dir: '/f', ...o })).find((l) => l.includes('samplesheet'));
  assert.equal(sheet({}), "lab-rnaseq samplesheet '/f'");
  assert.equal(sheet({ strandedness: 'reverse' }), "lab-rnaseq samplesheet '/f' --strandedness reverse");
  assert.equal(sheet({ strandedness: 'forward', single_end: true }), "lab-rnaseq samplesheet '/f' --strandedness forward --single-end");
  assert.equal(sheet({ single_end: true }), "lab-rnaseq samplesheet '/f' --single-end");
});

test('nf-core input: no mapping, setup with optional results path, settings, check, expression', () => {
  const lines = cmdLines(build({ input: 'nfcore', exp: '/e', nfcore: '/e/nf out', organism: 'human', genome: 'hg38', email: 'me@lab.org' }));
  assert.ok(!lines.some((l) => /samplesheet|lab-rnaseq map/.test(l)));
  assert.equal(lines[1], "cd '/e'");
  assert.equal(lines[2], "lab-rnaseq setup --nfcore-results '/e/nf out' --organism human --reference-preset hg38");
  assert.ok(lines.includes("lab-rnaseq config set project.email 'me@lab.org'"));
  assert.ok(!lines.some((l) => l.includes('slurm_account')));
  assert.ok(!cmdLines(build({ input: 'nfcore' })).some((l) => l.includes('--nfcore-results')), 'omitted when empty');
  assert.ok(lines.indexOf('lab-rnaseq check') > 2);
  assert.ok(lines.includes('lab-rnaseq expression --dry-run') && lines.includes('lab-rnaseq expression'));
  const t = B.render(build({ input: 'nfcore' }).blocks);
  assert.match(t, /# Review analysis\/inputs\/metadata\.csv and analysis\/inputs\/contrasts\.csv/);
  assert.match(t, /# lab-rnaseq next .*\n# lab-rnaseq resume /);
  // preset only when genome and organism agree
  assert.ok(!cmdLines(build({ input: 'nfcore', organism: 'mouse', genome: 'hg38' })).some((l) => l.includes('--reference-preset')));
  assert.ok(cmdLines(build({ input: 'nfcore', organism: 'human', genome: 'hg38_dm6' })).some((l) => l.endsWith('--reference-preset hg38') || l.includes('--reference-preset hg38 ')));
});

test('isoforms: only for nf-core/FASTQ input, modules in the CLI order, dependencies enforced', () => {
  const none = cmdLines(build({ input: 'nfcore' }));
  assert.ok(!none.some((l) => l.startsWith('lab-rnaseq isoforms')) && !none.some((l) => l.includes('--modules')));
  const on = cmdLines(build({ input: 'nfcore', isoforms: true, sashimi: true }));
  assert.ok(on.includes('lab-rnaseq isoforms --modules rmats,spliceimpact,sashimi,apa,ipa,isoformswitch'));
  assert.ok(on.some((l) => l.startsWith('lab-rnaseq setup') && l.endsWith('--modules rmats,spliceimpact,sashimi,apa,ipa,isoformswitch')));
  assert.ok(on.indexOf('lab-rnaseq expression') < on.findIndex((l) => l.startsWith('lab-rnaseq isoforms')));
  assert.ok(on.findIndex((l) => l.startsWith('lab-rnaseq isoforms')) < on.indexOf('lab-rnaseq status --watch'));
  // SpliceImpactR and sashimi need rMATS
  const norm = B.normalize(spec, { input: 'nfcore', isoforms: true, rmats: false, sashimi: true });
  assert.equal(norm.spliceimpact, false); assert.equal(norm.sashimi, false);
  assert.ok(cmdLines(build({ input: 'nfcore', isoforms: true, rmats: false, sashimi: true })).includes('lab-rnaseq isoforms --modules apa,ipa,isoformswitch'));
  // every module off: no isoforms step
  const off = { input: 'nfcore', isoforms: true };
  spec.moduleOrder.forEach((m) => { off[m] = false; });
  assert.ok(!cmdLines(build(off)).some((l) => l.startsWith('lab-rnaseq isoforms')));
  // a count matrix has no BAMs
  const mx = cmdLines(build({ input: 'matrix', isoforms: true }));
  assert.ok(!mx.some((l) => l.includes('isoforms') || l.includes('--modules')));
  assert.equal(B.normalize(spec, { input: 'matrix', isoforms: true }).isoforms, false);
  const iso = B.allFields(spec).find((f) => f.id === 'isoforms');
  assert.ok(iso.disabledWhen.includes('input=matrix') && iso.disabledReason.length > 10);
});

test('design: --design on expression and isoforms; as a config setting for the count matrix', () => {
  const n = cmdLines(build({ input: 'nfcore', design: true, isoforms: true }));
  assert.ok(n.includes('lab-rnaseq expression --dry-run --design') && n.includes('lab-rnaseq expression --design'));
  assert.ok(n.some((l) => l.startsWith('lab-rnaseq isoforms') && l.endsWith('--design')));
  const plain = cmdLines(build({ input: 'nfcore', isoforms: true }));
  assert.ok(!plain.some((l) => l.includes('--design')));
  const m = cmdLines(build({ input: 'matrix', design: true }));
  assert.ok(m.includes('lab-rnaseq config set compare.design true') && !m.some((l) => l.includes('--design')));
});

test('enrichment and figure choices become config set lines only when they differ from the defaults', () => {
  const cfg = (o) => cmdLines(build({ input: 'nfcore', ...o })).filter((l) => l.startsWith('lab-rnaseq config set'));
  assert.deepEqual(cfg({}), []);
  assert.deepEqual(cfg({ go: ['BP', 'MF', 'CC'], collections: ['H', 'C2', 'C5'], fgsea: ['HALLMARK'], style: 'paper' }), [
    'lab-rnaseq config set analysis.go_ontologies BP,MF,CC',
    'lab-rnaseq config set genesets.collections H,C2,C5',
    'lab-rnaseq config set analysis.fgsea_sets HALLMARK',
    'lab-rnaseq config set figures.style paper'
  ]);
  assert.deepEqual(cfg({ go: ['BP'], collections: ['H'], fgsea: ['REACTOME', 'HALLMARK'] }), [], 'the default set, in any order');
  assert.deepEqual(cfg({ go: [] }), [], 'an empty list is not written');
  // config lines come after setup and before check
  const lines = cmdLines(build({ input: 'nfcore', style: 'slide' }));
  assert.ok(lines.findIndex((l) => l.includes('figures.style')) > lines.findIndex((l) => l.startsWith('lab-rnaseq setup')));
  assert.ok(lines.findIndex((l) => l.includes('figures.style')) < lines.indexOf('lab-rnaseq check'));
  assert.deepEqual(spec.defaults, { go: ['BP'], collections: ['H'], fgsea: ['HALLMARK', 'REACTOME'], formats: ['pdf', 'png'] });
});

test('count matrix input: run --dry-run, settings, run, then status and report', () => {
  const lines = cmdLines(build({ input: 'matrix', exp: '/e', matrix: '/e/c.tsv', metadata: '/e/m.csv', organism: 'mouse', account: 'acc' }));
  assert.deepEqual(lines, [
    'conda activate lab_pipelines',
    "cd '/e'",
    "lab-rnaseq run --dry-run --project-dir analysis --count-matrix '/e/c.tsv' --metadata '/e/m.csv' --organism mouse",
    "lab-rnaseq config set project.slurm_account 'acc'",
    "lab-rnaseq run --project-dir analysis --count-matrix '/e/c.tsv' --metadata '/e/m.csv' --organism mouse",
    'lab-rnaseq status --watch',
    'lab-rnaseq report'
  ]);
  assert.ok(!cmdLines(build({ input: 'matrix' })).some((l) => l.includes('config set')));
  assert.ok(!cmdLines(build({ input: 'matrix' })).some((l) => /samplesheet|lab-rnaseq map|setup|check/.test(l)));
});

test('output groups commands under numbered "# step" lines, with comments as comments', () => {
  const t = text({ input: 'nfcore' });
  const heads = t.split('\n').filter((l) => l.startsWith('# step '));
  assert.ok(heads.length >= 6);
  heads.forEach((h, i) => assert.ok(h.startsWith(`# step ${i + 1}: `)));
  assert.ok(t.endsWith('\n') && !t.includes('\n\n\n'));
});

test('.sh download: bash shebang, no set -euo pipefail, an explanatory comment instead', () => {
  const sh = B.toScript(spec, text({ input: 'fastq' }));
  assert.ok(sh.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(!/^set -/m.test(sh));
  assert.match(sh, /^# .*set -euo pipefail.*on purpose.*Slurm/ms);
  assert.ok(sh.includes('lab-rnaseq map --status --watch'));
});

test('URL hash round trip keeps the form state and only stores differences', () => {
  assert.equal(B.toHash(spec, {}), '');
  const st = { input: 'matrix', exp: "/e x/it's", matrix: '/m', organism: 'rat', go: ['BP', 'CC'], fgsea: [], design: true, style: 'grant' };
  const h = B.toHash(spec, st);
  assert.ok(!h.includes(' ') && !h.includes("'"));
  const back = B.fromHash(spec, '#' + h);
  const want = B.normalize(spec, st);
  assert.deepEqual(back, want);
  assert.equal(text(back), text(st));
  // a hostile or stale hash cannot inject values outside the options
  const bad = B.fromHash(spec, '#input=evil&genome=%3Brm&strandedness=x&go=BP,ZZ&expression=0&unknown=1');
  assert.equal(bad.input, 'fastq'); assert.equal(bad.genome, 'hg38'); assert.equal(bad.strandedness, 'auto');
  assert.deepEqual(bad.go, ['BP']); assert.equal(bad.expression, true);
});

test('the expression analysis is always on and not togglable', () => {
  const f = B.allFields(spec).find((x) => x.id === 'expression');
  assert.ok(f.disabled && f.default);
  assert.equal(B.normalize(spec, { expression: false }).expression, true);
});

// ---------------------------------------------------------------- 3. Advanced (optional)
const ADV = {
  padj: '0.05', log2fc: '1', gmt: ' /g/a.gmt , /g/b.gmt', formats: ['png'], group_order: 'CTRL, D2 ,D4', run_name: 'run1',
  contrast_only: 'D2_vs_CTRL, D4_vs_CTRL', dry_run: false
};
const nfIso = { input: 'nfcore', isoforms: true };
const advCfg = (o, base = nfIso) => cmdLines(build({ ...base, ...o })).filter((l) => /^lab-rnaseq config set (analysis\.(padj|log2fc)|genesets\.gmt|figures\.formats)/.test(l));

test('advanced section: collapsible, after Analyses, fields as specified, defaults are the pipeline defaults', () => {
  const ids = spec.sections.map((s) => s.id);
  assert.equal(ids[ids.indexOf('analyses') + 1], 'advanced');
  const sec = spec.sections.find((s) => s.id === 'advanced');
  assert.equal(sec.title, 'Advanced (optional)'); assert.ok(sec.collapsible);
  assert.deepEqual(sec.fields.map((f) => f.id), ['padj', 'log2fc', 'gmt', 'formats', 'group_order', 'run_name', 'contrast_only', 'dry_run']);
  const d = B.defaultState(spec);
  assert.equal(d.padj, '0.01'); assert.equal(d.log2fc, '0.6');
  assert.deepEqual(d.formats, ['pdf', 'png']);
  assert.equal(d.gmt, ''); assert.equal(d.dry_run, false);
  assert.equal(cfgKeys['analysis.padj_threshold'], 'number'); assert.equal(cfgKeys['analysis.log2fc_threshold'], 'number');
});

test('advanced section: with nothing set the output is identical, for every input', () => {
  for (const input of ['fastq', 'nfcore', 'matrix']) {
    const base = { input, isoforms: true, design: true, style: 'paper', account: 'a', email: 'e@x.org' };
    const plain = text(base);
    const same = { ...base, padj: '0.01', log2fc: '0.60', gmt: ' , ', formats: ['png', 'pdf'], group_order: ',', run_name: '  ', contrast_only: ' ', dry_run: false };
    assert.equal(text(same), plain, input);
    assert.equal(text({ ...base, padj: '', log2fc: 'abc', formats: [] }), plain, 'empty or invalid values are ignored');
    assert.equal(text({ ...base, padj: '2', log2fc: '-1' }), plain, 'out of range values are ignored');
  }
});

test('advanced section: each field writes its own lines only when set', () => {
  assert.deepEqual(advCfg(ADV), [
    'lab-rnaseq config set analysis.padj_threshold 0.05',
    'lab-rnaseq config set analysis.log2fc_threshold 1',
    "lab-rnaseq config set genesets.gmt_files '/g/a.gmt,/g/b.gmt'",
    'lab-rnaseq config set figures.formats png'
  ]);
  assert.deepEqual(advCfg({ padj: '0.001' }), ['lab-rnaseq config set analysis.padj_threshold 0.001']);
  assert.deepEqual(advCfg({ log2fc: '0.585' }), ['lab-rnaseq config set analysis.log2fc_threshold 0.585']);
  assert.deepEqual(advCfg({ formats: ['pdf'] }), ['lab-rnaseq config set figures.formats pdf']);
  assert.deepEqual(advCfg({ formats: ['pdf', 'png'] }), []);
  assert.deepEqual(advCfg({ gmt: '~/sets/x.gmt' }), ["lab-rnaseq config set genesets.gmt_files ~/'sets/x.gmt'"]);
  const lines = cmdLines(build({ ...nfIso, ...ADV }));
  assert.ok(lines.includes("lab-rnaseq expression --dry-run --run-name 'run1' --group-order CTRL,D2,D4"));
  assert.ok(lines.includes("lab-rnaseq expression --run-name 'run1' --group-order CTRL,D2,D4"));
  assert.ok(lines.includes("lab-rnaseq isoforms --run 'run1' --modules rmats,spliceimpact,apa,ipa,isoformswitch --contrast D2_vs_CTRL --contrast D4_vs_CTRL --group-order CTRL,D2,D4"));
  // each field alone changes only its own lines
  const base = cmdLines(build(nfIso));
  for (const [k, v, n] of [['group_order', 'A,B', 3], ['run_name', 'r', 3], ['contrast_only', 'x', 1]]) {
    const got = cmdLines(build({ ...nfIso, [k]: v }));
    assert.equal(got.length, base.length);
    assert.equal(got.filter((l, i) => l !== base[i]).length, n, k);
  }
  // config lines come before check, like the other settings
  const all = cmdLines(build({ ...nfIso, padj: '0.05' }));
  assert.ok(all.findIndex((l) => l.includes('padj_threshold')) < all.indexOf('lab-rnaseq check'));
  // the count matrix has no expression/isoforms command: only the config settings apply
  const mx = cmdLines(build({ input: 'matrix', ...ADV }));
  assert.ok(mx.includes('lab-rnaseq config set analysis.padj_threshold 0.05'));
  assert.ok(!mx.some((l) => /--group-order|--run-name|--contrast|--run /.test(l)));
});

test('advanced section: run name, group order and contrasts only where the command accepts them', () => {
  const accepts = (sub, flag) => !!optionOf(findSub(sub), flag);
  assert.ok(accepts('expression', '--run-name') && accepts('expression', '--group-order'));
  assert.ok(accepts('isoforms', '--run') && accepts('isoforms', '--group-order') && accepts('isoforms', '--contrast'));
  assert.ok(!accepts('isoforms', '--run-name'), 'isoforms calls the run --run, not --run-name');
  assert.equal(optionOf(findSub('isoforms'), '--contrast').action, 'append', '--contrast is repeatable');
  // expression --contrast only filters the isoform modules of --with-isoforms, which the page does not use: never written there
  const lines = cmdLines(build({ ...nfIso, ...ADV }));
  assert.ok(!lines.some((l) => l.startsWith('lab-rnaseq expression') && l.includes('--contrast')));
  // no isoforms step: contrasts have nowhere to go
  assert.ok(!cmdLines(build({ input: 'nfcore', contrast_only: 'a' })).some((l) => l.includes('--contrast')));
  assert.ok(B.allFields(spec).find((f) => f.id === 'contrast_only').when.includes('isoforms_on'));
});

test('advanced section: user text is one quoted word, never code', () => {
  const evil = "x'; touch /tmp/pwn; '$(id)";
  const lines = cmdLines(build({ ...nfIso, gmt: evil, group_order: evil, run_name: evil, contrast_only: evil + ',b c', padj: '0.05;id', log2fc: '$(id)' }));
  for (const l of lines) assert.ok(B.shellWords(l).every((w) => w.quoted || !/[;$`]/.test(w.v)), l);
  const word = (line, flag) => { const w = B.shellWords(line); return w[w.findIndex((x) => x.v === flag) + 1]; };
  const exp = lines.find((l) => l.startsWith('lab-rnaseq expression --dry-run'));
  assert.deepEqual(word(exp, '--run-name'), { v: evil, quoted: true });
  assert.deepEqual(word(exp, '--group-order'), { v: evil, quoted: true });
  const iso = lines.find((l) => l.startsWith('lab-rnaseq isoforms'));
  assert.deepEqual(word(iso, '--run'), { v: evil, quoted: true });
  assert.deepEqual(B.shellWords(iso).filter((w, i, a) => a[i - 1]?.v === '--contrast'), [{ v: evil, quoted: true }, { v: 'b c', quoted: true }]);
  assert.deepEqual(B.shellWords(lines.find((l) => l.includes('genesets.gmt_files'))).pop(), { v: evil, quoted: true });
  assert.ok(!lines.some((l) => l.includes('padj_threshold') || l.includes('log2fc_threshold')), 'non-numbers are dropped');
});

test('advanced section: every line with every advanced field set is a valid command; config keys and values fit the schema', () => {
  let n = 0;
  for (const input of ['fastq', 'nfcore', 'matrix']) for (const dry of [false, true]) {
    for (const l of cmdLines(build({ input, isoforms: true, ...ADV, dry_run: dry }))) {
      assert.deepEqual(problems(l), []);
      const w = B.shellWords(l);
      if (w[1]?.v === 'config' && w[2]?.v === 'set') {
        n++;
        assert.ok(w[3].v in cfgKeys, `${w[3].v} is not in the pipeline's config schema`);
        const t = cfgKeys[w[3].v];
        if (t === 'number') assert.ok(Number.isFinite(Number(w[4].v)), l);
        if (t === 'array') assert.ok(!w[4].v.includes(' ') || w[4].quoted, l);
      }
    }
  }
  assert.ok(n > 10);
  assert.equal(cfgKeys['genesets.gmt_files'], 'array'); assert.equal(cfgKeys['figures.formats'], 'array');
});

test('advanced section: dry run only keeps the dry-run lines and drops the submitting ones', () => {
  const kept = (input, o = {}) => cmdLines(build({ input, isoforms: true, dry_run: true, ...o }));
  // nf-core: setup and check submit nothing and stay; expression is a dry run; no waiting, no report
  const nf = kept('nfcore');
  assert.ok(nf.includes('lab-rnaseq expression --dry-run') && !nf.includes('lab-rnaseq expression'));
  // isoforms attaches to an expression run, which a dry run does not create: no isoforms line
  assert.ok(!nf.some((l) => l.startsWith('lab-rnaseq isoforms')));
  assert.ok(!nf.some((l) => /^lab-rnaseq (status|report)/.test(l)) && !nf.some((l) => /--watch/.test(l)));
  assert.ok(nf.includes('lab-rnaseq check') && nf.some((l) => l.startsWith('lab-rnaseq setup')));
  assert.ok(!B.render(build({ input: 'nfcore', dry_run: true }).blocks).includes('lab-rnaseq resume'));
  // FASTQ: only the map dry run; the later steps need the mapped reads
  const fq = kept('fastq');
  assert.ok(fq.includes('lab-rnaseq map --dry-run --genome hg38'));
  assert.ok(!fq.some((l) => /^lab-rnaseq (setup|check|expression|isoforms|status|report)/.test(l) || l === 'lab-rnaseq map --genome hg38' || l.includes('--status')));
  assert.match(B.render(build({ input: 'fastq', dry_run: true }).blocks), /# Dry run only: nothing was submitted/);
  // count matrix: run --dry-run only
  const mx = kept('matrix', { matrix: '/m', metadata: '/md' });
  assert.ok(mx.some((l) => l.startsWith('lab-rnaseq run --dry-run')) && !mx.some((l) => l.startsWith('lab-rnaseq run --project-dir')));
  assert.ok(!mx.some((l) => /^lab-rnaseq (status|report)/.test(l)));
  // without the box, every submitting line is there
  assert.ok(cmdLines(build({ input: 'fastq' })).includes('lab-rnaseq map --genome hg38'));
});

test('advanced section: the choices survive the URL hash', () => {
  const st = { input: 'nfcore', isoforms: true, ...ADV, dry_run: true };
  const back = B.fromHash(spec, '#' + B.toHash(spec, st));
  assert.equal(text(back), text(st));
  assert.equal(B.toHash(spec, { padj: '0.01', log2fc: '0.6', formats: ['pdf', 'png'] }), '');
});
