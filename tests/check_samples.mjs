// Run with: node --test tests/
// The shared "Samples & comparisons" block (builder.js) and the pages that use it:
// 1. CSV detection, group / replicate from names, FASTQ listing and column-name listing -> table;
// 2. comparisons -> contrasts.csv, metadata.csv per pipeline (columns checked against lab_ngs_core when a checkout is next to this repo);
// 3. heredoc quoting of odd names, drag-and-drop / select fallback logic (pure functions), state in the address and as JSON;
// 4. the pages: map (ATAC / ChIP / PRO-seq write metadata.csv + contrasts.csv, RNA-seq an optional extra), RNA-seq analysis, proteomics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { B, root, readJson, problems } from './cli_model.mjs';

const mapSpec = readJson('docs/data/map.json'), rnaSpec = readJson('docs/data/rnaseq.json'), protSpec = readJson('docs/data/proteomics.json');
const clis = Object.fromEntries(['rnaseq', 'atacseq', 'chipseq', 'proseq', 'proteomics'].map((a) => [`lab-${a}`, readJson(`docs/data/${a}_cli.json`)]));
const protKeys = readJson('docs/data/proteomics_config_keys.json').keys;
const cmdLines = (spec, st) => B.assemble(spec, st).blocks.flatMap((b) => b.lines.filter((l) => l.kind === 'cmd').map((l) => l.text));
const text = (spec, st) => B.render(B.assemble(spec, st).blocks);
const row = (sample, group, replicate = '', extra = {}) => ({ ...B.blankRow(), sample, group, replicate, ...extra });
// the heredocs of a command list: {target: [body lines]} for `cat > target <<'EOF'`
function heredocs(lines) {
  const out = {};
  for (const l of lines) {
    const m = /^cat > (.+) <<'(\w+)'\n/.exec(l);
    if (m) out[m[1]] = l.split('\n').slice(1, -1);
  }
  return out;
}
const lab = path.resolve(root, process.env.LAB_PIPELINES || '../lab_pipelines');
const haveLab = existsSync(path.join(lab, 'lab-ngs-core/lab_ngs_core/config.py'));
const labTest = (name, fn) => test(name, { skip: haveLab ? false : 'no lab_pipelines checkout next to this repository (set LAB_PIPELINES)' }, fn);
const py = (code, args = [], env = {}) => spawnSync('python3', ['-c', code, ...args], { env: { ...process.env, ...env, LAB_PIPELINES_LAB_CONFIG: 'none', LAB_PIPELINES_SITE: 'none' }, encoding: 'utf8' });
const haveYaml = spawnSync('python3', ['-c', 'import yaml']).status === 0;

// ---------------------------------------------------------------- 1. a CSV in
test('CSV detection: an nf-core samplesheet is recognised, lanes merged, groups and replicates taken from the names', () => {
  const r = B.samplesFromCsv('sample,fastq_1,fastq_2,strandedness\nWT_REP1,/d/a_R1.fastq.gz,/d/a_R2.fastq.gz,auto\nWT_REP1,/d/b_R1.fastq.gz,/d/b_R2.fastq.gz,auto\nKO_rep2,/d/c_R1.fastq.gz,,reverse\n', 'atacseq');
  assert.equal(r.ok, true);
  assert.match(r.kind, /nf-core samplesheet/);
  assert.deepEqual(r.rows.map((x) => [x.sample, x.group, x.replicate]), [['WT_REP1', 'WT', '1'], ['KO_rep2', 'KO', '2']]);
  assert.deepEqual(r.recognised.map((x) => `${x.column}>${x.as}`), ['sample>sample', 'fastq_1>fastq_1', 'fastq_2>fastq_2', 'strandedness>strandedness']);
  assert.deepEqual(r.rows.map((x) => x.strandedness), ['', ''], 'strandedness is not a column of the ATAC table');
  assert.equal(B.samplesFromCsv('sample,fastq_1,strandedness\nA_1,x,reverse\n', 'proseq').rows[0].strandedness, 'reverse', 'but it is one for PRO-seq');
  assert.ok(r.notes.some((n) => /fastq_1 \/ fastq_2 paths .* not used/.test(n)));
});

test('CSV detection: a metadata table keeps its own group and replicate cells and says what it ignored', () => {
  const r = B.samplesFromCsv('sample,condition,batch,cell_line,replicate\nA1,WT,A,HeLa,1\nA2,WT,B,HeLa,2\nB1,,A,HeLa,\n', 'rnaseq');
  assert.equal(r.kind, 'metadata table');
  assert.deepEqual(r.rows.map((x) => [x.sample, x.group, x.replicate]), [['A1', 'WT', '1'], ['A2', 'WT', '2'], ['B1', 'B1', '']]);
  assert.deepEqual(r.ignored, ['batch', 'cell_line']);
  const chip = B.samplesFromCsv('sample,condition,replicate,antibody,control\nH_WT_1,WT,1,H3K27me3,Input_1\n', 'chipseq');
  assert.deepEqual([chip.rows[0].antibody, chip.rows[0].control], ['H3K27me3', 'Input_1']);
});

test('CSV detection: a proteomics experimental_design.csv (label column), odd delimiters, BOM, CRLF and quoted commas', () => {
  const r = B.samplesFromCsv('﻿label,condition,replicate\r\nCtrl_1,Control,1\r\nCtrl_2,Control,2\r\n"Tr, 1",Treat,1\r\n', 'proteomics');
  assert.match(r.kind, /experimental design/);
  assert.deepEqual(r.rows.map((x) => x.sample), ['Ctrl_1', 'Ctrl_2', 'Tr, 1']);
  assert.equal(r.recognised[0].as, 'sample');
  const semi = B.samplesFromCsv('Sample ID;Group;Rep\nx_1;A;1\nx_2;A;2\n', 'rnaseq');
  assert.deepEqual(semi.rows.map((x) => [x.sample, x.group, x.replicate]), [['x_1', 'A', '1'], ['x_2', 'A', '2']]);
  const tsv = B.samplesFromCsv('sample\tgroup\nx_1\tA\nx_2\tB\n', 'rnaseq');
  assert.deepEqual(tsv.rows.map((x) => x.group), ['A', 'B']);
  const bare = B.samplesFromCsv('name\nWT_REP1\nWT_REP2\n', 'rnaseq');
  assert.equal(bare.kind, 'sample list');
  assert.ok(bare.notes.some((n) => /No condition \/ group column/.test(n)));
});

test('CSV detection: junk is refused with a message; non-CSV and very large files are refused before reading', () => {
  assert.match(B.samplesFromCsv('gene,count\nTP53,10\n', 'rnaseq').error, /No sample column found/);
  assert.match(B.samplesFromCsv('just some text', 'rnaseq').error, /header row and at least one sample/);
  assert.match(B.samplesFromCsv('sample,condition\n', 'rnaseq').error, /header row and at least one sample/);
  assert.match(B.samplesFromCsv('sample,condition\n,\n,\n', 'rnaseq').error, /header row|empty/);
  assert.match(B.samplesFromCsv('sample\u0000,x\nA\u0000,1\n', 'rnaseq').error, /binary/);
  assert.match(B.samplesFromCsv(Array.from({ length: 90 }, (_, i) => 'c' + i).join(',') + '\n' + Array(90).fill('1').join(','), 'rnaseq').error, /Too many columns/);
  assert.match(B.checkCsvFile('photo.png', 1000), /not a CSV file/);
  assert.match(B.checkCsvFile('samples.xlsx', 1000), /not a CSV file/);
  assert.match(B.checkCsvFile('samples.csv', 0), /empty/);
  assert.match(B.checkCsvFile('big.csv', B.CSV_MAX_BYTES + 1), /too large/);
  assert.equal(B.checkCsvFile('samplesheet.csv', 4000), '');
  assert.equal(B.checkCsvFile('Meta.TSV', 4000), '');
  const many = 'sample\n' + Array.from({ length: 700 }, (_, i) => 'S_' + i).join('\n');
  const r = B.samplesFromCsv(many, 'rnaseq');
  assert.equal(r.rows.length, 500);
  assert.ok(r.notes.some((n) => /first 500/.test(n)));
});

