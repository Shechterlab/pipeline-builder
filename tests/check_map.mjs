// Run with: node --test tests/
// The "Map reads" page (docs/map.html, spec docs/data/map.json):
// 1. every lab-<assay> command it can emit uses subcommands and flags that exist in docs/data/<pipeline>_cli.json;
// 2. FASTQ names -> samplesheet (pairing, single-end, lanes), accessions, heredoc quoting, no lab paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = createRequire(import.meta.url)(path.join(root, 'docs/assets/builder.js'));
const readJson = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'));
const spec = readJson('docs/data/map.json');
const ASSAYS = ['rnaseq', 'atacseq', 'chipseq', 'proseq'];
const clis = Object.fromEntries(ASSAYS.map((a) => [`lab-${a}`, readJson(`docs/data/${a}_cli.json`)]));

// what the lab's templates (lab_ngs_core/templates.py) and the nf-core tools take
const HEADERS = {
  atacseq: 'sample,fastq_1,fastq_2,replicate',
  chipseq: 'sample,fastq_1,fastq_2,replicate,antibody,control',
  proseq: 'sample,fastq_1,fastq_2,strandedness'
};
// parameters of nf-core/fetchngs 1.12.0 (its nextflow_schema.json); --nf_core_pipeline takes one of FETCHNGS_PIPELINES
const FETCHNGS_PARAMS = ['input', 'ena_metadata_fields', 'sample_mapping_fields', 'nf_core_pipeline', 'nf_core_rnaseq_strandedness',
  'download_method', 'skip_fastq_download', 'dbgap_key', 'outdir', 'email'];
const FETCHNGS_PIPELINES = ['rnaseq', 'atacseq', 'viralrecon', 'taxprofiler'];
const FETCHNGS_ID = /^(((SR|ER|DR)[APRSX])|(SAM(N|EA|D))|(PRJ(NA|EB|DB))|(GS[EM]))(\d+)$/;     // its assets/schema_input.json

// ---------------------------------------------------------------- the CLI model
function findSub(cli, name) {
  if (cli.subcommands[name]) return cli.subcommands[name];
  return Object.values(cli.subcommands).find((s) => (s.aliases || []).includes(name));
}
const optionOf = (sub, flag) => sub.options.find((o) => o.flags.includes(flag));
const takesValue = (o) => ['store', 'append'].includes(o.action);