test('group and replicate come from <group>_REP<n>, _rep<n>, _R<n>, a trailing _<n> / -<n>, and stay editable', () => {
  const cases = { WT_REP1: ['WT', '1'], ko_rep2: ['ko', '2'], DKO_R3: ['DKO', '3'], 'Treat-4': ['Treat', '4'], CTRL_1: ['CTRL', '1'], WT: ['WT', ''],
    A_B_C_12: ['A_B_C', '12'], sample123: ['sample123', ''], x_2024: ['x_2024', ''], 'WT_rep_2': ['WT', '2'], 'KO.3': ['KO', '3'], 'D2_REP10': ['D2', '10'] };
  for (const [name, [g, r]] of Object.entries(cases)) assert.deepEqual(Object.values(B.splitSample(name)), [g, r], name);
  assert.equal(B.replicateOf('CTRL_REP2'), '2');            // the FASTQ pairing uses the same rule
  assert.equal(B.replicateOf('WT'), '');
  for (const [label, g, r] of [['LFQ intensity WT_1', 'WT', '1'], ['Ctrl_1_LFQ', 'Ctrl', '1'], ['Intensity KO_REP2', 'KO', '2'], ['iBAQ Mock-3', 'Mock', '3']]) {
    assert.deepEqual(Object.values(B.splitSample(B.labelStem(label))), [g, r], label);
  }
  // an edited cell wins over what the name says
  const st = B.normalize(mapSpec, { assay: 'atacseq', samples: [row('WT_REP1', 'Wild type', '7')] });
  assert.deepEqual([st.samples[0].group, st.samples[0].replicate], ['Wild type', '7']);
});

test('pasted FASTQ names fill the table (one row per sample, lanes merged); edits survive a change of the list', () => {
  const names = 'CTRL_REP1_R1.fastq.gz\nCTRL_REP1_R2.fastq.gz\nKO_REP1_S3_L001_R1_001.fastq.gz\nKO_REP1_S3_L001_R2_001.fastq.gz\nKO_REP1_S3_L002_R1_001.fastq.gz\nKO_REP1_S3_L002_R2_001.fastq.gz\nInput_rep1_R1.fastq.gz\nInput_rep1_R2.fastq.gz\nIgG_2_R1.fastq.gz\nIgG_2_R2.fastq.gz';
  const st = B.normalize(mapSpec, { assay: 'chipseq', fastq_list: names });
  assert.deepEqual(st.samples.map((r) => [r.sample, r.group, r.replicate, r.antibody]), [['CTRL_REP1', 'CTRL', '1', ''], ['IgG_2', 'IgG', '2', 'IgG'], ['Input_rep1', 'Input', '1', 'Input'], ['KO_REP1', 'KO', '1', '']]);
  // the user edits a group and adds a typed row, then the list gets another file
  const edited = st.samples.map((r) => (r.sample === 'KO_REP1' ? { ...r, group: 'Knockout', antibody: 'H3K27ac' } : r)).concat([row('typed_1', 'typed', '1')]);
  const again = B.normalize(mapSpec, { assay: 'chipseq', fastq_list: names + '\nNEW_3_R1.fastq.gz\nNEW_3_R2.fastq.gz', samples: edited });
  assert.deepEqual(again.samples.map((r) => r.sample), ['CTRL_REP1', 'IgG_2', 'Input_rep1', 'KO_REP1', 'NEW_3', 'typed_1']);
  assert.deepEqual(again.samples.find((r) => r.sample === 'KO_REP1') && [again.samples[3].group, again.samples[3].antibody], ['Knockout', 'H3K27ac']);
  // a name that left the list goes; the typed row stays
  const fewer = B.normalize(mapSpec, { assay: 'chipseq', fastq_list: 'CTRL_REP1_R1.fastq.gz\nCTRL_REP1_R2.fastq.gz', samples: edited });
  assert.deepEqual(fewer.samples.map((r) => r.sample), ['CTRL_REP1', 'typed_1']);
  // an empty list leaves the table alone; a public-data input has no list
  assert.equal(B.normalize(mapSpec, { assay: 'chipseq', samples: edited }).samples.length, edited.length);
  assert.equal(B.normalize(mapSpec, { assay: 'chipseq', input: 'public', fastq_list: names }).samples.length, 0);
});

test('table edits reach the samplesheet: a renamed sample, replicate, antibody and control replace EDIT_* and the derived values', () => {
  const names = 'H3_WT_R1.fastq.gz\nH3_WT_R2.fastq.gz\nInput_WT_R1.fastq.gz\nInput_WT_R2.fastq.gz';
  const st = B.normalize(mapSpec, { assay: 'chipseq', project: '/p', fastq_dir: '/f', fastq_list: names });
  st.samples = st.samples.map((r) => (r.sample === 'H3_WT' ? { ...r, sample: 'H3K27me3_WT_rep1', replicate: '1', antibody: 'H3K27me3', control: 'Input_WT' } : r));
  const sheet = cmdLines(mapSpec, st).find((l) => l.startsWith("cat > '/p'/inputs/samplesheet.csv")).split('\n').slice(1, -1);
  assert.deepEqual(sheet, ['sample,fastq_1,fastq_2,replicate,antibody,control',
    'H3K27me3_WT_rep1,/f/H3_WT_R1.fastq.gz,/f/H3_WT_R2.fastq.gz,1,H3K27me3,Input_WT', 'Input_WT,/f/Input_WT_R1.fastq.gz,/f/Input_WT_R2.fastq.gz,,Input,']);
  // metadata.csv uses the same names, so `check` finds the samples aligned
  const meta = heredocs(cmdLines(mapSpec, st))["'/p'/inputs/metadata.csv"];
  assert.deepEqual(meta, ['sample,condition,replicate,antibody', 'H3K27me3_WT_rep1,H3_WT,1,H3K27me3', 'Input_WT,Input_WT,,Input']);
  const ss = sheet.slice(1).map((l) => l.split(',')[0]), mm = meta.slice(1).map((l) => l.split(',')[0]);
  assert.deepEqual(ss, mm);
  // PRO-seq: a per-sample strandedness wins over the page's choice
  const pro = B.normalize(mapSpec, { assay: 'proseq', project: '/p', fastq_list: 'A_1_R1.fastq.gz\nA_1_R2.fastq.gz\nB_1_R1.fastq.gz\nB_1_R2.fastq.gz', proseq_strand: 'forward' });
  pro.samples[1].strandedness = 'reverse';
  assert.deepEqual(cmdLines(mapSpec, pro).find((l) => l.includes('samplesheet.csv')).split('\n').slice(2, -1).map((l) => l.split(',').pop()), ['forward', 'reverse']);
});

test('pasted proteomics column names: a proteinGroups header, bare names, one line with prefixes', () => {
  const header = ['Protein IDs', 'Majority protein IDs', 'Peptides', 'Sequence coverage [%]', 'LFQ intensity Ctrl_1', 'LFQ intensity Ctrl_2', 'LFQ intensity Treat_1', 'Intensity Ctrl_1', 'Reverse'].join('\t');
  const r = B.parseColumnNames(header);
  assert.deepEqual(r.labels, ['LFQ intensity Ctrl_1', 'LFQ intensity Ctrl_2', 'LFQ intensity Treat_1', 'Intensity Ctrl_1']);
  assert.ok(r.notes.some((n) => /More than one intensity family/.test(n)), 'two families would both be read by lab-proteomics');
  assert.deepEqual(B.parseColumnNames('Accession\nDescription\nCtrl_1_LFQ\nCtrl_2_LFQ\nT_1_LFQ').labels, ['Ctrl_1_LFQ', 'Ctrl_2_LFQ', 'T_1_LFQ']);
  assert.deepEqual(B.parseColumnNames('Ctrl_1, Ctrl_2, KO_1').labels, ['Ctrl_1', 'Ctrl_2', 'KO_1']);
  assert.deepEqual(B.parseColumnNames('LFQ intensity A_1 LFQ intensity A_2 LFQ intensity B_1').labels, ['LFQ intensity A_1', 'LFQ intensity A_2', 'LFQ intensity B_1']);
  const st = B.normalize(protSpec, { columns: header });
  assert.deepEqual(st.samples.map((x) => [x.group, x.replicate]), [['Ctrl', '1'], ['Ctrl', '2'], ['Treat', '1'], ['Ctrl', '1']]);
  // a header line is kilobytes: it is not cut at 400 characters, and the address keeps the labels only
  const long = ['Protein IDs'].concat(Array.from({ length: 300 }, (_, i) => `LFQ intensity Sample_${i}_x`)).join('\t');
  assert.ok(long.length > 400);
  assert.equal(B.normalize(protSpec, { columns: long }).samples.length, 300);
  assert.ok(!B.toHash(protSpec, { columns: long }).includes('Protein%20IDs'));
  assert.equal(B.normalize(protSpec, B.fromHash(protSpec, '#' + B.toHash(protSpec, { columns: long }))).samples.length, 300);
});

// ---------------------------------------------------------------- 2. the files written, per pipeline
const TABLE_ROWS = [row('WT_REP1', 'WT', '1', { antibody: 'H3K27ac' }), row('WT_REP2', 'WT', '2', { antibody: 'H3K27ac' }), row('KO_REP1', 'KO', '1', { antibody: 'H3K27ac' }), row('KO_REP2', 'KO', '2', { antibody: 'H3K27ac' })];
const COMPS = [{ target: 'KO', reference: 'WT', id: '' }];
const pipelineCase = {
  atacseq: [mapSpec, { assay: 'atacseq', project: '/p' }, "'/p'/inputs/metadata.csv", "'/p'/inputs/contrasts.csv"],
  chipseq: [mapSpec, { assay: 'chipseq', project: '/p' }, "'/p'/inputs/metadata.csv", "'/p'/inputs/contrasts.csv"],
  proseq: [mapSpec, { assay: 'proseq', project: '/p' }, "'/p'/inputs/metadata.csv", "'/p'/inputs/contrasts.csv"],
  rnaseq: [rnaSpec, { input: 'matrix', exp: '/e', matrix: '/m.tsv', metadata: '/x.csv' }, 'analysis/inputs/metadata.csv', 'analysis/inputs/contrasts.csv'],
  proteomics: [protSpec, { project: '/p' }, "'/p'/inputs/experimental_design.csv", "'/p'/inputs/contrasts.csv"]
};
const EXPECT_META = {
  atacseq: ['sample,condition,replicate', 'WT_REP1,WT,1', 'WT_REP2,WT,2', 'KO_REP1,KO,1', 'KO_REP2,KO,2'],
  chipseq: ['sample,condition,replicate,antibody', 'WT_REP1,WT,1,H3K27ac', 'WT_REP2,WT,2,H3K27ac', 'KO_REP1,KO,1,H3K27ac', 'KO_REP2,KO,2,H3K27ac'],
  proseq: ['sample,condition,replicate', 'WT_REP1,WT,1', 'WT_REP2,WT,2', 'KO_REP1,KO,1', 'KO_REP2,KO,2'],
  rnaseq: ['sample,condition,replicate', 'WT_REP1,WT,1', 'WT_REP2,WT,2', 'KO_REP1,KO,1', 'KO_REP2,KO,2'],
  proteomics: ['label,condition,replicate', 'WT_REP1,WT,1', 'WT_REP2,WT,2', 'KO_REP1,KO,1', 'KO_REP2,KO,2']
};

test('every pipeline gets metadata.csv (experimental_design.csv for proteomics) and contrasts.csv in its own format', () => {
  for (const [pipe, [spec, st, metaTarget, conTarget]] of Object.entries(pipelineCase)) {
    const files = heredocs(cmdLines(spec, { ...st, samples: TABLE_ROWS, comparisons: COMPS }));
    assert.deepEqual(files[metaTarget], EXPECT_META[pipe], pipe);
    assert.deepEqual(files[conTarget], ['id,variable,reference,target', 'KO_vs_WT,condition,WT,KO'], pipe);
    assert.deepEqual(B.TABLES[pipe].meta, EXPECT_META[pipe][0].split(','));
  }
  assert.deepEqual(B.CONTRAST_HEADER, ['id', 'variable', 'reference', 'target']);
  // no table, no heredocs; a table without comparisons writes metadata only
  for (const [, [spec, st, metaTarget, conTarget]] of Object.entries(pipelineCase)) {
    const files = heredocs(cmdLines(spec, { ...st, samples: TABLE_ROWS }));
    assert.ok(files[metaTarget] && !files[conTarget]);
    assert.ok(!Object.keys(heredocs(cmdLines(spec, { ...st }))).some((k) => /metadata|contrasts|experimental_design/.test(k)));
  }
});

labTest('the column names written are the ones the lab templates and load_contrasts read (lab_ngs_core)', () => {
  const r = py(`import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(lab, 'lab-ngs-core'))})
from lab_ngs_core.templates import CSV_TEMPLATES, template_header
print(json.dumps({k: template_header(k) for k in CSV_TEMPLATES}))`);
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(r.stdout);
  for (const a of ['atacseq', 'chipseq', 'proseq']) {
    assert.deepEqual(B.TABLES[a].meta, t[`${a}_metadata`], a);
    assert.deepEqual(B.CONTRAST_HEADER, t[`${a}_contrasts`], a);
  }
  assert.deepEqual(B.TABLES.proteomics.meta, t.proteomics_experimental_design);
  assert.deepEqual(B.CONTRAST_HEADER, t.proteomics_contrasts);
  assert.deepEqual(B.CONTRAST_HEADER, t.rnaseq_contrasts);
  for (const c of B.TABLES.rnaseq.meta) assert.ok(t.rnaseq_metadata.includes(c), `rnaseq_metadata has ${c}`);
});

labTest('load_contrasts reads the generated contrasts.csv (id, reference, target, variable) for every pipeline, odd names included', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'con-'));
  const odd = [{ target: 'KO (48h)', reference: 'WT', id: '' }, { target: "it's", reference: 'WT', id: 'my_id' }, { target: 'a,b', reference: 'WT', id: '' }];
  const rows = [row('A_1', 'WT'), row('B_1', 'KO (48h)'), row('C_1', "it's"), row('D_1', 'a,b')];
  const cases = [];
  for (const [pipe, [spec, st, , conTarget]] of Object.entries(pipelineCase)) {
    const body = heredocs(cmdLines(spec, { ...st, samples: rows, comparisons: odd }))[conTarget];
    const file = path.join(dir, `${pipe}_contrasts.csv`);
    writeFileSync(file, body.join('\n') + '\n');
    cases.push(file);
  }
  const r = py(`import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(lab, 'lab-ngs-core'))})
from lab_ngs_core.config import load_contrasts
out = {}
for f in sys.argv[1:]:
    out[f] = [(c['id'], c['variable'], c['reference'], c['target']) for c in load_contrasts(f)]
print(json.dumps(out))`, cases);
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  for (const f of cases) assert.deepEqual(got[f], [['KO_48h_vs_WT', 'condition', 'WT', 'KO (48h)'], ['my_id', 'condition', 'WT', "it's"], ['a_b_vs_WT', 'condition', 'WT', 'a,b']], f);
});