// problems of one command line against the CLI named by its first word (lab-<assay>); other commands are not checked
function problems(line) {
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

const cmdLines = (res) => res.blocks.flatMap((b) => b.lines.filter((l) => l.kind === 'cmd').map((l) => l.text));
const build = (over = {}) => B.assemble(spec, { ...over });
const text = (over) => B.render(build(over).blocks);
const labLines = (over) => cmdLines(build(over)).filter((l) => l.startsWith('lab-'));
// the lines of a heredoc command: [command line, ...body, delimiter]
const heredoc = (over) => cmdLines(build(over)).find((l) => l.startsWith('cat > ')).split('\n');

const NAMES = ['CTRL_REP1_R1.fastq.gz', 'CTRL_REP1_R2.fastq.gz', 'KO_REP1_S3_L001_R1_001.fastq.gz', 'KO_REP1_S3_L001_R2_001.fastq.gz',
  'KO_REP1_S3_L002_R1_001.fastq.gz', 'KO_REP1_S3_L002_R2_001.fastq.gz', 'WT_3.fq.gz', 'solo_R1.fastq.gz'].join('\n');

// ---------------------------------------------------------------- 1. spec against the CLIs
test('the four CLI exports are for the right pipelines and hold the subcommands the page uses', () => {
  for (const a of ASSAYS) assert.equal(clis[`lab-${a}`].pipeline, `lab-${a}`);
  for (const s of ['samplesheet', 'map']) assert.ok(findSub(clis['lab-rnaseq'], s), `rnaseq ${s}`);
  for (const a of ['atacseq', 'chipseq', 'proseq']) for (const s of ['init', 'fetch', 'check', 'map', 'status']) assert.ok(findSub(clis[`lab-${a}`], s), `${a} ${s}`);
  assert.deepEqual(optionOf(findSub(clis['lab-chipseq'], 'status'), '--stage').choices, ['fetch', 'map', 'analyze', 'all']);
});

test('every lab-<assay> command written in the spec templates uses real subcommands and flags of that assay', () => {
  let n = 0;
  for (const assay of ASSAYS) {
    const cli = clis[`lab-${assay}`];
    for (const step of spec.steps) for (const b of step.blocks) for (const l of b.lines) {
      const w = l.words || [];
      const first = typeof w[0] === 'string' ? w[0] : (w[0]?.prefix === 'lab-' ? `lab-${assay}` : '');
      if (first !== `lab-${assay}`) continue;
      // the step is for rnaseq or for the others
      const stepFor = (step.when || []).includes('assay=rnaseq');
      if (stepFor !== (assay === 'rnaseq')) continue;
      n++;
      const sub = findSub(cli, w[1]);
      assert.ok(sub, `lab-${assay} has no subcommand ${w[1]}`);
      for (const x of w) {
        const flag = typeof x === 'string' ? (x.startsWith('--') ? x : null) : x.flag;
        if (flag) assert.ok(optionOf(sub, flag), `spec emits ${flag}, which lab-${assay} ${w[1]} does not accept`);
      }
    }
  }
  assert.ok(n >= 20, 'the spec should hold the pipeline commands');
});

test('every command the page can emit, over all combinations of options, is a valid lab command line', () => {
  const bools = ['install', 'stage_refs', 'single_end', 'dry_run', 'a', 'b', 'c'];
  const selects = {
    genome: ['hg38', 'mm10', 'hg38_dm6', 'dm6', 'rn6', 'danRer11'], chip_assay: ['chipseq', 'cutandrun', 'cuttag'],
    strandedness: ['auto', 'forward', 'reverse', 'unstranded'], proseq_strand: ['forward', 'reverse', 'unstranded', 'auto'],
    nf_profile: ['singularity', 'apptainer', 'docker', 'conda']
  };
  const texts = [{}, { exp: '/e', project: '/p', account: 'acct', partition: 'part', fastq_dir: '/f', extra_params: '/x.yaml', revision: '3.14.0', outdir: '/o', run_name: 'r1', proj_name: 'n' }];
  let states = 0, commands = 0;
  for (const assay of ASSAYS) for (const input of ['fastq', 'public']) for (let mask = 0; mask < 128; mask++) {
    const st = { assay, input, fastq_list: NAMES, accessions: 'GSE163049 SRR13242057 SRX9673860' };
    bools.forEach((b, i) => { st[b] = !!(mask & (1 << i)); });
    Object.entries(selects).forEach(([k, v], j) => { st[k] = v[(mask + j) % v.length]; });
    Object.assign(st, texts[(mask >> 2) & 1]);
    for (const line of cmdLines(build(st))) {
      commands++;
      assert.deepEqual(problems(line), []);
    }
    states++;
  }
  assert.equal(states, 4 * 2 * 128);
  assert.ok(commands > 5000);
});

test('the checker itself rejects an unknown flag, subcommand and missing flag', () => {
  assert.ok(problems('lab-chipseq map --nope').length);
  assert.ok(problems('lab-chipseq mapp --project-dir p').length);
  assert.ok(problems('lab-atacseq map --project-dir p --samplesheet s').length, '--config is required');
  assert.ok(problems('lab-rnaseq map --stage map').length, '--stage is a status flag of the others');
  assert.ok(problems('lab-proseq status --project-dir p --stage nope').length);
  assert.deepEqual(problems('lab-proseq status --project-dir p --stage map'), []);
});

test('flags per assay: ATAC / ChIP / PRO-seq map takes the same flags, RNA-seq has its own', () => {
  const atac = labLines({ assay: 'atacseq', project: '/p' });
  const chip = labLines({ assay: 'chipseq', project: '/p' }), pro = labLines({ assay: 'proseq', project: '/p' });
  assert.equal(atac.length, 5, 'init, check, map dry run, map, status');
  assert.deepEqual(chip.map((l) => l.replace('lab-chipseq', 'lab-atacseq')), atac);
  assert.deepEqual(pro.map((l) => l.replace('lab-proseq', 'lab-atacseq')), atac);
  const rna = labLines({ assay: 'rnaseq', exp: '/e', fastq_dir: '/f' });
  assert.ok(rna.some((l) => l.startsWith('lab-rnaseq samplesheet')) && !rna.some((l) => /--project-dir|--config/.test(l)));
});

// ---------------------------------------------------------------- 2. the commands the page writes
test('RNA-seq, FASTQ folder: cd, samplesheet, map dry run, map, status', () => {
  const st = { assay: 'rnaseq', input: 'fastq', exp: '/e', fastq_dir: '/f', genome: 'mm10', account: 'acc', partition: 'p1' };
  assert.deepEqual(cmdLines(build(st)), [
    'conda activate lab_pipelines',
    "cd '/e'",
    "lab-rnaseq samplesheet '/f'",
    "lab-rnaseq map --dry-run --genome mm10 --account 'acc' --partition 'p1'",
    "lab-rnaseq map --genome mm10 --account 'acc' --partition 'p1'",
    'lab-rnaseq map --status --watch'
  ]);
  const s = (o) => cmdLines(build({ ...st, ...o })).find((l) => l.includes('samplesheet'));
  assert.equal(s({ strandedness: 'reverse', single_end: true }), "lab-rnaseq samplesheet '/f' --strandedness reverse --single-end");
  const adv = cmdLines(build({ ...st, extra_params: '/x y.yaml', revision: '3.14.0', outdir: '/o' })).find((l) => l.startsWith('lab-rnaseq map --genome'));
  assert.equal(adv, "lab-rnaseq map --genome mm10 --account 'acc' --partition 'p1' --extra-params '/x y.yaml' --revision '3.14.0' --outdir '/o'");
  assert.match(text(st), /<group>_REP<n>/);
});

test('RNA-seq, public data: accessions.csv, fetchngs with its parameters verified, samplesheet, then map', () => {
  const st = { assay: 'rnaseq', input: 'public', exp: '/e', accessions: 'SRR1039512, srr1039516\nGSE147507', nf_profile: 'apptainer' };
  const lines = cmdLines(build(st));
  assert.deepEqual(heredoc(st), ["cat > accessions.csv <<'EOF'", 'SRR1039512', 'SRR1039516', 'GSE147507', 'EOF']);
  const nf = lines.find((l) => l.startsWith('nextflow'));
  assert.equal(nf, 'nextflow run nf-core/fetchngs -revision 1.12.0 -profile apptainer --input accessions.csv --outdir "$PWD/fetchngs" --nf_core_pipeline rnaseq -resume');
  const w = B.shellWords(nf).map((x) => x.v);
  for (const p of w.filter((x) => x.startsWith('--'))) assert.ok(FETCHNGS_PARAMS.includes(p.slice(2)), `${p} is not a fetchngs 1.12.0 parameter`);
  assert.ok(FETCHNGS_PIPELINES.includes(w[w.indexOf('--nf_core_pipeline') + 1]));
  assert.ok(lines.indexOf(nf) < lines.indexOf('cp fetchngs/samplesheet/samplesheet.csv samplesheet.csv'));
  assert.ok(lines.indexOf('cp fetchngs/samplesheet/samplesheet.csv samplesheet.csv') < lines.indexOf('lab-rnaseq map --dry-run --genome hg38'));
  assert.ok(!lines.some((l) => l.includes('lab-rnaseq samplesheet')), 'fetchngs writes the samplesheet');
  assert.match(text(st), /# lab-rnaseq has no fetch command|lab_nextflow/);
  // no ids yet: a comment, no heredoc
  assert.ok(!cmdLines(build({ ...st, accessions: '' })).some((l) => l.startsWith('cat >')));
  // a dry run does not apply to fetchngs: the box is hidden and the lines stay
  assert.ok(cmdLines(build({ ...st, dry_run: true })).includes('lab-rnaseq map --genome hg38'));
  assert.ok(B.allFields(spec).find((f) => f.id === 'dry_run').when.includes('!rna_public'));
});

test('ATAC-seq, FASTQ folder: init, samplesheet heredoc, check, map dry run, map, status', () => {
  const st = { assay: 'atacseq', input: 'fastq', project: '/p/atac', fastq_dir: '/data/fq', fastq_list: 'WT_rep1_R1.fastq.gz\nWT_rep1_R2.fastq.gz', genome: 'mm10', run_name: 'run1', proj_name: 'my atac' };
  const lines = cmdLines(build(st));
  const labs = lines.filter((l) => l.startsWith('lab-'));
  assert.deepEqual(labs, [
    "lab-atacseq init --project-dir '/p/atac' --name 'my atac'",
    "lab-atacseq check --project-dir '/p/atac' --config '/p/atac'/inputs/project_config.yaml --samplesheet '/p/atac'/inputs/samplesheet.csv",
    "lab-atacseq map --project-dir '/p/atac' --samplesheet '/p/atac'/inputs/samplesheet.csv --config '/p/atac'/inputs/project_config.yaml --genome mm10 --run-name 'run1' --dry-run",
    "lab-atacseq map --project-dir '/p/atac' --samplesheet '/p/atac'/inputs/samplesheet.csv --config '/p/atac'/inputs/project_config.yaml --genome mm10 --run-name 'run1'",
    "lab-atacseq status --project-dir '/p/atac' --stage map"
  ]);
  assert.deepEqual(heredoc(st), ["cat > '/p/atac'/inputs/samplesheet.csv <<'EOF'", 'sample,fastq_1,fastq_2,replicate',
    'WT_rep1,/data/fq/WT_rep1_R1.fastq.gz,/data/fq/WT_rep1_R2.fastq.gz,1', 'EOF']);
  const i = (s) => lines.findIndex((l) => l.startsWith(s));
  assert.ok(i('lab-atacseq init') < i('cat > ') && i('cat > ') < i('lab-atacseq check') && i('lab-atacseq check') < i('lab-atacseq map'));
  assert.ok(!lines.some((l) => l.startsWith('sed -i \'s/^assay_type')), 'assay_type is ChIP-only');
  // mapping needs no comparisons: the empty contrasts.csv init writes is left alone
  assert.ok(!lines.some((l) => l.includes('contrasts.csv')));
});

test('ChIP-seq: assay_type is set in the config for CUT&RUN / CUT&Tag only, antibody and control are left to edit', () => {
  const st = { assay: 'chipseq', project: '/p', fastq_list: 'H3K27ac_rep1_R1.fastq.gz\nH3K27ac_rep1_R2.fastq.gz\nInput_rep1_R1.fastq.gz\nInput_rep1_R2.fastq.gz\nIgG_2_R1.fastq.gz\nIgG_2_R2.fastq.gz' };
  assert.ok(!text(st).includes('assay_type'));
  assert.ok(!text({ ...st, chip_assay: 'chipseq' }).includes('assay_type'));
  assert.ok(cmdLines(build({ ...st, chip_assay: 'cutandrun' })).includes("sed -i 's/^assay_type: .*/assay_type: cutandrun/' '/p'/inputs/project_config.yaml"));
  assert.ok(cmdLines(build({ ...st, chip_assay: 'cuttag' })).includes("sed -i 's/^assay_type: .*/assay_type: cuttag/' '/p'/inputs/project_config.yaml"));
  assert.ok(!text({ assay: 'atacseq', chip_assay: 'cuttag', project: '/p' }).includes('assay_type'), 'not for other assays');
  const body = heredoc(st);
  assert.equal(body[1], HEADERS.chipseq);
  assert.deepEqual(body.slice(2, -1), [
    'H3K27ac_rep1,/path/to/fastqs/H3K27ac_rep1_R1.fastq.gz,/path/to/fastqs/H3K27ac_rep1_R2.fastq.gz,1,EDIT_ANTIBODY,EDIT_CONTROL',
    'IgG_2,/path/to/fastqs/IgG_2_R1.fastq.gz,/path/to/fastqs/IgG_2_R2.fastq.gz,2,IgG,',
    'Input_rep1,/path/to/fastqs/Input_rep1_R1.fastq.gz,/path/to/fastqs/Input_rep1_R2.fastq.gz,1,Input,'
  ]);
  assert.match(text(st), /# ChIP .* replace EDIT_ANTIBODY with each sample's antibody and EDIT_CONTROL/);
  // the sed command really edits the scaffolded config
  const dir = mkdtempSync(path.join(tmpdir(), 'map-'));
  mkdirSync(path.join(dir, 'inputs'));
  writeFileSync(path.join(dir, 'inputs/project_config.yaml'), 'project:\n  name: x\nassay_type: chipseq\nreferences:\n  organism: human\n');
  const sed = cmdLines(build({ ...st, chip_assay: 'cutandrun', project: dir })).find((l) => l.startsWith('sed -i'));
  assert.equal(spawnSync('bash', ['-c', sed]).status, 0);
  assert.equal(readFileSync(path.join(dir, 'inputs/project_config.yaml'), 'utf8'), 'project:\n  name: x\nassay_type: cutandrun\nreferences:\n  organism: human\n');
});

test('PRO-seq: the strandedness column comes from the page; fetch is not offered a strandedness', () => {
  const st = { assay: 'proseq', project: '/p', fastq_dir: '/f', fastq_list: 'A_1_R1.fastq.gz\nA_1_R2.fastq.gz', proseq_strand: 'reverse' };
  assert.deepEqual(heredoc(st).slice(1, -1), [HEADERS.proseq, 'A_1,/f/A_1_R1.fastq.gz,/f/A_1_R2.fastq.gz,reverse']);
  assert.equal(heredoc({ ...st, proseq_strand: undefined })[2].split(',')[3], 'forward');
  assert.ok(B.normalize(spec, { assay: 'proseq', proseq_strand: 'sideways' }).proseq_strand === 'forward', 'a bad value falls back');
});

test('public data for ATAC / ChIP / PRO-seq: accessions heredoc, fetch dry run, fetch, status, then check and map', () => {
  for (const assay of ['atacseq', 'chipseq', 'proseq']) {
    const st = { assay, input: 'public', project: '/p', accessions: 'GSE163049\nSRR13242057 ERR1\nnot-an-id' };
    const lines = cmdLines(build(st));
    assert.deepEqual(heredoc(st), ["cat > '/p'/inputs/accessions.csv <<'EOF'", 'GSE163049', 'SRR13242057', 'ERR1', 'EOF'], 'one id per line, no header (what nf-core/fetchngs reads)');
    const labs = lines.filter((l) => l.startsWith('lab-')).map((l) => l.split(' ').slice(0, 2).join(' '));
    assert.deepEqual(labs, [`lab-${assay} init`, `lab-${assay} fetch`, `lab-${assay} fetch`, `lab-${assay} status`, `lab-${assay} check`, `lab-${assay} map`, `lab-${assay} map`, `lab-${assay} status`]);
    const fetch = lines.filter((l) => l.startsWith(`lab-${assay} fetch`));
    assert.equal(fetch[0], `lab-${assay} fetch --project-dir '/p' --accessions '/p'/inputs/accessions.csv --config '/p'/inputs/project_config.yaml --run-name fetch --dry-run`);
    assert.equal(fetch[1], fetch[0].replace(' --dry-run', ''));
    assert.ok(lines.includes(`lab-${assay} status --project-dir '/p' --stage fetch`));
    assert.match(text(st), /# Left out \(not a GEO \/ SRA \/ ENA \/ DDBJ accession\): NOT-AN-ID\n/);
    const cp = lines.find((l) => l.startsWith('cp '));
    if (assay === 'atacseq') assert.equal(cp, "cp '/p'/results/fetch/fetch/output/samplesheet/samplesheet.csv '/p'/inputs/samplesheet.csv");
    else assert.equal(cp, undefined, 'the fetched sheet has other columns: written by hand');
    assert.ok(!/nf_core_pipeline/.test(text(st)));          // the pipelines' fetch passes it, not the page
  }
  // dry run only: nothing after the fetch dry run
  const dry = cmdLines(build({ assay: 'chipseq', input: 'public', project: '/p', accessions: 'SRX1', dry_run: true })).filter((l) => l.startsWith('lab-'));
  assert.deepEqual(dry.map((l) => l.split(' ')[1]), ['init', 'fetch']);
  assert.ok(dry[1].endsWith('--dry-run'));
});

test('dry run only (FASTQ folder): the map dry run, no submit, no status', () => {
  for (const assay of ASSAYS) {
    const lines = cmdLines(build({ assay, input: 'fastq', exp: '/e', project: '/p', dry_run: true }));
    assert.equal(lines.filter((l) => /^lab-\w+ map/.test(l)).length, 1);
    assert.ok(lines.some((l) => /^lab-\w+ map .*--dry-run/.test(l)));
    assert.ok(!lines.some((l) => /--status|\bstatus\b/.test(l)));
    assert.match(B.render(build({ assay, input: 'fastq', dry_run: true }).blocks), /# Dry run only/);
  }
});

test('the heredoc has a quoted delimiter and a body that bash writes out literally, whatever the file names hold', () => {
  const dir = mkdtempSync(path.join(tmpdir(), "it's a dir-"));
  mkdirSync(path.join(dir, 'inputs'));
  const evil = ['a$(touch${IFS}PWNED)_R1.fastq.gz', 'a$(touch${IFS}PWNED)_R2.fastq.gz', 'b`touch${IFS}PWNED`.fastq.gz', 'c"x".fastq.gz', "d'q.fastq.gz", 'e$HOME.fastq.gz', 'f,g.fastq.gz'];
  const st = { assay: 'atacseq', project: dir, fastq_dir: '/f $(touch PWNED2)', fastq_list: evil.join('\n') };
  const cmd = cmdLines(build(st)).find((l) => l.startsWith('cat > '));
  assert.match(cmd.split('\n')[0], /<<'EOF'$/);
  assert.equal(cmd.split('\n').pop(), 'EOF');
  const r = spawnSync('bash', ['-c', cmd], { cwd: dir });
  assert.equal(r.status, 0, String(r.stderr));
  const written = readFileSync(path.join(dir, 'inputs/samplesheet.csv'), 'utf8');
  assert.equal(written, heredoc(st).slice(1, -1).join('\n') + '\n');
  assert.ok(written.includes('a$(touch${IFS}PWNED)_R1.fastq.gz') && written.includes('e$HOME.fastq.gz'), 'kept literally');
  assert.ok(written.includes('"/f $(touch PWNED2)/f,g.fastq.gz"'), 'a comma makes it a quoted CSV field');
  for (const f of ['PWNED', 'PWNED2']) assert.equal(spawnSync('test', ['-e', path.join(dir, f)]).status, 1, `${f} was created`);
  // accessions: only valid ids reach the heredoc
  const acc = heredoc({ assay: 'atacseq', input: 'public', project: dir, accessions: 'SRR1\n$(id)\nGSE1;rm -rf /\nPRJNA1' });
  assert.deepEqual(acc.slice(1, -1), ['SRR1', 'GSE1', 'PRJNA1'], 'only ids: `;` splits, `$(id)`, rm, -rf and / are not ids');
});

test('the rendered script of every combination is valid bash syntax (bash -n) and keeps comments as comments', () => {
  const bad = [];
  let n = 0;
  for (const assay of ASSAYS) for (const input of ['fastq', 'public']) for (const dry of [false, true]) for (const chip of ['chipseq', 'cuttag']) {
    const t = B.toScript(spec, text({ assay, input, dry_run: dry, chip_assay: chip, exp: "/e x/it's", project: "~/my 'p'", fastq_list: NAMES, accessions: 'SRR1039512', install: true, stage_refs: true, account: "a'b" }));
    const r = spawnSync('bash', ['-n'], { input: t });
    n++;
    if (r.status !== 0) bad.push(`${assay}/${input}: ${r.stderr}`);
  }
  assert.deepEqual(bad, []);
  assert.equal(n, 32);
});

test('user values land in commands as exactly one quoted word', () => {
  const evil = "my 'lab' $(id)";
  for (const assay of ASSAYS) {
    const st = { assay, input: 'fastq', exp: evil, project: evil, fastq_dir: evil, account: evil, partition: evil, extra_params: evil, revision: evil, outdir: evil, run_name: evil, proj_name: evil, genome: 'hg38' };
    for (const l of cmdLines(build(st))) {
      if (l.includes('\n')) continue;                                     // heredocs: tested above
      assert.ok(B.shellWords(l).every((w) => w.quoted || !/[;$`]/.test(w.v)), l);
    }
    const quoted = labLines(st).flatMap((l) => B.shellWords(l)).filter((w) => w.v === evil);
    assert.ok(quoted.length >= 3 && quoted.every((w) => w.quoted));
  }
});

test('placeholders for empty required fields; no lab paths, accounts or hosts anywhere in the spec output', () => {
  assert.match(text({ assay: 'rnaseq' }), /cd \/path\/to\/experiment\n/);
  assert.match(text({ assay: 'rnaseq' }), /samplesheet \/path\/to\/fastqs\n/);
  assert.match(text({ assay: 'chipseq' }), /--project-dir \/path\/to\/project /);
  assert.ok(!/--account|--partition|slurm_account '/.test(text({ assay: 'rnaseq' })), 'nothing when empty');
  const all = [];
  for (const assay of ASSAYS) for (const input of ['fastq', 'public']) all.push(text({ assay, input, fastq_list: NAMES, accessions: 'SRR1', install: true }));
  all.push(JSON.stringify(spec));
  for (const t of all) for (const bad of [/\/home\//, /\/gpfs|\/hpc|\/data\/|\/mnt\//, /einstein|\.edu/i, /\bscratch\b/, /Shechter[^ ]*\.org/]) assert.ok(!bad.test(t), String(bad));
  // the only place the lab is named in a command is the repository the install step clones
  for (const t of all.slice(0, -1)) assert.ok(!/Shechter/i.test(t.replace('https://github.com/Shechterlab/lab_pipelines.git', '')));
  assert.match(text({ assay: 'chipseq', install: true, stage_refs: true }), /git clone https:\/\/github\.com\/Shechterlab\/lab_pipelines\.git && cd lab_pipelines && bash setup\.sh --only chipseq --stage-references\n/);
  for (const a of ASSAYS) assert.match(text({ assay: a, install: true }), new RegExp(`--only ${a}\\n`));
  assert.ok(!text({ stage_refs: true }).includes('--stage-references'), 'without install it is ignored');
});

test('the genome options and flags are real: genome choices have a refgenie name, the run name and project name map to flags', () => {
  const genome = B.allFields(spec).find((f) => f.id === 'genome');
  assert.ok(['hg38', 'mm10', 'hg38_dm6'].every((g) => genome.options.includes(g)));
  const rnaMap = findSub(clis['lab-rnaseq'], 'map').options.find((o) => o.dest === 'genome');
  assert.ok(rnaMap.help.includes('hg38') && rnaMap.help.includes('mm10') && rnaMap.help.includes('hg38_dm6'));
  const strand = findSub(clis['lab-rnaseq'], 'samplesheet').options.find((o) => o.dest === 'strandedness');
  assert.deepEqual(B.allFields(spec).find((f) => f.id === 'strandedness').options, strand.choices);
  for (const a of ['atacseq', 'chipseq', 'proseq']) {
    assert.ok(optionOf(findSub(clis[`lab-${a}`], 'init'), '--name'));
    assert.ok(optionOf(findSub(clis[`lab-${a}`], 'map'), '--run-name'));
  }
});

// ---------------------------------------------------------------- 3. FASTQ names -> samplesheet
const sheetOf = (assay, names, o = {}) => B.fastqSheet(assay, names, o.folder || '/f', !!o.single, o.strand);
const rows = (assay, names, o) => sheetOf(assay, names, o).lines.slice(1);

test('pairing: _R1/_R2, _1/_2, .R1/.R2 and Illumina names are paired; sample names and replicates come from the names', () => {
  assert.deepEqual(rows('atacseq', 'WT_REP1_R1.fastq.gz\nWT_REP1_R2.fastq.gz'), ['WT_REP1,/f/WT_REP1_R1.fastq.gz,/f/WT_REP1_R2.fastq.gz,1']);
  assert.deepEqual(rows('atacseq', 'KO-2_1.fq.gz\nKO-2_2.fq.gz'), ['KO-2,/f/KO-2_1.fq.gz,/f/KO-2_2.fq.gz,2']);
  assert.deepEqual(rows('atacseq', 'x.R2.fastq.gz\nx.R1.fastq.gz'), ['x,/f/x.R1.fastq.gz,/f/x.R2.fastq.gz,'], 'order of the listing does not matter');
  assert.deepEqual(rows('atacseq', 'KO_rep3_S12_L001_R1_001.fastq.gz\nKO_rep3_S12_L001_R2_001.fastq.gz'),
    ['KO_rep3,/f/KO_rep3_S12_L001_R1_001.fastq.gz,/f/KO_rep3_S12_L001_R2_001.fastq.gz,3']);
  assert.deepEqual(rows('atacseq', 'Sample_S1_R1_001.fastq.gz\nSample_S1_R2_001.fastq.gz'), ['Sample,/f/Sample_S1_R1_001.fastq.gz,/f/Sample_S1_R2_001.fastq.gz,'], 'no-lane-splitting names');
  assert.equal(B.replicateOf('CTRL_REP12'), '12'); assert.equal(B.replicateOf('ctrl_rep3'), '3');
  assert.equal(B.replicateOf('WT-2'), '2'); assert.equal(B.replicateOf('WT_1'), '1'); assert.equal(B.replicateOf('WT'), '');
  assert.equal(B.replicateOf('WT_2024'), '', 'a long number is not a replicate');
});

test('lanes: every lane is a row of the same sample (nf-core concatenates them)', () => {
  const names = ['A_REP1_S1_L001_R1_001.fastq.gz', 'A_REP1_S1_L001_R2_001.fastq.gz', 'A_REP1_S1_L002_R1_001.fastq.gz', 'A_REP1_S1_L002_R2_001.fastq.gz',
    'B_REP1_S2_L001_R1_001.fastq.gz', 'B_REP1_S2_L001_R2_001.fastq.gz'].join('\n');
  const r = rows('atacseq', names);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => x.split(',')[0]), ['A_REP1', 'A_REP1', 'B_REP1']);
  assert.ok(r[0].includes('_L001_R1_001') && r[0].includes('_L001_R2_001') && r[1].includes('_L002_R1_001') && r[1].includes('_L002_R2_001'));
  assert.ok(sheetOf('atacseq', names).notes[0].startsWith('6 FASTQ file(s) -> 2 sample(s), 3 row(s): 3 paired-end, 0 single-end'));
});

test('single-end: files without a mate have an empty fastq_2; the single-end box makes every file its own read 1', () => {
  assert.deepEqual(rows('atacseq', 'A_REP1.fastq.gz\nA_REP2.fastq.gz'), ['A_REP1,/f/A_REP1.fastq.gz,,1', 'A_REP2,/f/A_REP2.fastq.gz,,2']);
  assert.deepEqual(rows('atacseq', 'A_R1.fastq.gz'), ['A,/f/A_R1.fastq.gz,,'], 'a lone R1 is single-end, named without the read');
  assert.deepEqual(rows('atacseq', 'CTRL_2.fastq.gz'), ['CTRL_2,/f/CTRL_2.fastq.gz,,2'], 'a lone _2 is a replicate, not a mate');
  // _1 and _2 of different samples are replicates when the box is ticked
  assert.deepEqual(rows('atacseq', 'CTRL_1.fastq.gz\nCTRL_2.fastq.gz', { single: true }), ['CTRL_1,/f/CTRL_1.fastq.gz,,1', 'CTRL_2,/f/CTRL_2.fastq.gz,,2']);
  assert.deepEqual(rows('atacseq', 'CTRL_1.fastq.gz\nCTRL_2.fastq.gz'), ['CTRL,/f/CTRL_1.fastq.gz,/f/CTRL_2.fastq.gz,'], 'otherwise they are mates, like lab-rnaseq samplesheet');
  assert.deepEqual(rows('atacseq', 'S_L001_R1_001.fastq.gz\nS_L001_R2_001.fastq.gz', { single: true }).map((r) => r.split(',')[2]), ['', '']);
});

test('mixed paired and single-end files: each file by its own mate, with a warning when one sample mixes them', () => {
  const names = ['P_REP1_R1.fastq.gz', 'P_REP1_R2.fastq.gz', 'S_REP1.fastq.gz', 'Q_REP1_R1.fastq.gz'].join('\n');
  const sheet = sheetOf('chipseq', names);
  assert.deepEqual(sheet.lines.slice(1).map((l) => l.split(',').slice(0, 3).join(' ')), [
    'P_REP1 /f/P_REP1_R1.fastq.gz /f/P_REP1_R2.fastq.gz', 'Q_REP1 /f/Q_REP1_R1.fastq.gz ', 'S_REP1 /f/S_REP1.fastq.gz ']);
  assert.ok(sheet.notes[0].includes('3 row(s): 1 paired-end, 2 single-end'));
  assert.ok(!sheet.notes.some((n) => n.startsWith('These samples mix')));
  const mixed = sheetOf('atacseq', 'A_R1.fastq.gz\nA_R2.fastq.gz\nA.fastq.gz');
  assert.ok(mixed.notes.some((n) => n.startsWith('These samples mix paired and single-end files (nf-core wants one kind per sample): A')));
});

test('files that are not reads, index files and undetermined reads are left out and named; duplicates once; ls -l and paths understood', () => {
  const t = ['total 12', 'notes.txt', 'S1_L001_I1_001.fastq.gz', 'Undetermined_S0_L001_R1_001.fastq.gz', 'plain.fastq', 'A_R1.fastq.gz', 'A_R1.fastq.gz',
    '-rw-r--r-- 1 u g 99 Jan 1 00:00 A_R2.fastq.gz', '/other/dir/B_R1.fq.gz', '/other/dir/B_R2.fq.gz'].join('\n');
  const s = sheetOf('atacseq', t);
  assert.deepEqual(s.lines.slice(1), ['A,/f/A_R1.fastq.gz,/f/A_R2.fastq.gz,', 'B,/other/dir/B_R1.fq.gz,/other/dir/B_R2.fq.gz,']);
  const note = s.notes.find((n) => n.startsWith('Left out'));
  for (const x of ['total', 'notes.txt', 'S1_L001_I1_001.fastq.gz', 'Undetermined_S0_L001_R1_001.fastq.gz', 'plain.fastq']) assert.ok(note.includes(x) || x === 'total', x);
  assert.equal(sheetOf('atacseq', '').lines.length, 0);
  assert.equal(sheetOf('atacseq', 'only.txt').lines.length, 0);
  assert.equal(sheetOf('rnaseq', 'A_R1.fastq.gz').lines.length, 0, 'lab-rnaseq writes its own samplesheet');
});

test('the samplesheet headers are the lab templates; folder: trailing slash dropped, placeholder when empty', () => {
  for (const a of Object.keys(HEADERS)) assert.equal(sheetOf(a, 'A_REP1_R1.fastq.gz').lines[0], HEADERS[a]);
  assert.equal(sheetOf('atacseq', 'A_R1.fastq.gz', { folder: '/x/y///' }).lines[1], 'A,/x/y/A_R1.fastq.gz,,');
  assert.ok(heredoc({ assay: 'atacseq', project: '/p', fastq_list: 'A_R1.fastq.gz' })[2].startsWith('A,/path/to/fastqs/A_R1.fastq.gz'));
  assert.equal(sheetOf('proseq', 'A_R1.fastq.gz', { strand: 'reverse' }).lines[1], 'A,/f/A_R1.fastq.gz,,reverse');
  for (const a of ['atacseq', 'chipseq']) {
    const n = sheetOf(a, 'X_R1.fastq.gz\nX_R2.fastq.gz').notes.join('\n');
    assert.match(n, /No replicate number in the name of X: fill the replicate column/);
  }
  assert.ok(!sheetOf('proseq', 'X_R1.fastq.gz').notes.join('\n').includes('replicate'));
});

test('accessions: GEO / SRA / ENA / DDBJ ids as fetchngs accepts them, upper-cased, deduplicated, other tokens named', () => {
  const p = B.parseAccessions('gse147507, SRR11605097\nSRX8171613 SRR11605097;ERR4007730 DRR171822\tGSM4432381 PRJNA625551 SAMN14689442 accession');
  assert.deepEqual(p.ids, ['GSE147507', 'SRR11605097', 'SRX8171613', 'ERR4007730', 'DRR171822', 'GSM4432381', 'PRJNA625551', 'SAMN14689442']);
  for (const id of p.ids) assert.match(id, FETCHNGS_ID);
  assert.deepEqual(p.notes, []);
  const bad = B.parseAccessions('SRR1 foo "SRR2" 12345 GSE');
  assert.deepEqual(bad.ids, ['SRR1', 'SRR2']);
  assert.ok(bad.notes[0].includes('FOO') && bad.notes[0].includes('12345') && bad.notes[0].includes('GSE'));
  assert.deepEqual(B.parseAccessions('').ids, []);
  // the lab's own example list (with sample columns) is not what fetchngs reads: only the ids get through
  assert.deepEqual(B.parseAccessions('accession,sample,condition,replicate,notes\nSRR1039512,N052611_untreated,untreated,1,"Airway smooth muscle"').ids, ['SRR1039512']);
});

// ---------------------------------------------------------------- 4. page state
test('URL hash round trip keeps the choices, including pasted lists, and only stores differences', () => {
  assert.equal(B.toHash(spec, {}), '');
  const st = { assay: 'chipseq', chip_assay: 'cuttag', input: 'public', project: "/p/it's", accessions: 'SRR1\nGSE2', fastq_list: NAMES, genome: 'mm10', dry_run: true, run_name: 'r 1' };
  const h = B.toHash(spec, st);
  assert.ok(!h.includes(' ') && !h.includes("'") && !h.includes('\n'));
  const back = B.fromHash(spec, '#' + h);
  assert.deepEqual(back, B.normalize(spec, st));
  assert.equal(text(back), text(st));
  assert.equal(back.fastq_list, NAMES);
  const bad = B.fromHash(spec, '#assay=evil&input=x&genome=%3Brm&chip_assay=z&unknown=1&proseq_strand=up');
  assert.equal(bad.assay, 'rnaseq'); assert.equal(bad.input, 'fastq'); assert.equal(bad.genome, 'hg38'); assert.equal(bad.chip_assay, 'chipseq'); assert.equal(bad.proseq_strand, 'forward');
  assert.equal(B.multiLine('a  \r\n\r\n b\n\n'), 'a\n b');
});

test('.sh download: map-page header, no set -euo pipefail, an explanatory comment instead', () => {
  const sh = B.toScript(spec, text({ assay: 'atacseq' }));
  assert.ok(sh.startsWith('#!/usr/bin/env bash\n# Written by the Shechter Lab map-reads command builder.\n'));
  assert.ok(!/^set -/m.test(sh));
  assert.match(sh, /^# .*set -euo pipefail.*on purpose.*Slurm/ms);
  assert.equal(spec.script.file, 'map-reads-commands.sh');
  assert.ok(sh.includes('lab-atacseq map'));
  // the RNA-seq page keeps its own wording
  const rna = B.toScript(readJson('docs/data/rnaseq.json'), 'x\n');
  assert.match(rna, /Written by the Shechter Lab RNA-seq command builder\./);
  assert.match(rna, /\(map --status --watch,\n# status --watch\)/);
});

test('output groups commands under numbered "# step" lines, comments stay comments, heredocs stay whole', () => {
  const t = text({ assay: 'chipseq', fastq_list: NAMES, input: 'fastq' });
  const heads = t.split('\n').filter((l) => l.startsWith('# step '));
  assert.ok(heads.length >= 5);
  heads.forEach((h, i) => assert.ok(h.startsWith(`# step ${i + 1}: `)));
  assert.ok(t.endsWith('\n') && !t.includes('\n\n\n'));
  assert.equal((t.match(/<<'EOF'/g) || []).length, 1);
  assert.equal(t.split('\n').filter((l) => l === 'EOF').length, 1);
});

// ---------------------------------------------------------------- 5. the pages
test('both pages carry the nav "Map reads" | "RNA-seq analysis", the right one marked current, and the same asset version', () => {
  const index = readFileSync(path.join(root, 'docs/index.html'), 'utf8'), map = readFileSync(path.join(root, 'docs/map.html'), 'utf8');
  const nav = (h) => /<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(h)[1].replace(/\s+/g, ' ').trim();
  assert.equal(nav(index), '<a href="map.html">Map reads</a> <a href="./" aria-current="page">RNA-seq analysis</a>');
  assert.equal(nav(map), '<a href="map.html" aria-current="page">Map reads</a> <a href="./">RNA-seq analysis</a>');
  assert.match(map, /<title>Mapping · Shechter Lab<\/title>/);
  assert.match(map, /window\.BUILDER_SPEC = 'data\/map\.json'/);
  assert.ok(!/BUILDER_SPEC/.test(index));
  const v = (h) => [/builder\.css\?v=(\w+)/.exec(h)[1], /builder\.js\?v=(\w+)/.exec(h)[1], /BUILDER_VERSION = '(\w+)'/.exec(h)[1]];
  assert.deepEqual([...new Set([...v(index), ...v(map)])].length, 1);
  for (const h of [index, map]) for (const id of ['theme-btn', 'copy-btn', 'download-btn', 'copy-status', 'out', 'builder-form']) assert.ok(h.includes(`id="${id}"`), id);
});