test('heredoc bodies keep odd sample and group names literal: bash writes them out exactly, nothing runs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), "it's a dir-"));
  mkdirSync(path.join(dir, 'inputs'));
  const names = ['a$(touch${IFS}PWNED)_REP1', "it's_REP2", 'b`touch${IFS}PWNED`_REP1', 'x"y,z_REP1', 'EOF', '$HOME_REP3', '  spaced  _REP1'];
  const rows = names.map((n) => row(n, n.replace(/_REP\d$/, ''), '1'));
  const comps = [{ target: rows[0].group, reference: rows[1].group, id: '' }, { target: 'x"y,z', reference: 'EOF', id: '' }];
  const st = { assay: 'chipseq', project: dir, samples: rows, comparisons: comps };
  const lines = cmdLines(mapSpec, st).filter((l) => l.startsWith('cat > '));
  assert.equal(lines.length, 2);
  for (const cmd of lines) {
    const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.ok(!existsSync(path.join(dir, 'PWNED')) && !existsSync(path.join(dir, 'inputs/PWNED')));
  const meta = readFileSync(path.join(dir, 'inputs/metadata.csv'), 'utf8'), con = readFileSync(path.join(dir, 'inputs/contrasts.csv'), 'utf8');
  const metaRows = B.parseCsv(meta), conRows = B.parseCsv(con);
  const kept = B.normalize(mapSpec, st).samples;
  assert.deepEqual(kept.map((r) => r.sample), names.map((n) => n.trim()), 'cells are trimmed');
  assert.deepEqual(metaRows.slice(1).map((r) => r[0]), kept.map((r) => r.sample), 'sample names round-trip through CSV quoting');
  assert.deepEqual(metaRows.slice(1).map((r) => r[1]), kept.map((r) => r.group));
  assert.deepEqual(conRows[1].slice(2), [kept[1].group, kept[0].group]);
  assert.deepEqual(conRows[2], ['x_y_z_vs_EOF', 'condition', 'EOF', 'x"y,z']);
  assert.ok(meta.includes('$HOME_REP3') && meta.includes('"x""y,z_REP1"'));
  // the delimiter is unique among the body lines even when a body line is exactly EOF
});

// ---------------------------------------------------------------- 3. comparisons: drag and drop, the selects, ids
test('drag and drop onto Target and Reference: pure logic (fill a slot, add on the second, errors keep the slots)', () => {
  const groups = ['CTRL', 'KO', 'DKO'];
  let comps = [], slots = { target: '', reference: '' };
  let r = B.dropOnSlot(comps, slots, 'target', 'KO', groups);
  assert.deepEqual([r.slots, r.added, r.error], [{ target: 'KO', reference: '' }, 0, '']);
  r = B.dropOnSlot(r.comps, r.slots, 'reference', 'CTRL', groups);
  assert.equal(r.added, 1);
  assert.deepEqual(r.comps, [{ target: 'KO', reference: 'CTRL', id: '' }]);
  assert.deepEqual(r.slots, { target: '', reference: '' }, 'slots are emptied after an add');
  comps = r.comps;
  // same group on both, an unknown group, a duplicate, a bad slot
  r = B.dropOnSlot(comps, { target: 'KO', reference: '' }, 'reference', 'KO', groups);
  assert.match(r.error, /same group/); assert.equal(r.added, 0); assert.deepEqual(r.slots, { target: 'KO', reference: 'KO' });
  assert.match(B.dropOnSlot(comps, slots, 'target', 'nope', groups).error, /not in the table/);
  r = B.dropOnSlot(comps, { target: 'KO', reference: '' }, 'reference', 'CTRL', groups);
  assert.match(r.error, /already in the list/); assert.equal(r.comps.length, 1);
  assert.match(B.dropOnSlot(comps, slots, 'middle', 'KO', groups).error, /Unknown slot/);
  assert.equal(B.dropOnSlot(comps, { target: 'KO', reference: '' }, 'target', '', groups).slots.target, '', 'an empty drop clears the slot');
  // tapping chips: the next empty slot is filled
  assert.equal(B.nextSlot({ target: '', reference: '' }), 'target');
  assert.equal(B.nextSlot({ target: 'KO', reference: '' }), 'reference');
  assert.equal(B.nextSlot({ target: 'KO', reference: 'CTRL' }), '');
});

test('the select fallback (no drag and drop): fill both selects, then Add comparison; all-vs-one; remove; ids', () => {
  const groups = ['CTRL', 'KO', 'DKO'];
  let slots = B.fillSlot({ target: '', reference: '' }, 'target', 'DKO', groups).slots;
  assert.deepEqual(B.submitSlots([], slots, groups).comps, [], 'one slot is not enough');
  assert.match(B.submitSlots([], slots, groups).error, /target and a reference/);
  slots = B.fillSlot(slots, 'reference', 'CTRL', groups).slots;
  const r = B.submitSlots([], slots, groups);
  assert.deepEqual(r.comps, [{ target: 'DKO', reference: 'CTRL', id: '' }]);
  assert.deepEqual(r.slots, { target: '', reference: '' });
  // all vs one reference: every other group, existing ones kept, no duplicates
  const all = B.allVsReference(r.comps, 'CTRL', groups);
  assert.deepEqual(all.comps.map((c) => `${c.target}_vs_${c.reference}`), ['DKO_vs_CTRL', 'KO_vs_CTRL']);
  assert.equal(all.added, 1);
  assert.match(B.allVsReference(all.comps, 'CTRL', groups).error, /already compared/);
  assert.match(B.allVsReference([], '', groups).error, /Choose the reference/);
  assert.equal(B.defaultReference(['KO', 'Control', 'DKO']), 'Control');
  assert.equal(B.defaultReference(['KO', 'DKO']), 'KO');
  // remove and ids
  assert.deepEqual(B.removeComparison(all.comps, 0).map((c) => c.target), ['KO']);
  let c = B.setComparisonId(all.comps, 0, 'my id!');
  assert.equal(c[0].id, 'my_id_');
  assert.equal(B.setComparisonId(c, 0, 'DKO_vs_CTRL')[0].id, '', 'the automatic id is stored as automatic');
  assert.equal(B.setComparisonId(c, 0, '')[0].id, '');
  const res = B.resolveComparisons([{ target: 'KO', reference: 'CTRL', id: 'x' }, { target: 'DKO', reference: 'CTRL', id: 'x' }, { target: 'gone', reference: 'CTRL', id: '' }], groups);
  assert.deepEqual(res.map((x) => [x.id, x.valid]), [['x', true], ['x_2', true], ['gone_vs_CTRL', false]], 'ids are made unique; a missing group is invalid');
  assert.equal(B.comparisonId('KO (48h)', 'WT/ctrl'), 'KO_48h_vs_WT_ctrl');
  // a comparison whose group left the table is left out of the CSV and noted
  const st = B.normalize(mapSpec, { assay: 'atacseq', project: '/p', samples: [row('A_1', 'A'), row('B_1', 'B')], comparisons: [{ target: 'B', reference: 'A', id: '' }, { target: 'C', reference: 'A', id: '' }] });
  assert.deepEqual(heredocs(cmdLines(mapSpec, st))["'/p'/inputs/contrasts.csv"], ['id,variable,reference,target', 'B_vs_A,condition,A,B']);
  assert.match(text(mapSpec, st), /# Left out of contrasts\.csv \(a group is not in the table\): C vs A/);
});

test('the table and comparisons live in the address compactly, and as a small JSON file', () => {
  const rows = [row('WT_REP1', 'WT', '1'), row('x~y!z%1', 'we~ird!', '2', { antibody: 'H3 K27ac' }), row('ünï_1', 'ünï', '1')];
  const comps = [{ target: 'we~ird!', reference: 'WT', id: 'my_id' }, { target: 'ünï', reference: 'WT', id: '' }];
  const st = { assay: 'chipseq', project: '/p', samples: rows, comparisons: comps };
  const h = B.toHash(mapSpec, st);
  assert.ok(!/[ '\n]/.test(h));
  const back = B.fromHash(mapSpec, '#' + h);
  assert.deepEqual(back.samples, rows);
  assert.deepEqual(back.comparisons, comps);
  assert.equal(text(mapSpec, back), text(mapSpec, st));
  assert.equal(B.toHash(mapSpec, {}), '', 'nothing stored for an empty table');
  assert.ok(B.toHash(mapSpec, { assay: 'atacseq', samples: [B.blankRow()] }) === 'assay=atacseq', 'blank rows are not stored');
  // rows the pasted list brings back on its own are not repeated in the address
  const names = 'WT_REP1_R1.fastq.gz\nWT_REP1_R2.fastq.gz\nKO_REP1_R1.fastq.gz\nKO_REP1_R2.fastq.gz';
  const listed = B.normalize(mapSpec, { assay: 'atacseq', fastq_list: names });
  assert.ok(!/(^|&)s=/.test(B.toHash(mapSpec, listed)));
  listed.samples[0].group = 'Wild';
  const hl = B.toHash(mapSpec, listed);
  assert.match(hl, /(^|&)s=KO_REP1~Wild~1$/, 'only the edited row');
  assert.deepEqual(B.fromHash(mapSpec, '#' + hl).samples.map((r) => [r.sample, r.group]), [['KO_REP1', 'Wild'], ['WT_REP1', 'WT']]);
  // too big for the address: left out, with a way to say so; the JSON keeps everything
  const big = Array.from({ length: 400 }, (_, i) => row(`Sample_number_${i}_REP1`, `Group_${i % 20}`, '1'));
  assert.equal(B.hashTooBig(mapSpec, { assay: 'atacseq', samples: big }), true);
  assert.ok(B.toHash(mapSpec, { assay: 'atacseq', samples: big }).length < B.HASH_LIMIT);
  assert.equal(B.hashTooBig(mapSpec, st), false);
  const json = B.samplesToJson(big, comps);
  assert.ok(json.length < 100000);
  const j = B.samplesFromJson(json);
  assert.equal(j.ok, true); assert.equal(j.rows.length, 400); assert.deepEqual(j.comps, comps);
  assert.deepEqual(B.samplesFromJson(B.samplesToJson(rows, comps)).rows, rows);
  assert.match(B.samplesFromJson('not json').error, /not JSON/);
  assert.match(B.samplesFromJson('{"format":"other","samples":[]}').error, /Not a saved state/);
  assert.match(B.samplesFromJson('x'.repeat(B.CSV_MAX_BYTES + 1)).error, /too large/);
  // hostile values are cleaned on the way in
  const hostile = B.fromHash(mapSpec, '#s=' + encodeURIComponent('a\nb~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~') + '&c=a~a');
  assert.ok(hostile.samples.every((r) => !/\n/.test(r.sample)));
  assert.deepEqual(B.fromHash(mapSpec, '#c=a~a').comparisons.length, 1, 'a comparison of a group with itself is kept in state, dropped from the output');
  assert.equal(B.contrastLines(B.resolveComparisons([{ target: 'a', reference: 'a', id: '' }], ['a'])).length, 0);
});

// ---------------------------------------------------------------- 4. the pages
test('map page: ATAC / ChIP / PRO-seq write metadata.csv and contrasts.csv next to the samplesheet, before check and map', () => {
  for (const assay of ['atacseq', 'chipseq', 'proseq']) {
    const st = { assay, project: '/p', fastq_dir: '/f', fastq_list: 'WT_1_R1.fastq.gz\nWT_1_R2.fastq.gz\nWT_2_R1.fastq.gz\nWT_2_R2.fastq.gz\nKO_1_R1.fastq.gz\nKO_1_R2.fastq.gz', comparisons: [{ target: 'KO', reference: 'WT', id: '' }] };
    const lines = cmdLines(mapSpec, st), at = (s) => lines.findIndex((l) => l.startsWith(s));
    const files = heredocs(lines);
    assert.deepEqual(Object.keys(files), ["'/p'/inputs/samplesheet.csv", "'/p'/inputs/metadata.csv", "'/p'/inputs/contrasts.csv"], assay);
    assert.ok(at("cat > '/p'/inputs/samplesheet.csv") < at("cat > '/p'/inputs/metadata.csv") && at("cat > '/p'/inputs/contrasts.csv") < at(`lab-${assay} check`), assay);
    assert.ok(at(`lab-${assay} init`) < at("cat > '/p'/inputs/samplesheet.csv"));
    assert.deepEqual(files["'/p'/inputs/metadata.csv"].slice(1).map((l) => l.split(',')[0]), ['KO_1', 'WT_1', 'WT_2']);
    assert.match(text(mapSpec, st), /replaces the header-only file init wrote/);
    // without comparisons: metadata only, with a hint
    const none = { ...st, comparisons: [] };
    assert.deepEqual(Object.keys(heredocs(cmdLines(mapSpec, none))).length, 2);
    assert.match(text(mapSpec, none), /Define comparisons above to write inputs\/contrasts\.csv too/);
  }
  // public data: the table comes from a dropped CSV, and is written once the project exists
  const pub = cmdLines(mapSpec, { assay: 'atacseq', input: 'public', project: '/p', accessions: 'SRR1', samples: [row('A_1', 'A', '1')] });
  assert.ok(pub.findIndex((l) => l.startsWith('lab-atacseq init')) < pub.findIndex((l) => l.startsWith("cat > '/p'/inputs/metadata.csv")));
});

test('map page, RNA-seq: the comparisons are an optional extra (saved as contrasts.csv, setup drafts its own later), metadata is not written', () => {
  const base = { assay: 'rnaseq', exp: '/e', fastq_dir: '/f', fastq_list: 'WT_REP1_R1.fastq.gz\nWT_REP1_R2.fastq.gz\nKO_REP1_R1.fastq.gz\nKO_REP1_R2.fastq.gz', comparisons: [{ target: 'KO', reference: 'WT', id: '' }] };
  assert.ok(B.normalize(mapSpec, base).samples.length === 2, 'the listing fills the table for RNA-seq too');
  assert.deepEqual(Object.keys(heredocs(cmdLines(mapSpec, base))), [], 'nothing without the box');
  const on = cmdLines(mapSpec, { ...base, rna_contrasts: true });
  assert.deepEqual(heredocs(on), { 'contrasts.csv': ['id,variable,reference,target', 'KO_vs_WT,condition,WT,KO'] });
  assert.ok(on.findIndex((l) => l.startsWith('cat > contrasts.csv')) < on.findIndex((l) => l.startsWith('lab-rnaseq map --dry-run')));
  assert.match(text(mapSpec, { ...base, rna_contrasts: true }), /nothing reads it yet: lab-rnaseq setup .* drafts its own analysis\/inputs\/contrasts\.csv/);
  assert.ok(!cmdLines(mapSpec, { ...base, rna_contrasts: true }).some((l) => /metadata/.test(l)));
  assert.ok(B.allFields(mapSpec).find((f) => f.id === 'rna_contrasts').when.includes('assay=rnaseq'));
});

test('RNA-seq analysis page: "Define comparisons here" rewrites analysis/inputs/contrasts.csv right after setup (nf-core and FASTQ input)', () => {
  for (const input of ['nfcore', 'fastq']) {
    const st = { input, exp: '/e', fastq_dir: '/f', samples: TABLE_ROWS, comparisons: COMPS };
    assert.ok(!Object.keys(heredocs(cmdLines(rnaSpec, st))).length, 'only when asked for');
    const lines = cmdLines(rnaSpec, { ...st, define_comps: true });
    const at = (s) => lines.findIndex((l) => l.startsWith(s));
    assert.deepEqual(heredocs(lines), { 'analysis/inputs/contrasts.csv': ['id,variable,reference,target', 'KO_vs_WT,condition,WT,KO'] });
    assert.ok(at('lab-rnaseq setup') < at('cat > analysis/inputs/contrasts.csv') && at('cat > analysis/inputs/contrasts.csv') < at('lab-rnaseq check'));
    assert.match(text(rnaSpec, { ...st, define_comps: true }), /# This overwrites analysis\/inputs\/contrasts\.csv, the draft setup just wrote/);
    assert.deepEqual(cmdLines(rnaSpec, { ...st, define_comps: true, comparisons: [] }).filter((l) => l.startsWith('cat >')), []);
  }
});

test('RNA-seq analysis page, count matrix: metadata.csv and contrasts.csv heredocs, then run uses them', () => {
  const st = { input: 'matrix', exp: '/e', matrix: '/m.tsv', metadata: '/mine.csv', samples: TABLE_ROWS, comparisons: COMPS };
  const lines = cmdLines(rnaSpec, st);
  assert.deepEqual(Object.keys(heredocs(lines)), ['analysis/inputs/metadata.csv', 'analysis/inputs/contrasts.csv']);
  const runs = lines.filter((l) => l.startsWith('lab-rnaseq run'));
  assert.equal(runs.length, 2);
  for (const l of runs) assert.ok(l.includes('--metadata analysis/inputs/metadata.csv') && !l.includes('/mine.csv'), l);
  assert.ok(lines.indexOf('mkdir -p analysis/inputs') < lines.findIndex((l) => l.startsWith('cat > analysis/inputs/metadata.csv')));
  assert.ok(lines.findIndex((l) => l.startsWith('cat > analysis/inputs/contrasts.csv')) < lines.findIndex((l) => l.startsWith('lab-rnaseq run')));
  assert.deepEqual(B.allFields(rnaSpec).find((f) => f.id === 'metadata').when, ['input=matrix', '!meta_has'], 'the metadata path field is hidden when the table writes the file');
  // an empty table keeps the old behaviour: the user's own metadata file, drafted contrasts
  const old = cmdLines(rnaSpec, { ...st, samples: [], comparisons: [] });
  assert.ok(old.some((l) => l.startsWith("lab-rnaseq run --dry-run") && l.includes("--metadata '/mine.csv'")));
  assert.ok(!old.some((l) => l.startsWith('cat >') || l === 'mkdir -p analysis/inputs'));
  assert.match(text(rnaSpec, { ...st, samples: [], comparisons: [] }), /drafted: every group against the first one/);
});

test('the block says files are read in the browser and never uploaded; the script has no network call', () => {
  const src = readFileSync(path.join(root, 'docs/assets/builder.js'), 'utf8');
  assert.match(src, /read in your browser \(FileReader\) and are never uploaded/);
  assert.ok(!/XMLHttpRequest|navigator\.sendBeacon|fetch\([^)]*(POST|body)/.test(src));
  assert.equal((src.match(/fetch\(/g) || []).length, 1, 'the only fetch loads the page spec');
});

test('all three pages carry the nav "Map reads" | "RNA-seq analysis" | "Proteomics", the right one current, one asset version', () => {
  const read = (f) => readFileSync(path.join(root, 'docs', f), 'utf8');
  const pages = { 'map.html': 0, 'index.html': 1, 'proteomics.html': 2 };
  const nav = (h) => [...(/<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(h)[1]).matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map((m) => [m[1], !!m[2], m[3]]);
  for (const [f, current] of Object.entries(pages)) {
    const items = nav(read(f));
    assert.deepEqual(items.map((i) => i[2]), ['Map reads', 'RNA-seq analysis', 'Proteomics']);
    assert.deepEqual(items.map((i) => i[0]), ['map.html', './', 'proteomics.html']);
    assert.deepEqual(items.map((i) => i[1]), [0, 1, 2].map((i) => i === current));
    for (const id of ['theme-btn', 'copy-btn', 'download-btn', 'copy-status', 'out', 'builder-form']) assert.ok(read(f).includes(`id="${id}"`), `${f} ${id}`);
  }
  const prot = read('proteomics.html');
  assert.match(prot, /<title>Proteomics · Shechter Lab<\/title>/);
  assert.match(prot, /window\.BUILDER_SPEC = 'data\/proteomics\.json'/);
  const v = (h) => [/builder\.css\?v=(\w+)/.exec(h)[1], /builder\.js\?v=(\w+)/.exec(h)[1], /BUILDER_VERSION = '(\w+)'/.exec(h)[1]];
  assert.equal(new Set(Object.keys(pages).flatMap((f) => v(read(f)))).size, 1);
  assert.match(read('map.html'), /<h2 id="out-h">6\. Commands/); assert.match(read('index.html'), /<h2 id="out-h">5\. Commands/);
  // section titles are numbered in order
  for (const [s, n] of [[mapSpec, 5], [rnaSpec, 4], [protSpec, 4]]) {
    const nums = s.sections.map((x) => /^(\d+)\./.exec(x.title)?.[1]).filter(Boolean).map(Number);
    assert.deepEqual(nums, Array.from({ length: n }, (_, i) => i + 1), s.title);
  }
});

// ---------------------------------------------------------------- 5. proteomics
// every way to fill the page: all selects x checkboxes x text fields
function protStates() {
  const out = [];
  const imps = B.allFields(protSpec).find((f) => f.id === 'imputation').options, fdrs = B.allFields(protSpec).find((f) => f.id === 'fdr').options;
  for (const [i, imputation] of imps.entries()) for (const significance of ['padj', 'pvalue']) for (const dry_run of [false, true]) for (const full of [false, true]) {
    out.push({ project: full ? "/p/it's a project" : '', proj_name: full ? 'my "prot" $(id)' : '', protein_data: full ? '/d/protein groups.txt' : '', imputation, significance, dry_run, install: full,
      fdr: fdrs[(i + (full ? 1 : 0)) % fdrs.length], padj: full ? '0.05' : '', pvalue: full ? '0.2' : '', log2fc: full ? '1' : '', account: full ? 'acc' : '', partition: full ? 'part' : '', run_name: full ? 'r 1' : '',
      columns: 'LFQ intensity Ctrl_1\nLFQ intensity Ctrl_2\nLFQ intensity KO_1\nLFQ intensity KO_2', comparisons: [{ target: 'KO', reference: 'Ctrl', id: '' }] });
  }
  return out;
}

test('proteomics: every lab-proteomics command the page can write uses real subcommands and flags (proteomics_cli.json)', () => {
  const cli = clis['lab-proteomics'];
  assert.equal(cli.pipeline, 'lab-proteomics');
  for (const s of ['init', 'check', 'analyze', 'status', 'report']) assert.ok(cli.subcommands[s], s);
  assert.ok(!cli.subcommands.config, 'proteomics has no `config set`: the page edits the YAML');
  let n = 0;
  const seen = new Set();
  for (const st of protStates()) for (const line of cmdLines(protSpec, st)) {
    if (!line.startsWith('lab-')) continue;
    n++; seen.add(line.split(' ')[1]);
    assert.deepEqual(problems(clis, line), []);
  }
  assert.ok(n > 200);
  assert.deepEqual([...seen].sort(), ['analyze', 'check', 'init', 'report', 'status']);
  // the spec's own templates, flag by flag
  for (const step of protSpec.steps) for (const b of step.blocks) for (const l of b.lines) {
    const w = l.words || [];
    if (w[0] !== 'lab-proteomics') continue;
    const sub = cli.subcommands[w[1]];
    assert.ok(sub, `lab-proteomics has no ${w[1]}`);
    for (const x of w) { const flag = typeof x === 'string' ? (x.startsWith('--') ? x : null) : x.flag; if (flag) assert.ok(sub.options.some((o) => o.flags.includes(flag)), `${w[1]} ${flag}`); }
  }
  assert.ok(problems(clis, 'lab-proteomics analyze --project-dir p --config c').length, 'the checker sees a missing --contrasts');
  assert.ok(problems(clis, 'lab-proteomics config set a.b c').length);
  assert.ok(problems(clis, 'lab-proteomics check --project-dir p').length, '--config is required');
});

// the `key=value` arguments of the python config edit in a rendered command list
function configArgs(lines) {
  const l = lines.find((x) => x.startsWith('python3 - '));
  const words = B.shellWords(l.split('\n')[0].replace(/ <<'PY'$/, '')).map((w) => w.v);
  return { file: words[2], pairs: words.slice(3).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]) };
}

test('proteomics config edits: every key is in the config schema with the right type, values are valid', () => {
  const keys = new Set();
  for (const st of protStates()) for (const [k, v] of configArgs(cmdLines(protSpec, st)).pairs) {
    keys.add(k);
    assert.ok(k in protKeys, `${k} is not a key of the proteomics config schema (docs/data/proteomics_config_keys.json)`);
    if (protKeys[k] === 'number') assert.ok(Number.isFinite(Number(v)), `${k} ${v}`);
    if (k === 'analysis.significance_column') assert.ok(['padj', 'pvalue'].includes(v));
    if (k === 'imputation.method') assert.ok(['GSimp', 'MinProb', 'knn', 'bpca', 'RF', 'knn_GSimp', 'bpca_MinProb'].includes(v));
    if (k === 'analysis.fdr_correction') assert.ok(["Strimmer's qvalue(t)", "Strimmer's qvalue(p)", 'BH', "Storey's qvalue"].includes(v));
  }
  for (const c of Object.values(protSpec.config)) assert.ok(keys.has(c.key), `config key ${c.key} is never written`);
  assert.equal(protKeys['analysis.significance_column'], 'string'); assert.equal(protKeys['analysis.padj_threshold'], 'number');
  // unchanged advanced values write nothing; thresholds only for the chosen significance column
  const dflt = configArgs(cmdLines(protSpec, { project: '/p' })).pairs.map((p) => p[0]);
  assert.deepEqual(dflt, ['project.name', 'input.protein_data', 'input.experimental_design']);
  const p1 = configArgs(cmdLines(protSpec, { project: '/p', significance: 'pvalue', padj: '0.3', pvalue: '0.2' })).pairs.map((p) => p.join('='));
  assert.ok(p1.includes('analysis.pvalue_threshold=0.2') && !p1.some((x) => x.startsWith('analysis.padj_threshold')));
  assert.ok(!configArgs(cmdLines(protSpec, { project: '/p', padj: '0.1' })).pairs.some((p) => /threshold/.test(p[0])));
  assert.ok(!configArgs(cmdLines(protSpec, { project: '/p', padj: 'abc' })).pairs.some((p) => /threshold/.test(p[0])), 'a non-number is not written');
});

// the config `init` really writes (tests/fixtures/proteomics_project_config.yaml; the next test checks it against a fresh init)
function editFixture(st, name = 'edit') {
  const dir = mkdtempSync(path.join(tmpdir(), `${name}-`)), proj = path.join(dir, 'my_prot');
  mkdirSync(path.join(proj, 'inputs'), { recursive: true });
  writeFileSync(path.join(proj, 'inputs/project_config.yaml'), readFileSync(path.join(root, 'tests/fixtures/proteomics_project_config.yaml')));
  const lines = cmdLines(protSpec, { ...st, project: proj });
  const cmd = lines.find((l) => l.startsWith('python3 - '));
  const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { cfg: path.join(proj, 'inputs/project_config.yaml'), proj, cmd, lines };
}
const loadYaml = (file) => {
  const r = spawnSync('python3', ['-c', 'import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('proteomics config edit: the python edit changes the config init writes, keeps comments, adds missing keys, is idempotent', { skip: haveYaml ? false : 'PyYAML is not installed' }, () => {
  const original = readFileSync(path.join(root, 'tests/fixtures/proteomics_project_config.yaml'), 'utf8');
  const before = loadYaml(path.join(root, 'tests/fixtures/proteomics_project_config.yaml'));
  assert.equal(before.imputation.method, 'GSimp'); assert.ok(!('significance_column' in before.analysis), 'init does not write significance_column: the edit must add it');
  const st = { protein_data: '/d/it\'s a table.txt', imputation: 'bpca_MinProb', significance: 'pvalue', pvalue: '0.2', log2fc: '1', fdr: "Strimmer's qvalue(p)", account: 'lab acct', partition: 'short' };
  const { cfg, proj, cmd } = editFixture(st);
  const cfgNow = loadYaml(cfg);
  assert.equal(cfgNow.input.protein_data, "/d/it's a table.txt");
  assert.equal(cfgNow.input.experimental_design, path.join(proj, 'inputs/experimental_design.csv'));
  assert.equal(cfgNow.imputation.method, 'bpca_MinProb');
  assert.equal(cfgNow.analysis.significance_column, 'pvalue');
  assert.equal(cfgNow.analysis.pvalue_threshold, 0.2);
  assert.equal(cfgNow.analysis.log2fc_threshold, 1);
  assert.equal(cfgNow.analysis.fdr_correction, "Strimmer's qvalue(p)");
  assert.equal(cfgNow.project.slurm_account, 'lab acct');
  assert.equal(cfgNow.slurm.partition, 'short');
  assert.equal(cfgNow.project.name, 'my_prot', 'init leaves the example project name: the edit sets the folder name');
  assert.equal(cfgNow.analysis.padj_threshold, 0.1, 'untouched keys keep their values');
  assert.equal(cfgNow.analysis.n_clusters, 6);
  // comments survive (only the changed lines differ), the file ends with one newline
  const after = readFileSync(cfg, 'utf8');
  const comments = (t) => t.split('\n').filter((l) => /^\s*#/.test(l));
  assert.deepEqual(comments(after).filter((l) => !/partition: <name>/.test(l)), comments(original).filter((l) => !/partition: <name>/.test(l)));
  assert.ok(after.endsWith('\n') && !after.endsWith('\n\n'));
  assert.match(after, /method: bpca_MinProb   # or: knn, bpca_MinProb, RF, etc\./, 'a trailing comment on the line is kept');
  // running it again changes nothing
  assert.equal(spawnSync('bash', ['-c', cmd], { cwd: path.dirname(proj), encoding: 'utf8' }).status, 0);
  assert.equal(readFileSync(cfg, 'utf8'), after);
  // a project name typed on the page wins over the folder's; defaults write only the paths and the name
  const named = editFixture({ proj_name: 'My "quoted" project' });
  assert.equal(loadYaml(named.cfg).project.name, 'My "quoted" project');
  const dflt = loadYaml(editFixture({}).cfg);
  assert.equal(dflt.imputation.method, 'GSimp'); assert.ok(!('significance_column' in dflt.analysis));
  assert.equal(dflt.input.protein_data, '/path/to/proteinGroups.txt');
  // a tilde is expanded by the script (the shell does not expand it after key=)
  const tilde = editFixture({ protein_data: '~/data/pg.txt' });
  assert.equal(loadYaml(tilde.cfg).input.protein_data, path.join(process.env.HOME || '', 'data/pg.txt'));
});

labTest('proteomics config: the fixture is what `lab-proteomics init` writes, and lab-proteomics loads the edited file (schema-valid)', { skip: haveYaml ? false : 'PyYAML is not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'init-'));
  const env = { PYTHONPATH: [path.join(lab, 'lab-ngs-core'), path.join(lab, 'lab-proteomics/src')].join(':') };
  const init = spawnSync('python3', ['-m', 'lab_proteomics', 'init', '--project-dir', path.join(dir, 'my_prot')], { env: { ...process.env, ...env, LAB_PIPELINES_LAB_CONFIG: 'none', LAB_PIPELINES_SITE: 'none' }, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(readFileSync(path.join(dir, 'my_prot/inputs/project_config.yaml'), 'utf8'), readFileSync(path.join(root, 'tests/fixtures/proteomics_project_config.yaml'), 'utf8'), 'fixture drifted: copy the new init output over tests/fixtures/proteomics_project_config.yaml');
  const header = (f) => readFileSync(path.join(dir, 'my_prot/inputs', f), 'utf8').trim();
  assert.equal(header('experimental_design.csv'), 'label,condition,replicate');
  assert.equal(header('contrasts.csv'), 'id,variable,reference,target');
  // every option of the page loads through load_project_config (schema validation included) and analyze --dry-run takes the files
  for (const st of protStates().filter((_, i) => i % 7 === 0)) {
    const { cfg, proj, lines } = editFixture(st);
    const r = py(`import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(lab, 'lab-ngs-core'))}); sys.path.insert(0, ${JSON.stringify(path.join(lab, 'lab-proteomics/src'))})
from lab_proteomics.cli import load_config
c = load_config(sys.argv[1])
print(json.dumps([c['imputation']['method'], c['analysis'].get('significance_column', 'padj'), c['analysis']['fdr_correction'], c['input']['protein_data']]))`, [cfg]);
    assert.equal(r.status, 0, r.stderr);
    const [imp, sig] = JSON.parse(r.stdout);
    assert.equal(imp, st.imputation); assert.equal(sig, st.significance);
    // the contrasts and design the page writes pass the pipeline's own readers
    const files = heredocs(lines);
    for (const [k, body] of Object.entries(files)) writeFileSync(path.join(proj, 'inputs', path.basename(k.replace(/'/g, ''))), body.join('\n') + '\n');
    const a = spawnSync('python3', ['-m', 'lab_proteomics', 'analyze', '--project-dir', proj, '--config', cfg, '--contrasts', path.join(proj, 'inputs/contrasts.csv'), '--run-name', 'tst', '--dry-run'],
      { env: { ...process.env, ...env, LAB_PIPELINES_LAB_CONFIG: 'none', LAB_PIPELINES_SITE: 'none' }, encoding: 'utf8' });
    assert.equal(a.status, 0, a.stderr + a.stdout);
    assert.ok(existsSync(path.join(proj, 'results/tst/KO_vs_Ctrl')), 'one job folder for the comparison');
  }
});

test('proteomics page text: the design and contrasts come from the table, no lab paths or accounts, valid bash', () => {
  for (const st of protStates().filter((_, i) => i % 3 === 0)) {
    const t = B.toScript(protSpec, text(protSpec, st));
    assert.equal(spawnSync('bash', ['-n'], { input: t, encoding: 'utf8' }).status, 0, t);
  }
  const t = text(protSpec, { columns: 'LFQ intensity Ctrl_1\nLFQ intensity KO_1', comparisons: [{ target: 'KO', reference: 'Ctrl', id: '' }] });
  assert.match(t, /cat > \/path\/to\/project\/inputs\/experimental_design\.csv <</);
  assert.ok(!/\/home\/|\/data\/|\bshechter\b|SLURM_|--account/i.test(t.replace(/Shechterlab\/lab_pipelines/g, '')), 'no lab paths or accounts');
  assert.match(text(protSpec, { install: true }), /bash setup\.sh --only proteomics\n/);
  assert.match(text(protSpec, {}), /analyze stops with 'No valid contrasts found'/);
  assert.match(text(protSpec, {}), /header-only experimental_design\.csv/);
  // the hint says what the table needs
  assert.match(protSpec.sections[1].fields.find((f) => f.id === 'protein_data').hint, /Accession and Description \(or Symbol\) .* underscore/);
  // dry run: no submit, status or report
  const dry = cmdLines(protSpec, { dry_run: true }).filter((l) => l.startsWith('lab-proteomics'));
  assert.deepEqual(dry.map((l) => l.split(' ')[1]), ['init', 'check', 'analyze']);
  assert.ok(dry[2].endsWith('--dry-run'));
});

test('with a table and comparisons, every command of the map and RNA-seq pages is still a valid lab command and valid bash', () => {
  const ROWS = [row('WT_REP1', 'WT', '1'), row('WT_REP2', 'WT', '2'), row('KO_REP1', 'KO', '1'), row('KO_REP2', 'KO', '2')];
  let n = 0;
  for (const assay of ['rnaseq', 'atacseq', 'chipseq', 'proseq']) for (const input of ['fastq', 'public']) for (const dry_run of [false, true]) for (const rna_contrasts of [false, true]) {
    const st = { assay, input, dry_run, rna_contrasts, exp: '/e', project: '/p', fastq_list: 'WT_REP1_R1.fastq.gz\nWT_REP1_R2.fastq.gz', accessions: 'SRR1', samples: ROWS, comparisons: COMPS };
    for (const l of cmdLines(mapSpec, st)) { n++; assert.deepEqual(problems(clis, l), []); }
    assert.equal(spawnSync('bash', ['-n'], { input: B.toScript(mapSpec, text(mapSpec, st)), encoding: 'utf8' }).status, 0);
  }
  for (const input of ['fastq', 'nfcore', 'matrix']) for (const define_comps of [false, true]) for (const dry_run of [false, true]) for (const isoforms of [false, true]) for (const withTable of [false, true]) {
    const st = { input, define_comps, dry_run, isoforms, exp: '/e', matrix: '/m.tsv', metadata: '/x.csv', fastq_dir: '/f', samples: withTable ? ROWS : [], comparisons: withTable ? COMPS : [], account: 'a' };
    for (const l of cmdLines(rnaSpec, st)) { n++; assert.deepEqual(problems(clis, l), []); }
    assert.equal(spawnSync('bash', ['-n'], { input: B.toScript(rnaSpec, text(rnaSpec, st)), encoding: 'utf8' }).status, 0);
  }
  assert.ok(n > 400);
  // the new heredoc form for commands (python3 - ... <<'PY') is bash-valid and keeps the delimiter unique
  assert.equal(spawnSync('bash', ['-n'], { input: text(protSpec, { project: '/p' }), encoding: 'utf8' }).status, 0);
});
