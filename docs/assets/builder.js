/* Command builders (RNA-seq analysis, map reads). The commands come from the page's spec in data/*.json
   (rnaseq.json, map.json: steps, fields, templates); this file only evaluates that spec. The same code runs under node for tests/check_spec.mjs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RnaseqBuilder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ shell quoting
  function oneLine(v) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim(); }
  // pasted lists (a textarea): lines kept, blank lines and trailing spaces dropped, size capped
  function multiLine(v, lineMax) {
    return String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n').slice(0, 5000)
      .map(function (l) { return l.replace(/\s+$/, '').slice(0, lineMax || 400); })
      .filter(function (l) { return l.trim(); }).join('\n').slice(0, 200000);
  }

  // single quotes, an embedded ' written as '\'' ; a leading ~ or ~/ stays outside the quotes so the shell expands it
  function shellQuote(v) {
    v = oneLine(v);
    if (v === '~') return '~';
    if (v.slice(0, 2) === '~/') {
      var rest = v.slice(2);
      return rest ? '~/' + shellQuote(rest) : '~/';
    }
    return "'" + v.replace(/'/g, "'\\''") + "'";
  }

  // ------------------------------------------------------------------ spec helpers
  function allFields(spec) {
    var out = [];
    spec.sections.forEach(function (s) { s.fields.forEach(function (f) { out.push(f); }); });
    return out;
  }

  function defaultState(spec) {
    var st = { input: 'fastq' };
    allFields(spec).forEach(function (f) {
      if (f.type === 'checkbox') st[f.id] = !!f.default;
      else if (f.type === 'checkgroup') st[f.id] = (f.default || []).slice();
      else st[f.id] = f.default != null ? f.default : '';
    });
    if (spec.samples) { st.samples = []; st.comparisons = []; }
    return st;
  }

  // a state that is safe to evaluate: unknown ids dropped, selects limited to their options, text on one line,
  // the rules the form enforces (count matrix has no isoforms; SpliceImpactR and sashimi need rMATS)
  function normalize(spec, raw) {
    var st = defaultState(spec);
    raw = raw || {};
    if ((spec.inputs || []).some(function (i) { return i.id === raw.input; })) st.input = raw.input;
    allFields(spec).forEach(function (f) {
      var v = raw[f.id];
      if (v === undefined || f.disabled) return;
      if (f.type === 'checkbox') st[f.id] = v === true || v === 'true' || v === '1';
      else if (f.type === 'checkgroup') {
        var list = Array.isArray(v) ? v : String(v).split(',');
        st[f.id] = f.options.filter(function (o) { return list.indexOf(o) >= 0; });
      } else if (f.type === 'select') {
        if (f.options.indexOf(String(v)) >= 0) st[f.id] = String(v);
      } else st[f.id] = f.type === 'textarea' ? multiLine(v, f.lineMax) : oneLine(v);
    });
    if (st.input === 'matrix') st.isoforms = false;
    Object.keys(spec.moduleRequires || {}).forEach(function (m) {
      if (!st[spec.moduleRequires[m]]) st[m] = false;
    });
    if (spec.samples) {                                   // the table and the comparisons (a pasted listing is merged into the table)
      st.samples = cleanRows(raw.samples); st.comparisons = cleanComps(raw.comparisons);
      var listed = listingRows(spec, st);
      if (listed) st.samples = mergeListing(st.samples, listed);
    }
    return st;
  }

  var PRESET_OF = { hg38: 'human', mm10: 'mouse' };

  function listText(spec, id, st) {
    var f = allFields(spec).filter(function (x) { return x.id === id; })[0];
    return f.options.filter(function (o) { return st[id].indexOf(o) >= 0; });
  }

  // ------------------------------------------------------------------ pasted FASTQ names -> samplesheet rows (map page)
  var FASTQ_GZ = /\.(fastq|fq)\.gz$/i;
  var READ_RE = /^(.*?)[._-](R?)([12])((?:_\d{3})?)$/i;          // CTRL_R1, CTRL.R2, CTRL_1, S1_L001_R1_001

  function cleanName(s) { return String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, ''); }

  // the file names (or paths) in a pasted `ls`, `ls -l` or `find` listing: {files:[{base, path}], skipped:[names]}
  function parseFastqNames(text, folder) {
    var files = [], skipped = [], seen = {};
    folder = String(folder || '').replace(/\/+$/, '');
    String(text || '').split('\n').forEach(function (raw) {
      var t = raw.trim();
      if (!t) return;
      var tok = t.split(/\s+/).pop();                               // `ls -l`: the name is the last column
      var base = tok.split('/').pop();
      if (!FASTQ_GZ.test(base) || /(^|[._-])(I[12]|Undetermined)([._-]|$)/i.test(base)) { skipped.push(tok); return; }
      var path = tok.indexOf('/') >= 0 ? tok : folder + '/' + tok;
      if (seen[path]) return;
      seen[path] = true;
      files.push({ base: base, path: path });
    });
    return { files: files, skipped: skipped };
  }

  // <sample>_S1_L001 -> <sample>: lane and bcl2fastq sample-number tokens dropped
  function sampleName(base, tail) {
    var lane = /[._-]L\d{3}(?=[._-]|$)/gi, hadLane = /[._-]L\d{3}(?=[._-]|$)/i.test(base);
    var n = base.replace(lane, '');
    if (hadLane || tail === '_001') n = n.replace(/[._-]S\d+$/i, '');
    return cleanName(n) || cleanName(base) || 'sample';
  }

  // pair R1/R2 (same name apart from the read token); a file without a mate is single-end;
  // singleEnd: every file is its own read 1. Returns rows [{sample, fastq1, fastq2}] sorted by sample
  function pairFastqs(files, singleEnd) {
    var groups = Object.create(null), order = [], lone = [], rows = [];
    files.forEach(function (f) {
      var stem = f.base.replace(/\.(fastq|fq)\.gz$/i, ''), m = READ_RE.exec(stem);
      if (!m) { rows.push({ sample: sampleName(stem, ''), fastq1: f.path, fastq2: '' }); return; }
      var e = { f: f, stem: stem, m: m }, key = m[1] + '\u0000' + m[4] + '\u0000' + (m[2] ? 'R' : 'n');
      if (singleEnd || (groups[key] && groups[key][m[3]])) { lone.push(e); return; }
      if (!groups[key]) { groups[key] = {}; order.push(key); }
      groups[key][m[3]] = e;
    });
    order.forEach(function (key) {
      var a = groups[key]['1'], b = groups[key]['2'];
      if (a && b) rows.push({ sample: sampleName(a.m[1], a.m[4]), fastq1: a.f.path, fastq2: b.f.path });
      else lone.push(a || b);
    });
    lone.forEach(function (e) {
      var base = e.m[2] ? e.m[1] : e.stem.slice(0, e.stem.length - e.m[4].length);      // CTRL_R1 -> CTRL, CTRL_1 stays
      rows.push({ sample: sampleName(base, e.m[4]), fastq1: e.f.path, fastq2: '' });
    });
    rows.sort(function (x, y) {
      return x.sample.localeCompare(y.sample, 'en', { numeric: true }) || x.fastq1.localeCompare(y.fastq1, 'en', { numeric: true });
    });
    return rows;
  }

  // replicate number from the name (see splitSample); '' when it holds none
  function replicateOf(sample) { return splitSample(sample).replicate; }

  function csvField(v) { v = String(v); return /[",]|^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  var CONTROL_RE = /(^|[._-])(input|igg)([._-]|$)/i;

  // the samplesheet of an assay (header and columns as the lab CLIs' templates), plus notes for the output
  function fastqSheet(assay, text, folder, singleEnd, strand, overrides) {
    var parsed = parseFastqNames(text, folder), rows = pairFastqs(parsed.files, singleEnd), notes = [], lines;
    var header = { atacseq: 'sample,fastq_1,fastq_2,replicate', chipseq: 'sample,fastq_1,fastq_2,replicate,antibody,control',
                   proseq: 'sample,fastq_1,fastq_2,strandedness' }[assay];
    if (!header || !rows.length) return { lines: [], notes: skippedNote(parsed.skipped), rows: rows };
    var edits = 0, noRep = [];
    overrides = overrides || {};                       // the samples table: its edits (name, replicate, antibody, control, strandedness) win
    lines = [header].concat(rows.map(function (r) {
      var ov = overrides[r.sample] || {}, name = ov.sample || r.sample;
      var rep = ov.replicate || replicateOf(r.sample), cols = [name, r.fastq1, r.fastq2];
      if (assay === 'proseq') cols.push(ov.strandedness || strand || 'forward');
      else {
        cols.push(rep);
        if (!rep && noRep.indexOf(name) < 0) noRep.push(name);
        if (assay === 'chipseq') {
          var c = CONTROL_RE.exec(r.sample), ab = ov.antibody || (c ? (c[2].toLowerCase() === 'igg' ? 'IgG' : 'Input') : ''), ctl = ov.control || '';
          if (!ab) { ab = 'EDIT_ANTIBODY'; edits++; }
          if (!ctl && !c && !/^(input|igg)$/i.test(ab)) { ctl = 'EDIT_CONTROL'; edits++; }
          cols.push(ab, ctl);
        }
      }
      return cols.map(csvField).join(',');
    }));
    var samples = {}, kinds = {}, paired = 0, single = 0, mixed = [];
    rows.forEach(function (r) {
      samples[r.sample] = true;
      (kinds[r.sample] = kinds[r.sample] || {})[r.fastq2 ? 'p' : 's'] = true;
      if (r.fastq2) paired++; else single++;
    });
    Object.keys(kinds).forEach(function (k) { if (kinds[k].p && kinds[k].s) mixed.push(k); });
    notes.push(parsed.files.length + ' FASTQ file(s) -> ' + Object.keys(samples).length + ' sample(s), ' + rows.length +
      ' row(s): ' + paired + ' paired-end, ' + single + ' single-end. Check the sample names; edit them in the sample column if needed.');
    if (mixed.length) notes.push('These samples mix paired and single-end files (nf-core wants one kind per sample): ' + mixed.slice(0, 5).join(', '));
    if (noRep.length) notes.push('No replicate number in the name of ' + noRep.slice(0, 5).join(', ') + (noRep.length > 5 ? ' ...' : '') + ': fill the replicate column.');
    if (edits) notes.push('ChIP / CUT&RUN / CUT&Tag: replace EDIT_ANTIBODY with each sample\'s antibody and EDIT_CONTROL with the sample name of its matched Input/IgG control (blank for the Input/IgG samples themselves).');
    return { lines: lines, notes: notes.concat(skippedNote(parsed.skipped)), rows: rows };
  }
  function skippedNote(list) {
    return list.length ? ['Left out (not a .fastq.gz / .fq.gz file, or an index / undetermined file): ' + list.slice(0, 5).join(', ') + (list.length > 5 ? ' (+' + (list.length - 5) + ' more)' : '')] : [];
  }

  // GEO / SRA / ENA / DDBJ accessions, as nf-core/fetchngs reads them (its schema_input.json pattern), one per line
  var ACCESSION_RE = /^(((SR|ER|DR)[APRSX])|(SAM(N|EA|D))|(PRJ(NA|EB|DB))|(GS[EM]))\d+$/;
  function parseAccessions(text) {
    var ids = [], bad = [], seen = {};
    String(text || '').split(/[\s,;]+/).forEach(function (t) {
      t = t.replace(/^["']+|["']+$/g, '').toUpperCase();
      if (!t || t === 'ACCESSION') return;
      if (!ACCESSION_RE.test(t)) { bad.push(t); return; }
      if (!seen[t]) { seen[t] = true; ids.push(t); }
    });
    return { ids: ids, notes: bad.length ? ['Left out (not a GEO / SRA / ENA / DDBJ accession): ' + bad.slice(0, 5).join(', ') + (bad.length > 5 ? ' (+' + (bad.length - 5) + ' more)' : '')] : [] };
  }

  // ------------------------------------------------------------------ samples & comparisons (the shared block)
  // The table is state.samples: rows {sample, group, replicate, antibody, control, strandedness, key}; the comparisons are
  // state.comparisons: {target, reference, id} (id '' = <target>_vs_<reference>). Everything here is DOM-free, so tests run it.
  var MAX_ROWS = 500, MAX_COMPS = 200, CELL_MAX = 120, CSV_MAX_BYTES = 1000000, HASH_LIMIT = 6000;
  var ROW_KEYS = ['sample', 'group', 'replicate', 'antibody', 'control', 'strandedness', 'key'];

  // What each pipeline reads next to its samplesheet / count table: lab_ngs_core/templates.py CSV_TEMPLATES
  // (`<pipeline>_metadata`, `proteomics_experimental_design`, `<pipeline>_contrasts`); tests/check_samples.mjs checks these
  // against a lab_pipelines checkout when one is next to this folder. `extras` are the table's columns after replicate.
  var TABLES = {
    rnaseq:     { meta: ['sample', 'condition', 'replicate'], extras: [], file: 'metadata.csv' },
    atacseq:    { meta: ['sample', 'condition', 'replicate'], extras: [], file: 'metadata.csv' },
    chipseq:    { meta: ['sample', 'condition', 'replicate', 'antibody'], extras: ['antibody', 'control'], file: 'metadata.csv' },
    proseq:     { meta: ['sample', 'condition', 'replicate'], extras: ['strandedness'], file: 'metadata.csv' },
    proteomics: { meta: ['label', 'condition', 'replicate'], extras: [], file: 'experimental_design.csv' }
  };
  var CONTRAST_HEADER = ['id', 'variable', 'reference', 'target'];     // every pipeline's <pipeline>_contrasts template

  function cell(v) { return oneLine(v).slice(0, CELL_MAX); }

  // group and replicate from a sample name: <group>_REP<n>, <group>_rep<n>, <group>_R<n>, a trailing _<n> / -<n> / .<n>
  function splitSample(name) {
    var s = oneLine(name), m;
    if ((m = /^(.+?)[._-]rep(?:licate)?[._-]?(\d+)$/i.exec(s)) || (m = /^(.+?)[._-]R(\d+)$/i.exec(s)) || (m = /^(.+?)[._-](\d{1,2})$/.exec(s))) {
      return { group: m[1], replicate: String(parseInt(m[2], 10)) };
    }
    return { group: s, replicate: '' };
  }
  // proteomics labels are intensity column names: "LFQ intensity WT_1", "Ctrl_1_LFQ"
  var PG_PREFIX = /^(?:MaxLFQ intensity|LFQ intensity|Intensity|iBAQ|Abundances?[^:]*:)\s+/i, PG_SUFFIX = /[._-](?:LFQ|MaxLFQ|Intensity|iBAQ)$/i;
  function labelStem(label) { return oneLine(label).replace(PG_PREFIX, '').replace(PG_SUFFIX, ''); }
  function derivedCells(pipe, name) { return splitSample(pipe === 'proteomics' ? labelStem(name) : name); }

  function blankRow() { return { sample: '', group: '', replicate: '', antibody: '', control: '', strandedness: '', key: '' }; }
  function cleanRows(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_ROWS).filter(function (r) { return r && typeof r === 'object'; }).map(function (r) {
      var out = blankRow();
      ROW_KEYS.forEach(function (k) { out[k] = cell(r[k]); });
      if (out.strandedness && ['auto', 'forward', 'reverse', 'unstranded'].indexOf(out.strandedness) < 0) out.strandedness = '';
      return out;
    });
  }
  function cleanComps(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_COMPS).filter(function (c) { return c && typeof c === 'object' && cell(c.target) && cell(c.reference); })
      .map(function (c) { return { target: cell(c.target), reference: cell(c.reference), id: cleanId(c.id) }; });
  }
  function cleanId(v) { return oneLine(v).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80); }
  function safeLabel(v) { return oneLine(v).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''); }

  function groupsOf(rows) {
    var seen = {}, out = [];
    (rows || []).forEach(function (r) { if (r.group && !seen[r.group]) { seen[r.group] = true; out.push(r.group); } });
    return out;
  }

  // ---- CSV in (a dropped or chosen file)
  function parseCsv(text) {
    text = String(text == null ? '' : text).replace(/^﻿/, '');
    var first = text.split(/\r\n|\r|\n/, 1)[0], delim = ',', best = -1;
    [',', '\t', ';'].forEach(function (d) { var n = first.split(d).length - 1; if (n > best) { best = n; delim = d; } });
    var rows = [], row = [], cur = '', quoted = false, i = 0, c;
    function endCell() { row.push(cur); cur = ''; }
    function endRow() {
      endCell();
      if (row.some(function (x) { return x.trim() !== ''; }) && !/^\s*#/.test(row[0])) rows.push(row);
      row = [];
    }
    while (i < text.length) {
      c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c;
      } else if (c === '"' && cur === '') quoted = true;
      else if (c === delim) endCell();
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
      else cur += c;
      i++;
    }
    if (cur !== '' || row.length) endRow();
    return rows;
  }

  var COLUMN_NAMES = {                     // header (lower case, spaces and dashes as _) -> what it is
    sample: ['sample', 'sample_id', 'sampleid', 'sample_name', 'samplename', 'name', 'label'],
    group: ['condition', 'group', 'treatment', 'sample_group', 'class'],
    replicate: ['replicate', 'rep', 'replicate_id', 'biological_replicate', 'bio_rep', 'biorep'],
    fastq_1: ['fastq_1', 'fastq1', 'fastq_r1', 'read1', 'r1'],
    fastq_2: ['fastq_2', 'fastq2', 'fastq_r2', 'read2', 'r2'],
    antibody: ['antibody', 'ab'],
    control: ['control', 'input_control', 'control_sample'],
    strandedness: ['strandedness', 'strand']
  };
  var COLUMN_ORDER = ['sample', 'group', 'replicate', 'fastq_1', 'fastq_2', 'antibody', 'control', 'strandedness'];

  // refuse what is not a small CSV before reading it: '' when fine, else the message for the page
  function checkCsvFile(name, size) {
    if (!/\.(csv|tsv)$/i.test(String(name || ''))) return '"' + String(name || 'This file').slice(0, 60) + '" is not a CSV file. Choose a .csv (or .tsv) with a header row.';
    if (!size) return 'The file is empty.';
    if (size > CSV_MAX_BYTES) return 'The file is too large (' + (size / 1e6).toFixed(1) + ' MB; the limit is ' + (CSV_MAX_BYTES / 1e6) + ' MB). A samplesheet or metadata table is a few KB.';
    return '';
  }

  // an nf-core samplesheet.csv, a metadata.csv or a proteomics experimental_design.csv -> table rows, with what was recognised.
  // {ok:false, error} for junk. pipe only matters for proteomics label names.
  function samplesFromCsv(text, pipe) {
    text = String(text == null ? '' : text);
    if (text.indexOf('\u0000') >= 0) return { ok: false, error: 'This does not look like a text CSV file (binary content).' };
    var table = parseCsv(text);
    if (table.length < 2) return { ok: false, error: 'No sample rows found: a CSV needs a header row and at least one sample.' };
    var header = table[0].map(function (h) { return h.trim().toLowerCase().replace(/[\s-]+/g, '_'); });
    if (header.length > 80) return { ok: false, error: 'Too many columns (' + header.length + ') for a sample table.' };
    var col = {}, as = {}, recognised = [];
    COLUMN_ORDER.forEach(function (field) {
      var names = COLUMN_NAMES[field], idx = -1, best = 99;
      header.forEach(function (h, i) {
        var rank = names.indexOf(h);
        if (rank >= 0 && rank < best && as[i] === undefined) { best = rank; idx = i; }
      });
      if (idx >= 0) { col[field] = idx; as[idx] = field; recognised.push({ column: table[0][idx].trim(), as: field }); }
    });
    if (col.sample === undefined) {
      return { ok: false, error: 'No sample column found. Looked for: ' + COLUMN_NAMES.sample.join(', ') + '. Columns in the file: ' + table[0].slice(0, 8).map(function (h) { return h.trim(); }).join(', ') + (header.length > 8 ? ', ...' : '') + '.' };
    }
    var ignored = table[0].map(function (h, i) { return as[i] === undefined ? h.trim() : null; }).filter(Boolean);
    var byName = {}, rows = [], derivedGroup = 0, derivedRep = 0, dropped = 0, notes = [];
    table.slice(1).forEach(function (r) {
      var get = function (f) { return col[f] === undefined ? '' : cell(r[col[f]] == null ? '' : r[col[f]]); };
      var sample = get('sample');
      if (!sample) return;
      var row = byName[sample];
      if (!row) {
        if (rows.length >= MAX_ROWS) { dropped++; return; }
        row = blankRow(); row.sample = sample; byName[sample] = row; rows.push(row);
      }                                                      // nf-core repeats a sample per lane or run: one row, cells merged
      ['group', 'replicate', 'antibody', 'control', 'strandedness'].forEach(function (f) { if (!row[f]) row[f] = get(f); });
    });
    if (!rows.length) return { ok: false, error: 'The sample column is empty.' };
    rows.forEach(function (r) {
      var d = derivedCells(pipe, r.sample);
      if (!r.group) { r.group = d.group; derivedGroup++; }
      if (!r.replicate && d.replicate) { r.replicate = d.replicate; derivedRep++; }
      if (r.strandedness && ['auto', 'forward', 'reverse', 'unstranded'].indexOf(r.strandedness) < 0) r.strandedness = '';
      ['antibody', 'control', 'strandedness'].forEach(function (f) { if (TABLES[pipe] && TABLES[pipe].extras.indexOf(f) < 0) r[f] = ''; });   // not a column of this assay's table
    });
    var kind = col.fastq_1 !== undefined ? 'nf-core samplesheet' : (as[col.sample] === 'sample' && header[col.sample] === 'label' ? 'experimental design (label column)'
      : (col.group !== undefined ? 'metadata table' : 'sample list'));
    notes.push(rows.length + ' sample(s) read from a ' + kind + '.');
    if (col.group === undefined) notes.push('No condition / group column: groups taken from the sample names (<group>_REP<n>, trailing _<n>); edit them in the table.');
    else if (derivedGroup) notes.push('Group taken from the name for ' + derivedGroup + ' sample(s) with an empty group cell.');
    if (derivedRep) notes.push('Replicate taken from the name for ' + derivedRep + ' sample(s).');
    if (col.fastq_1 !== undefined) notes.push('The fastq_1 / fastq_2 paths in the file are not used here: the table takes names, groups and replicates only.');
    if (dropped) notes.push('Only the first ' + MAX_ROWS + ' samples were kept (' + dropped + ' more in the file).');
    return { ok: true, kind: kind, rows: rows, recognised: recognised, ignored: ignored, notes: notes };
  }

  // ---- a listing in: pasted FASTQ names (map page) or pasted intensity column names (proteomics)
  function rowsFromFastqListing(assay, text, folder, singleEnd) {
    var parsed = parseFastqNames(text, folder), seen = {}, rows = [];
    pairFastqs(parsed.files, singleEnd).forEach(function (r) {
      if (seen[r.sample]) return;
      seen[r.sample] = true;
      var row = blankRow(), d = splitSample(r.sample), c = CONTROL_RE.exec(r.sample);
      row.sample = row.key = r.sample; row.group = d.group; row.replicate = d.replicate;
      if (assay === 'chipseq' && c) row.antibody = c[2].toLowerCase() === 'igg' ? 'IgG' : 'Input';
      rows.push(row);
    });
    return rows.slice(0, MAX_ROWS);
  }

  var ANNOTATION_COLUMN = /^(accession|description|symbol|gene[ _]?names?|protein[ _]?names?|majority protein ids|protein ids|fasta headers|peptides|razor.*|unique.*|sequence coverage.*|mol\. weight.*|q-value|score|only identified by site|reverse|potential contaminant|id|number of proteins|msms count|ms\/ms count|peptide counts.*|intensity|lfq intensity|ibaq)$/i;
  // the header line of a proteinGroups.txt (tab separated), a list of column names (one per line, or comma separated), or
  // names with the usual prefix on one line. Intensity-looking columns when there are any, else every non-annotation name.
  function parseColumnNames(text) {
    text = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    var parts;
    if (text.indexOf('\t') >= 0) parts = text.split(/[\t\n]+/);
    else if (text.indexOf('\n') >= 0) parts = text.split('\n');
    else if (text.indexOf(',') >= 0) parts = text.split(',');
    else parts = text.match(/(?:MaxLFQ intensity|LFQ intensity|Intensity|iBAQ)\s+\S+/gi) || text.split(/\s+/);   // one line: prefixed names, else words
    parts = parts.map(function (p) { return p.trim().replace(/^["']+|["']+$/g, ''); }).filter(Boolean);
    var seen = {}, names = [];
    parts.forEach(function (p) { if (!seen[p]) { seen[p] = true; names.push(p); } });
    var intens = names.filter(function (n) { return PG_PREFIX.test(n); });
    var labels = (intens.length ? intens : names.filter(function (n) { return !ANNOTATION_COLUMN.test(n); })).slice(0, MAX_ROWS);
    var notes = [];
    if (intens.length && intens.length < names.length) notes.push(names.length + ' columns pasted; ' + intens.length + ' look like intensity columns (LFQ intensity, Intensity, iBAQ, ...) and became labels.');
    var families = {};
    intens.forEach(function (n) { families[n.match(PG_PREFIX)[0].replace(/\s+$/, '').toLowerCase()] = true; });
    if (Object.keys(families).length > 1) notes.push('More than one intensity family was pasted (' + Object.keys(families).join(', ') + '). lab-proteomics reads every column whose name has an underscore: keep one family (for example LFQ intensity) in the protein table.');
    return { labels: labels, notes: notes };
  }
  function rowsFromColumnNames(text) {
    return parseColumnNames(text).labels.map(function (l) {
      var row = blankRow(), d = splitSample(labelStem(l));
      row.sample = row.key = l; row.group = d.group; row.replicate = d.replicate;
      return row;
    });
  }

  function listingRows(spec, st) {
    var sb = spec.samples, l = sb && sb.listing, text = l && st[l.field];
    if (!text) return null;
    if (l.kind === 'fastq') {
      if (st.input && st.input !== 'fastq') return null;
      var assay = sb.pipeline === '$assay' ? st.assay : sb.pipeline;
      return rowsFromFastqListing(assay, text, st.fastq_dir || '/path/to/fastqs', !!st.single_end);
    }
    if (l.kind === 'columns') return rowsFromColumnNames(text);
    return null;
  }

  // the table after a listing changed: rows with a listing name keep the user's edits, new names are added, names that left
  // the listing go; rows typed or read from a CSV (no key) stay, and adopt a listing name that equals theirs
  function mergeListing(existing, fresh) {
    var byKey = {}, used = {}, out = [];
    existing.forEach(function (e) { var k = e.key || e.sample; if (k && !byKey[k]) byKey[k] = e; });
    fresh.forEach(function (f) {
      var e = byKey[f.key];
      if (e && !used[f.key]) {
        used[f.key] = true;
        var m = Object.assign({}, e, { key: f.key });
        ['group', 'replicate', 'antibody'].forEach(function (c) { if (!m[c]) m[c] = f[c]; });
        if (!m.sample) m.sample = f.sample;
        out.push(m);
      } else out.push(f);
    });
    existing.forEach(function (e) {
      var k = e.key || e.sample;
      if (!e.key && !(k && used[k])) out.push(e);
    });
    return out.slice(0, MAX_ROWS);
  }

  // ---- table out: metadata.csv (experimental_design.csv for proteomics)
  function metadataLines(pipe, rows) {
    var t = TABLES[pipe], notes = [];
    if (!t) return { lines: [], notes: notes, samples: 0 };
    var seen = {}, out = [], dup = [], noGroup = [], noRep = [], noUnderscore = [];
    (rows || []).forEach(function (r) {
      if (!r.sample) return;
      if (seen[r.sample]) { dup.push(r.sample); return; }
      seen[r.sample] = true;
      if (!r.group) noGroup.push(r.sample);
      if (!r.replicate) noRep.push(r.sample);
      if (pipe === 'proteomics' && !/_[^_]+$/.test(r.sample)) noUnderscore.push(r.sample);
      var field = { sample: r.sample, label: r.sample, condition: r.group, replicate: r.replicate, antibody: r.antibody };
      out.push(t.meta.map(function (c) { return csvField(field[c] || ''); }).join(','));
    });
    function few(l) { return l.slice(0, 4).join(', ') + (l.length > 4 ? ' (+' + (l.length - 4) + ' more)' : ''); }
    if (dup.length) notes.push('Sample named twice, the first row is used: ' + few(dup));
    if (noGroup.length) notes.push('No group for ' + few(noGroup) + ': fill the group column of the table.');
    if (pipe === 'chipseq' && out.length && (rows || []).some(function (r) { return r.sample && !r.antibody; })) notes.push('ChIP / CUT&RUN / CUT&Tag: the antibody column of metadata.csv is empty for some samples; fill it in the table.');
    if (noUnderscore.length) notes.push('lab-proteomics only reads intensity columns whose name has an underscore; these have none: ' + few(noUnderscore));
    return { lines: out.length ? [t.meta.join(',')].concat(out) : [], notes: notes, samples: out.length, noRep: noRep };
  }

  // ---- comparisons
  function comparisonId(target, reference) { return (safeLabel(target) || 'group') + '_vs_' + (safeLabel(reference) || 'group'); }

  // [{id, target, reference, valid, auto}] ; ids made unique (_2, _3) among the valid ones; valid = both groups are in the table
  function resolveComparisons(comps, groups) {
    var used = {}, out = [];
    (comps || []).forEach(function (c) {
      var valid = groups.indexOf(c.target) >= 0 && groups.indexOf(c.reference) >= 0 && c.target !== c.reference;
      var id = c.id || comparisonId(c.target, c.reference), base = id, n = 2;
      if (valid) { while (used[id]) id = base + '_' + (n++); used[id] = true; }
      out.push({ id: id, target: c.target, reference: c.reference, valid: valid, auto: !c.id });
    });
    return out;
  }

  function addComparison(comps, target, reference, groups) {
    target = cell(target); reference = cell(reference);
    if (!target || !reference) return { comps: comps, error: 'Choose a target and a reference group.', added: 0 };
    if (target === reference) return { comps: comps, error: 'Target and reference are the same group.', added: 0 };
    if (groups.indexOf(target) < 0 || groups.indexOf(reference) < 0) return { comps: comps, error: 'That group is not in the table.', added: 0 };
    if (comps.some(function (c) { return c.target === target && c.reference === reference; })) return { comps: comps, error: target + ' vs ' + reference + ' is already in the list.', added: 0 };
    if (comps.length >= MAX_COMPS) return { comps: comps, error: 'Too many comparisons (limit ' + MAX_COMPS + ').', added: 0 };
    return { comps: comps.concat([{ target: target, reference: reference, id: '' }]), error: '', added: 1 };
  }
  // every other group against one reference (those already in the list are left as they are)
  function allVsReference(comps, reference, groups) {
    if (!reference || groups.indexOf(reference) < 0) return { comps: comps, error: 'Choose the reference group first.', added: 0 };
    var cur = comps, added = 0;
    groups.forEach(function (g) {
      if (g === reference) return;
      var r = addComparison(cur, g, reference, groups);
      if (r.added) { cur = r.comps; added++; }
    });
    return { comps: cur, error: added ? '' : 'Every group is already compared with ' + reference + '.', added: added };
  }
  function removeComparison(comps, i) { return comps.filter(function (c, j) { return j !== i; }); }
  // an edited id; empty (or the automatic one) goes back to automatic
  function setComparisonId(comps, i, id) {
    return comps.map(function (c, j) {
      if (j !== i) return c;
      id = cleanId(id);
      return { target: c.target, reference: c.reference, id: id === comparisonId(c.target, c.reference) ? '' : id };
    });
  }
  function defaultReference(groups) {
    var m = groups.filter(function (g) { return /^(control|ctrl|ctl|wt|wild[_-]?type|untreated|vehicle|dmso|mock|none|baseline|naive|igg|input)$/i.test(g); })[0];
    return m || groups[0] || '';
  }

  // drag and drop and the two selects share these: the Target / Reference slots
  function fillSlot(slots, which, group, groups) {
    var s = { target: slots.target || '', reference: slots.reference || '' };
    if (which !== 'target' && which !== 'reference') return { slots: s, error: 'Unknown slot.' };
    if (group && groups.indexOf(group) < 0) return { slots: s, error: 'That group is not in the table.' };
    s[which] = group || '';
    return { slots: s, error: '' };
  }
  function nextSlot(slots) { return slots.target ? (slots.reference ? '' : 'reference') : 'target'; }
  // fill a slot (a drop, a tap on a chip or a select) and, when both are set, add the comparison and empty the slots
  function dropOnSlot(comps, slots, which, group, groups) {
    var f = fillSlot(slots, which, group, groups);
    if (f.error) return { comps: comps, slots: f.slots, error: f.error, added: 0 };
    if (!(f.slots.target && f.slots.reference)) return { comps: comps, slots: f.slots, error: '', added: 0 };
    return submitSlots(comps, f.slots, groups);
  }
  function submitSlots(comps, slots, groups) {
    var r = addComparison(comps, slots.target, slots.reference, groups);
    return { comps: r.comps, slots: r.added ? { target: '', reference: '' } : { target: slots.target, reference: slots.reference }, error: r.error, added: r.added };
  }

  function contrastLines(items) {
    var valid = items.filter(function (c) { return c.valid; });
    if (!valid.length) return [];
    return [CONTRAST_HEADER.join(',')].concat(valid.map(function (c) { return [c.id, 'condition', c.reference, c.target].map(csvField).join(','); }));
  }

  // ---- state in the page address (compact) and as a small JSON file
  function esc(v) { return String(v).replace(/%/g, '%25').replace(/~/g, '%7E').replace(/!/g, '%21'); }
  function unesc(v) { return v.replace(/%7E/gi, '~').replace(/%21/g, '!').replace(/%25/g, '%'); }
  function encodeRows(rows) {
    return (rows || []).filter(function (r) { return ROW_KEYS.some(function (k) { return r[k]; }); }).map(function (r) {
      var cells = ROW_KEYS.map(function (k) { return k === 'key' && r.key === r.sample ? '' : esc(r[k]); });
      while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
      return cells.join('~');
    }).join('!');
  }
  function decodeRows(s) {
    if (!s) return [];
    return String(s).split('!').slice(0, MAX_ROWS).map(function (line) {
      var parts = line.split('~'), r = blankRow();
      ROW_KEYS.forEach(function (k, i) { r[k] = unesc(parts[i] || ''); });
      return r;
    });
  }
  function encodeComps(comps) { return (comps || []).map(function (c) { return [c.target, c.reference, c.id].map(esc).join('~').replace(/~+$/, ''); }).join('!'); }
  function decodeComps(s) {
    if (!s) return [];
    return String(s).split('!').slice(0, MAX_COMPS).map(function (line) {
      var p = line.split('~');
      return { target: unesc(p[0] || ''), reference: unesc(p[1] || ''), id: unesc(p[2] || '') };
    });
  }
  var STATE_FORMAT = 'lab-builder-samples/1';
  function samplesToJson(rows, comps) {
    return JSON.stringify({ format: STATE_FORMAT, samples: cleanRows(rows).map(function (r) { var o = {}; ROW_KEYS.forEach(function (k) { if (r[k] && !(k === 'key' && r.key === r.sample)) o[k] = r[k]; }); return o; }), comparisons: cleanComps(comps) }, null, 1) + '\n';
  }
  function samplesFromJson(text) {
    if (String(text || '').length > CSV_MAX_BYTES) return { ok: false, error: 'The file is too large for a saved state.' };
    var d;
    try { d = JSON.parse(text); } catch (e) { return { ok: false, error: 'Not a saved state: this is not JSON.' }; }
    if (!d || d.format !== STATE_FORMAT || !Array.isArray(d.samples)) return { ok: false, error: 'Not a saved state of this builder (format ' + STATE_FORMAT + ' expected).' };
    var rows = cleanRows(d.samples);
    return { ok: true, rows: rows, comps: cleanComps(d.comparisons) };
  }

  function derive(spec, st) {
    var d = {};
    var modules = (spec.moduleOrder || []).filter(function (m) { return st[m]; });
    d.modules_list = modules.join(',');
    d.isoforms_on = !!(st.isoforms && st.input !== 'matrix' && modules.length);
    var fieldIds = allFields(spec).map(function (f) { return f.id; });
    [['go', 'go_list'], ['collections', 'collections_list'], ['fgsea', 'fgsea_list'], ['formats', 'formats_list']].forEach(function (p) {
      if (fieldIds.indexOf(p[0]) < 0 || !spec.defaults) return;                  // the map page has none of these
      var chosen = listText(spec, p[0], st);
      d[p[1]] = chosen.join(',');
      d[p[0] + '_changed'] = chosen.length > 0 && chosen.join(',') !== spec.defaults[p[0]].join(',');
    });
    var base = String(st.genome || '').split('_')[0];
    d.preset = PRESET_OF[base] && PRESET_OF[base] === st.organism ? base : '';
    allFields(spec).forEach(function (f) {
      if (f.list) {                                       // comma-separated text: <id>_items (array), <id>_list (joined)
        var items = String(st[f.id] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        d[f.id + '_items'] = items; d[f.id + '_list'] = items.join(',');
      }
      if (f.numeric) {                                    // a valid number in range: <id>_num; <id>_changed when not the default
        var t = String(st[f.id] || '').trim(), n = Number(t);
        var ok = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) && (f.min == null || n >= f.min) && (f.max == null || n <= f.max);
        d[f.id + '_num'] = ok ? t : '';
        d[f.id + '_changed'] = ok && n !== Number(f.default);
      }
    });
    var overrides = {};
    (st.samples || []).forEach(function (r) { var k = r.key || r.sample; if (k && !overrides[k]) overrides[k] = r; });
    if ((spec.derived || []).indexOf('samplesheet') >= 0) {      // map page: the samplesheet written from the pasted names
      var sheet = fastqSheet(st.assay, st.fastq_list, st.fastq_dir || '/path/to/fastqs', !!st.single_end, st.proseq_strand, overrides);
      d.sheet_lines = sheet.lines; d.sheet_notes = sheet.notes; d.sheet_has = sheet.lines.length > 0;
    }
    if ((spec.derived || []).indexOf('accessions') >= 0) {       // map page: accessions.csv, one ID per line
      var acc = parseAccessions(st.accessions);
      d.acc_lines = acc.ids; d.acc_notes = acc.notes; d.acc_has = acc.ids.length > 0;
    }
    if (spec.samples) {                                          // the samples & comparisons block: its CSVs, notes and counts
      var pipe = spec.samples.pipeline === '$assay' ? st.assay : spec.samples.pipeline;
      var meta = metadataLines(pipe, st.samples), groups = groupsOf(st.samples);
      var resolved = resolveComparisons(st.comparisons, groups), good = resolved.filter(function (c) { return c.valid; });
      d.meta_lines = meta.lines; d.meta_has = meta.lines.length > 0; d.meta_notes = meta.notes;
      d.con_lines = contrastLines(resolved); d.con_has = good.length > 0;
      d.con_notes = resolved.filter(function (c) { return !c.valid; }).slice(0, 4).map(function (c) {
        return 'Left out of contrasts.csv (a group is not in the table): ' + c.target + ' vs ' + c.reference; });
      d.samples_n = meta.samples; d.comps_n = good.length; d.any_table = d.meta_has || d.con_has;
      d.samples_visible = (spec.samples.showWhen || [[]]).some(function (alt) { return holds(alt, Object.assign({}, st, d)); });
    }
    // spec "flags": named conditions, so a step can say "not (dry run and FASTQ input)"
    var vals = Object.assign({}, st, d);
    Object.keys(spec.flags || {}).forEach(function (k) { d[k] = holds(spec.flags[k], vals); });
    return d;
  }

  // ------------------------------------------------------------------ conditions: ["a", "!b", "k=v", "k!=v", "k=v1|v2"], all must hold
  function clauseHolds(clause, vals) {
    var m;
    if ((m = /^([\w]+)!=(.*)$/.exec(clause))) return m[2].split('|').indexOf(String(vals[m[1]])) < 0;
    if ((m = /^([\w]+)=(.*)$/.exec(clause))) return m[2].split('|').indexOf(String(vals[m[1]])) >= 0;
    if (clause.charAt(0) === '!') return !vals[clause.slice(1)];
    return !!vals[clause];
  }
  function holds(when, vals) { return (when || []).every(function (c) { return clauseHolds(c, vals); }); }

  // ------------------------------------------------------------------ command assembly
  function makeResolver(spec, st) {
    var vals = Object.assign({}, st, derive(spec, st));
    var fieldType = {}, trim = {};
    allFields(spec).forEach(function (f) { fieldType[f.id] = f.type; trim[f.id] = !!f.trimSlash; });
    function word(v) { return /^[A-Za-z0-9_.,=+-]+$/.test(v) ? v : (v ? shellQuote(v) : ''); }
    return {
      vals: vals,
      word: word,
      // the word for a value key: user-typed text is single-quoted, an empty field falls back to a placeholder
      value: function (key) {
        var v = vals[key];
        if (typeof v === 'boolean' || v == null) v = v ? 'true' : '';
        v = oneLine(v);
        if (fieldType[key] === 'text') {
          if (v && trim[key] && v.replace(/\/+$/, '')) v = v.replace(/\/+$/, '');   // a folder: no trailing slash
          if (v) return shellQuote(v);
          var ph = spec.placeholders && spec.placeholders[key];
          return ph || '';
        }
        return word(v);
      }
    };
  }

  function lineText(spec, line, r) {
    var out = [];
    var words = line.words;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (typeof w === 'string') { out.push(w); continue; }
      if (!holds(w.when, r.vals)) continue;
      if (w.each !== undefined) {                         // the flag repeated for every item of a list
        (r.vals[w.each] || []).forEach(function (item) { out.push(w.flag, r.word(oneLine(item))); });
        continue;
      }
      var v = undefined;
      if (w.value !== undefined) {
        v = r.value(w.value);
        if (!v) continue;
        if (w.suffix) v += w.suffix;                      // <folder>/inputs/x: the quoted folder, then the literal rest
        if (w.prefix) v = w.prefix + v;                   // lab-<assay>
      }
      else if (w.text !== undefined) v = w.text;
      if (w.flag) { out.push(w.flag); if (v !== undefined) out.push(v); }
      else if (v !== undefined) out.push(v);
    }
    return out.join(' ');
  }

  // cat > <target> <<'EOF' ... EOF : the quoted delimiter keeps the body literal; the delimiter is made unique among its lines
  // h.words (a command, e.g. python3 - ...) instead of `cat > target`; h.bodyText is a fixed body, h.body the name of a derived list
  function heredocText(spec, h, r) {
    var body = h.bodyText || r.vals[h.body] || [], delim = h.delimiter || 'EOF';
    while (body.indexOf(delim) >= 0) delim += '_X';
    var head = h.words ? lineText(spec, { words: h.words }, r) : 'cat > ' + lineText(spec, { words: h.target }, r);
    return [head + " <<'" + delim + "'"].concat(body, [delim]).join('\n');
  }

  // [{title, lines:[{kind:'cmd'|'comment', text}]}], the page's and the .sh's content
  function assemble(spec, rawState) {
    var st = normalize(spec, rawState);
    var r = makeResolver(spec, st);
    var blocks = [];
    var pre = [];
    if (st.install) {
      pre.push({ title: 'one-time install', lines: spec.installLines.map(function (l) { return { kind: 'cmd', text: lineText(spec, l, r) }; }) });
    }
    pre.push({ title: 'every session', lines: [{ kind: 'cmd', text: lineText(spec, spec.session[1], r) }] });
    blocks = blocks.concat(pre);
    spec.steps.forEach(function (step) {
      if (!holds(step.when, r.vals)) return;
      step.blocks.forEach(function (b) {
        if (!holds(b.when, r.vals)) return;
        var lines = [];
        b.lines.forEach(function (l) {
          if (!holds(l.when, r.vals)) return;
          if (l.comment !== undefined) lines.push({ kind: 'comment', text: l.comment });
          else if (l.notes !== undefined) (r.vals[l.notes] || []).forEach(function (t) { lines.push({ kind: 'comment', text: t }); });
          else if (l.heredoc) lines.push({ kind: 'cmd', text: heredocText(spec, l.heredoc, r) });
          else lines.push({ kind: 'cmd', text: lineText(spec, l, r) });
        });
        if (b.skipIfEmpty && !lines.some(function (l) { return l.kind === 'cmd'; })) return;
        blocks.push({ title: b.title, lines: lines });
      });
    });
    return { state: st, blocks: blocks };
  }

  function render(blocks) {
    return blocks.map(function (b, i) {
      return ['# step ' + (i + 1) + ': ' + b.title].concat(b.lines.map(function (l) {
        return l.kind === 'comment' ? '# ' + l.text : l.text;
      })).join('\n');
    }).join('\n\n') + '\n';
  }

  function toScript(spec, text) {
    var name = (spec.script && spec.script.name) || 'Shechter Lab RNA-seq command builder';
    return '#!/usr/bin/env bash\n' +
      '# Written by the ' + name + '.\n' +
      '# There is no `set -euo pipefail` on purpose: some steps wait on Slurm jobs (' + ((spec.script && spec.script.waits) || 'map --status --watch,\n# status --watch') + ')\n' +
      '# and a non-zero exit while a job is still running must not stop the script.\n' +
      '# Run it step by step, reading each step\'s output, rather than unattended.\n\n' + text;
  }

  // ------------------------------------------------------------------ URL hash: only what differs from the defaults
  function toHash(spec, rawState, skipSamples) {
    var st = normalize(spec, rawState), def = defaultState(spec), p = [];
    function enc(x) { return encodeURIComponent(x).replace(/'/g, '%27'); }
    function add(k, v) { p.push(enc(k) + '=' + enc(v)); }
    if (st.input !== def.input) add('input', st.input);
    allFields(spec).forEach(function (f) {
      if (f.disabled) return;
      var a = st[f.id], b = def[f.id];
      if (f.type === 'checkgroup') { if (a.join(',') !== b.join(',')) add(f.id, a.join(',') || '-'); }
      else {
        if (f.compact === 'columns' && a) a = parseColumnNames(a).labels.join('\n');   // a proteinGroups header is kilobytes: keep the labels
        if (a !== b) add(f.id, f.type === 'checkbox' ? (a ? '1' : '0') : a);
      }
    });
    if (spec.samples && !skipSamples && !samplesTooBig(spec, st, p)) {     // the table (s) and the comparisons (c), compactly
      var rs = encodeRows(editedRows(spec, st)), cs = encodeComps(st.comparisons);
      if (rs) add('s', rs);
      if (cs) add('c', cs);
    }
    return p.join('&');
  }

  // true when the table and comparisons would make the address too long (HASH_LIMIT characters): they are then left out of it
  // the rows the address must carry: not the listing's own, unedited ones (the pasted list brings those back)
  function editedRows(spec, st) {
    var fresh = listingRows(spec, st), by = {};
    (fresh || []).forEach(function (f) { by[f.key] = f; });
    return st.samples.filter(function (r) {
      var f = r.key && by[r.key];
      return !(f && ROW_KEYS.every(function (k) { return r[k] === f[k]; }));
    });
  }
  function samplesTooBig(spec, st, parts) {
    var n = encodeURIComponent(encodeRows(editedRows(spec, st))).length + encodeURIComponent(encodeComps(st.comparisons)).length;
    return n + (parts ? parts.join('&').length : 0) > HASH_LIMIT;
  }
  function hashTooBig(spec, rawState) {
    if (!spec.samples) return false;
    var st = normalize(spec, rawState), h = toHash(spec, st, true);
    return samplesTooBig(spec, st, h ? [h] : []);
  }

  function fromHash(spec, hash) {
    var raw = {};
    String(hash || '').replace(/^#/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      if (i < 0) return;
      try { raw[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' ')); } catch (e) { /* ignore a malformed pair */ }
    });
    allFields(spec).forEach(function (f) { if (f.type === 'checkgroup' && raw[f.id] === '-') raw[f.id] = []; });
    if (spec.samples) { raw.samples = decodeRows(raw.s); raw.comparisons = decodeComps(raw.c); }
    return normalize(spec, raw);
  }

  // ------------------------------------------------------------------ shell words, for tests: [{v, quoted}]
  function shellWords(line) {
    var words = [], cur = '', quoted = false, has = false, i = 0, c;
    while (i < line.length) {
      c = line[i];
      if (c === "'") {
        has = quoted = true; i++;
        while (i < line.length && line[i] !== "'") cur += line[i++];
        i++;
      } else if (c === '"') {                              // "$PWD/x": one quoted word (the page writes these for fixed text only)
        has = quoted = true; i++;
        while (i < line.length && line[i] !== '"') { if (line[i] === '\\' && i + 1 < line.length) i++; cur += line[i++]; }
        i++;
      } else if (c === '\\' && i + 1 < line.length) { has = true; cur += line[i + 1]; i += 2; }
      else if (c === ' ' || c === '\t') { if (has) { words.push({ v: cur, quoted: quoted }); cur = ''; quoted = has = false; } i++; }
      else { has = true; cur += c; i++; }
    }
    if (has) words.push({ v: cur, quoted: quoted });
    return words;
  }

  var api = {
    shellQuote: shellQuote, shellWords: shellWords, oneLine: oneLine, allFields: allFields, defaultState: defaultState,
    normalize: normalize, derive: derive, holds: holds, assemble: assemble, render: render, toScript: toScript,
    toHash: toHash, fromHash: fromHash, multiLine: multiLine, parseFastqNames: parseFastqNames, pairFastqs: pairFastqs,
    fastqSheet: fastqSheet, parseAccessions: parseAccessions, sampleName: sampleName, replicateOf: replicateOf,
    // the samples & comparisons block
    TABLES: TABLES, CONTRAST_HEADER: CONTRAST_HEADER, CSV_MAX_BYTES: CSV_MAX_BYTES, HASH_LIMIT: HASH_LIMIT,
    splitSample: splitSample, labelStem: labelStem, parseCsv: parseCsv, checkCsvFile: checkCsvFile, samplesFromCsv: samplesFromCsv,
    rowsFromFastqListing: rowsFromFastqListing, parseColumnNames: parseColumnNames, rowsFromColumnNames: rowsFromColumnNames,
    mergeListing: mergeListing, groupsOf: groupsOf, metadataLines: metadataLines, contrastLines: contrastLines,
    comparisonId: comparisonId, resolveComparisons: resolveComparisons, addComparison: addComparison, allVsReference: allVsReference,
    removeComparison: removeComparison, setComparisonId: setComparisonId, defaultReference: defaultReference, fillSlot: fillSlot,
    nextSlot: nextSlot, dropOnSlot: dropOnSlot, submitSlots: submitSlots, encodeRows: encodeRows, decodeRows: decodeRows,
    encodeComps: encodeComps, decodeComps: decodeComps, samplesToJson: samplesToJson, samplesFromJson: samplesFromJson,
    hashTooBig: hashTooBig, blankRow: blankRow, csvField: csvField
  };

  // ================================================================== the page
  if (typeof document === 'undefined') return api;

  var $ = function (s, el) { return (el || document).querySelector(s); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) { n.appendChild(k); });
    return n;
  }

  // ------------------------------------------------------------------ the samples & comparisons card
  // ctx: {state(): the page's state, mutate(fn): fn edits state.samples / state.comparisons, then the page updates}
  function buildSamples(spec, ctx) {
    var sb = spec.samples, uid = 'sb' + Math.random().toString(36).slice(2, 7);
    var root = el('div', { class: 'samples-block', id: 'samples-block' });
    var slots = { target: '', reference: '' }, lastRows = null, lastChips = null, lastComps = null;
    var pipeOf = function () { var st = ctx.state(); return sb.pipeline === '$assay' ? st.assay : sb.pipeline; };
    var inside = function (box) { return box.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName); };

    var intro = el('p', { class: 'hint' });
    var privacy = el('p', { class: 'privacy small', text: 'Files are read in your browser (FileReader) and are never uploaded: nothing leaves this page.' });
    var listingNote = el('p', { class: 'hint' });
    var fileInput = el('input', { type: 'file', accept: '.csv,.tsv,text/csv', id: uid + '-file', class: 'visually-hidden', 'aria-label': 'Choose a CSV file' });
    var zone = el('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-describedby': uid + '-zone-hint' }, [
      el('b', { text: 'Drop a CSV here' }), el('span', { text: ' or click to choose one' }),
      el('small', { class: 'hint', id: uid + '-zone-hint', text: 'An nf-core samplesheet.csv, a metadata.csv or a proteomics experimental_design.csv (up to 1 MB).' })]);
    var csvMsg = el('div', { class: 'csv-msg small', role: 'status', 'aria-live': 'polite' });

    var table = el('table', { class: 'samples' });
    var thead = el('thead'), tbody = el('tbody');
    table.appendChild(el('caption', { class: 'visually-hidden', text: 'Samples: one row per sample' }));
    table.appendChild(thead); table.appendChild(tbody);
    var groupList = el('datalist', { id: uid + '-groups' });
    var tableMsg = el('p', { class: 'hint small' });
    var notesBox = el('ul', { class: 'notes small' });
    var tooBig = el('p', { class: 'hint reason small', hidden: '' });

    var addBtn = el('button', { type: 'button', class: 'btn small-btn', text: 'Add row' });
    var clearBtn = el('button', { type: 'button', class: 'btn small-btn', text: 'Clear table' });
    var saveBtn = el('button', { type: 'button', class: 'btn small-btn', text: 'Save state (JSON)' });
    var loadBtn = el('button', { type: 'button', class: 'btn small-btn', text: 'Load state' });
    var loadInput = el('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', 'aria-label': 'Choose a saved state (JSON)' });

    var chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Groups in the table' });
    var slotT = el('div', { class: 'slot', 'data-slot': 'target', 'aria-label': 'Target slot' });
    var slotR = el('div', { class: 'slot', 'data-slot': 'reference', 'aria-label': 'Reference slot' });
    var selT = el('select', { id: uid + '-t' }), selR = el('select', { id: uid + '-r' });
    var addComp = el('button', { type: 'button', class: 'btn primary small-btn', text: 'Add comparison' });
    var allBtn = el('button', { type: 'button', class: 'btn small-btn', text: 'All vs one reference' });
    var compMsg = el('p', { class: 'hint small', role: 'status', 'aria-live': 'polite' });
    var compList = el('ul', { class: 'comps' });

    root.appendChild(intro); root.appendChild(privacy); root.appendChild(listingNote);
    root.appendChild(zone); root.appendChild(fileInput); root.appendChild(csvMsg);
    root.appendChild(el('h3', { text: 'Samples' }));
    root.appendChild(el('div', { class: 'table-wrap' }, [table])); root.appendChild(groupList);
    root.appendChild(el('div', { class: 'row-actions' }, [addBtn, clearBtn, saveBtn, loadBtn, loadInput]));
    root.appendChild(tableMsg); root.appendChild(notesBox); root.appendChild(tooBig);
    root.appendChild(el('h3', { text: 'Comparisons' }));
    root.appendChild(el('p', { class: 'hint', id: uid + '-cmp-hint', text: 'Drag two groups onto Target and Reference (or tap a group, then another) to add a comparison. The selects below do the same on a touch screen or with the keyboard.' }));
    root.appendChild(chips);
    root.appendChild(el('div', { class: 'slots' }, [
      el('div', { class: 'slot-box' }, [el('span', { class: 'slot-label', text: 'Target' }), slotT]),
      el('span', { class: 'vs', text: 'vs', 'aria-hidden': 'true' }),
      el('div', { class: 'slot-box' }, [el('span', { class: 'slot-label', text: 'Reference' }), slotR])]));
    root.appendChild(el('div', { class: 'pick' }, [
      el('div', { class: 'field' }, [el('label', { for: uid + '-t', text: 'Target' }), selT]),
      el('div', { class: 'field' }, [el('label', { for: uid + '-r', text: 'Reference' }), selR]),
      el('div', { class: 'pick-btns' }, [addComp, allBtn])]));
    root.appendChild(compMsg); root.appendChild(compList);

    function msg(text, bad) { csvMsg.textContent = ''; csvMsg.className = 'csv-msg small' + (bad ? ' bad' : ''); if (text) csvMsg.appendChild(document.createTextNode(text)); }

    // ---- a CSV in
    function showRecognised(r) {
      csvMsg.className = 'csv-msg small';
      csvMsg.textContent = '';
      csvMsg.appendChild(el('div', { text: r.notes[0] }));
      var rec = el('div', { class: 'recognised' }, [el('span', { text: 'Recognised columns: ' })]);
      r.recognised.forEach(function (x) { rec.appendChild(el('span', { class: 'tag', text: x.column + ' → ' + x.as })); });
      csvMsg.appendChild(rec);
      if (r.ignored.length) csvMsg.appendChild(el('div', { class: 'hint', text: 'Not used: ' + r.ignored.slice(0, 8).join(', ') + (r.ignored.length > 8 ? ', ...' : '') }));
      r.notes.slice(1).forEach(function (n) { csvMsg.appendChild(el('div', { class: 'hint', text: n })); });
    }
    function readFile(file, limit, done) {
      var rd = new FileReader();
      rd.onerror = function () { msg('The file could not be read.', true); };
      rd.onload = function () { done(String(rd.result)); };
      rd.readAsText(file.slice(0, limit + 1));
    }
    function loadCsv(file) {
      if (!file) return;
      var bad = checkCsvFile(file.name, file.size);
      if (bad) { msg(bad, true); return; }
      readFile(file, CSV_MAX_BYTES, function (text) {
        var r = samplesFromCsv(text, pipeOf());
        if (!r.ok) { msg(r.error, true); return; }
        ctx.mutate(function (st) { st.samples = r.rows; });
        showRecognised(r);
      });
    }
    zone.addEventListener('click', function () { fileInput.click(); });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    fileInput.addEventListener('change', function () { loadCsv(fileInput.files[0]); fileInput.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); zone.classList.remove('over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) loadCsv(files[0]); else msg('Drop a file, not text: paste text into the lists above.', true);
    });

    // ---- the table
    function columns() {
      var p = pipeOf(), t = TABLES[p] || TABLES.rnaseq, cols = [{ f: 'sample', label: p === 'proteomics' ? 'Label (intensity column)' : 'Sample' },
        { f: 'group', label: 'Group' }, { f: 'replicate', label: 'Replicate' }];
      t.extras.forEach(function (x) { cols.push({ f: x, label: x.charAt(0).toUpperCase() + x.slice(1) }); });
      return cols;
    }
    function renderTable(rows) {
      var cols = columns(), dl = groupList;
      thead.textContent = ''; tbody.textContent = '';
      var hr = el('tr');
      cols.forEach(function (c) { hr.appendChild(el('th', { scope: 'col', text: c.label })); });
      hr.appendChild(el('th', { scope: 'col' }, [el('span', { class: 'visually-hidden', text: 'Remove' })]));
      thead.appendChild(hr);
      rows.forEach(function (row, i) {
        var tr = el('tr'), ins = {};
        cols.forEach(function (c) {
          var inp = el('input', { type: 'text', value: row[c.f] || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': c.label + ', row ' + (i + 1) });
          if (c.f === 'group') inp.setAttribute('list', dl.id);
          if (c.f === 'strandedness') inp.setAttribute('placeholder', 'auto');
          ins[c.f] = inp;
          inp.addEventListener('input', function () { ctx.mutate(function (st) { st.samples[i][c.f] = cell(inp.value); }); });
          if (c.f === 'sample') inp.addEventListener('change', function () {      // a new name fills an empty group / replicate
            ctx.mutate(function (st) {
              var r = st.samples[i], d = derivedCells(pipeOf(), r.sample);
              if (!r.group) { r.group = d.group; ins.group.value = d.group; }
              if (!r.replicate && d.replicate) { r.replicate = d.replicate; ins.replicate.value = d.replicate; }
            });
          });
          tr.appendChild(el('td', {}, [inp]));
        });
        var rm = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove row ' + (i + 1) + (row.sample ? ' (' + row.sample + ')' : ''), text: '×' });
        if (row.key) { rm.disabled = true; rm.title = 'This sample comes from the pasted list: remove it from the list'; }
        rm.addEventListener('click', function () { ctx.mutate(function (st) { st.samples.splice(i, 1); }); });
        tr.appendChild(el('td', {}, [rm]));
        tbody.appendChild(tr);
      });
      if (!rows.length) {
        var tr0 = el('tr'), td0 = el('td', { colspan: String(cols.length + 1), class: 'empty', text: 'No samples yet: paste a list, drop a CSV, or add rows.' });
        tr0.appendChild(td0); tbody.appendChild(tr0);
      }
    }
    addBtn.addEventListener('click', function () { ctx.mutate(function (st) { st.samples.push(blankRow()); }); var last = tbody.querySelector('tr:last-child input'); if (last) last.focus(); });
    clearBtn.addEventListener('click', function () { ctx.mutate(function (st) { st.samples = []; st.comparisons = []; }); slots = { target: '', reference: '' }; msg(''); });
    saveBtn.addEventListener('click', function () {
      var st = ctx.state(), blob = new Blob([samplesToJson(st.samples, st.comparisons)], { type: 'application/json' });
      var a = el('a', { download: 'samples-and-comparisons.json', href: URL.createObjectURL(blob) });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    loadBtn.addEventListener('click', function () { loadInput.click(); });
    loadInput.addEventListener('change', function () {
      var f = loadInput.files[0]; loadInput.value = '';
      if (!f) return;
      if (!/\.json$/i.test(f.name)) { msg('"' + f.name.slice(0, 60) + '" is not a saved state (.json).', true); return; }
      if (f.size > CSV_MAX_BYTES) { msg('The file is too large for a saved state.', true); return; }
      readFile(f, CSV_MAX_BYTES, function (text) {
        var r = samplesFromJson(text);
        if (!r.ok) { msg(r.error, true); return; }
        ctx.mutate(function (st) { st.samples = r.rows; st.comparisons = r.comps; });
        msg('Loaded ' + r.rows.length + ' sample(s) and ' + r.comps.length + ' comparison(s).');
      });
    });

    // ---- comparisons: chips, slots, selects, list
    function say(t, bad) { compMsg.textContent = t || ''; compMsg.className = 'hint small' + (bad ? ' reason' : ''); }
    function apply(r) {
      slots = r.slots;
      if (r.added) ctx.mutate(function (st) { st.comparisons = r.comps; });
      else syncPick(ctx.state());
      say(r.added ? (r.added + ' comparison' + (r.added > 1 ? 's' : '') + ' added.') : r.error, !!r.error);
    }
    function groupsNow() { return groupsOf(ctx.state().samples); }
    function onDrop(which, e) {
      e.preventDefault();
      var g = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
      var st = ctx.state();
      apply(dropOnSlot(st.comparisons, slots, which, g, groupsOf(st.samples)));
    }
    [slotT, slotR].forEach(function (slot) {
      var which = slot.getAttribute('data-slot');
      ['dragenter', 'dragover'].forEach(function (t) { slot.addEventListener(t, function (e) { e.preventDefault(); slot.classList.add('over'); }); });
      slot.addEventListener('dragleave', function () { slot.classList.remove('over'); });
      slot.addEventListener('drop', function (e) { slot.classList.remove('over'); onDrop(which, e); });
    });
    selT.addEventListener('change', function () { var r = fillSlot(slots, 'target', selT.value, groupsNow()); slots = r.slots; syncPick(ctx.state()); say(r.error, !!r.error); });
    selR.addEventListener('change', function () { var r = fillSlot(slots, 'reference', selR.value, groupsNow()); slots = r.slots; syncPick(ctx.state()); say(r.error, !!r.error); });
    addComp.addEventListener('click', function () { var st = ctx.state(); apply(submitSlots(st.comparisons, slots, groupsOf(st.samples))); });
    allBtn.addEventListener('click', function () {
      var st = ctx.state(), g = groupsOf(st.samples), ref = slots.reference || defaultReference(g);
      var r = allVsReference(st.comparisons, ref, g);
      slots = { target: '', reference: slots.reference };
      apply({ comps: r.comps, slots: slots, error: r.error, added: r.added });
    });

    function renderChips(groups) {
      chips.textContent = '';
      groupList.textContent = '';
      groups.forEach(function (g) { groupList.appendChild(el('option', { value: g })); });
      if (!groups.length) { chips.appendChild(el('span', { class: 'hint', text: 'Groups appear here once the table has them.' })); return; }
      groups.forEach(function (g) {
        var b = el('button', { type: 'button', class: 'chip', draggable: 'true', title: 'Drag onto Target or Reference, or tap', text: g });
        b.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', g); e.dataTransfer.effectAllowed = 'copy'; b.classList.add('dragging'); });
        b.addEventListener('dragend', function () { b.classList.remove('dragging'); });
        b.addEventListener('click', function () {
          var st = ctx.state(), which = nextSlot(slots) || 'target';
          if (!nextSlot(slots)) slots = { target: '', reference: '' };
          apply(dropOnSlot(st.comparisons, slots, which, g, groupsOf(st.samples)));
        });
        chips.appendChild(b);
      });
    }
    function syncPick(st) {
      var groups = groupsOf(st.samples);
      ['target', 'reference'].forEach(function (w) { if (slots[w] && groups.indexOf(slots[w]) < 0) slots[w] = ''; });
      [[selT, 'target'], [selR, 'reference']].forEach(function (p) {
        p[0].textContent = '';
        p[0].appendChild(el('option', { value: '', text: p[1] === 'target' ? 'Choose the target group' : 'Choose the reference group' }));
        groups.forEach(function (g) { p[0].appendChild(el('option', { value: g, text: g })); });
        p[0].value = slots[p[1]];
      });
      [[slotT, 'target'], [slotR, 'reference']].forEach(function (p) {
        p[0].textContent = '';
        if (slots[p[1]]) {
          var clr = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Clear the ' + p[1] + ' slot', text: '×' });
          clr.addEventListener('click', function () { slots[p[1]] = ''; syncPick(ctx.state()); });
          p[0].appendChild(el('span', { class: 'chip fixed', text: slots[p[1]] })); p[0].appendChild(clr);
        } else p[0].appendChild(el('span', { class: 'hint', text: 'drop a group here' }));
      });
      allBtn.textContent = groups.length ? 'All vs ' + (slots.reference || defaultReference(groups)) : 'All vs one reference';
      addComp.disabled = !(slots.target && slots.reference); allBtn.disabled = groups.length < 2;
    }
    function renderComps(st) {
      var res = resolveComparisons(st.comparisons, groupsOf(st.samples));
      compList.textContent = '';
      if (!res.length) { compList.appendChild(el('li', { class: 'hint', text: 'No comparisons yet.' })); return; }
      res.forEach(function (c, i) {
        var idIn = el('input', { type: 'text', value: c.id, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'ID of comparison ' + c.target + ' vs ' + c.reference });
        idIn.addEventListener('input', function () { ctx.mutate(function (s) { s.comparisons = setComparisonId(s.comparisons, i, idIn.value); }); });
        idIn.addEventListener('change', function () { ctx.mutate(function (s) { s.comparisons = setComparisonId(s.comparisons, i, idIn.value); }); renderComps(ctx.state()); });
        var rm = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove comparison ' + c.target + ' vs ' + c.reference, text: '×' });
        rm.addEventListener('click', function () { ctx.mutate(function (s) { s.comparisons = removeComparison(s.comparisons, i); }); });
        compList.appendChild(el('li', { class: c.valid ? '' : 'invalid' }, [idIn,
          el('span', { class: 'what', text: c.target + ' vs ' + c.reference + (c.valid ? '' : ' (a group is not in the table: left out)') }), rm]));
      });
    }

    function sync(st, vals) {
      root.hidden = !vals.samples_visible;
      var by = sb.introBy && sb.introBy[sb.pipeline === '$assay' ? st.assay : st.input];
      intro.textContent = by || sb.intro || '';
      listingNote.textContent = sb.listing ? sb.listing.note || '' : '';
      listingNote.hidden = !listingNote.textContent;
      var rowsSig = JSON.stringify([pipeOf(), st.samples]);
      if (rowsSig !== lastRows && !inside(tbody)) { lastRows = rowsSig; renderTable(st.samples); }
      var groups = groupsOf(st.samples), chipSig = groups.join('\u0001');
      if (chipSig !== lastChips) { lastChips = chipSig; renderChips(groups); }
      syncPick(st);
      var compSig = JSON.stringify([st.comparisons, groups]);
      if (compSig !== lastComps && !inside(compList)) { lastComps = compSig; renderComps(st); }
      tableMsg.textContent = vals.samples_n ? vals.samples_n + ' sample(s) in ' + groups.length + ' group(s).' : '';
      notesBox.textContent = '';
      (vals.meta_notes || []).concat(vals.con_notes || []).forEach(function (n) { notesBox.appendChild(el('li', { text: n })); });
      var big = hashTooBig(spec, st);
      tooBig.hidden = !big;
      tooBig.textContent = big ? 'The table and comparisons are too big for the page address, so the address leaves them out. Use "Save state (JSON)" to keep them and "Load state" to bring them back.' : '';
    }
    return { root: root, sync: sync };
  }

  function start(spec) {
    var state = fromHash(spec, location.hash);
    var form = $('#builder-form');
    form.innerHTML = '';
    var controls = {};                                   // id -> {row, inputs, ...}
    var sectionEls = [], samplesUI = null;

    function fieldRow(f) {
      var id = 'f-' + f.id, row, hint = f.hint ? el('small', { class: 'hint', text: f.hint, id: id + '-hint' }) : null;
      if (f.type === 'checkbox') {
        var cb = el('input', { type: 'checkbox', id: id });
        var lab = el('label', { class: 'check', for: id }, [cb, el('span', { text: f.label })]);
        row = el('div', { class: 'field field-check' }, [lab]);
        if (hint) row.appendChild(hint);
        var note = el('small', { class: 'hint reason', id: id + '-reason', hidden: '' });
        row.appendChild(note);
        cb.addEventListener('change', function () { state[f.id] = cb.checked; update(); });
        controls[f.id] = { row: row, input: cb, note: note, field: f };
      } else if (f.type === 'checkgroup') {
        var fs = el('fieldset', { class: 'field field-group' }, [el('legend', { text: f.label })]);
        var boxes = {};
        f.options.forEach(function (o) {
          var b = el('input', { type: 'checkbox', id: id + '-' + o, value: o });
          fs.appendChild(el('label', { class: 'check inline', for: id + '-' + o }, [b, el('span', { text: o })]));
          b.addEventListener('change', function () {
            state[f.id] = f.options.filter(function (x) { return boxes[x].checked; });
            update();
          });
          boxes[o] = b;
        });
        row = fs;
        controls[f.id] = { row: row, boxes: boxes, field: f };
      } else if (f.type === 'select') {
        var sel = el('select', { id: id });
        f.options.forEach(function (o) {
          sel.appendChild(el('option', { value: o, text: (f.optionLabels && f.optionLabels[o]) || o }));
        });
        row = el('div', { class: 'field' }, [el('label', { for: id, text: f.label }), sel]);
        sel.addEventListener('change', function () {
          state[f.id] = sel.value;
          if (f.id === 'organism') {                      // the usual genome for the organism, unless a custom one is chosen
            if (sel.value === 'human' && state.genome === 'mm10') state.genome = 'hg38';
            if (sel.value === 'mouse' && state.genome === 'hg38') state.genome = 'mm10';
          }
          update();
        });
        controls[f.id] = { row: row, input: sel, field: f };
      } else if (f.type === 'textarea') {
        var ta = el('textarea', { id: id, rows: String(f.rows || 6), autocomplete: 'off', spellcheck: 'false', wrap: 'off', placeholder: (spec.placeholders && spec.placeholders[f.id]) || '' });
        if (hint) ta.setAttribute('aria-describedby', id + '-hint');
        row = el('div', { class: 'field field-wide' }, [el('label', { for: id, text: f.label }), ta]);
        if (hint) row.appendChild(hint);
        ta.addEventListener('input', function () { state[f.id] = multiLine(ta.value, f.lineMax); update(true); });
        controls[f.id] = { row: row, input: ta, field: f };
      } else {
        var inp = el('input', { type: 'text', id: id, autocomplete: 'off', spellcheck: 'false', placeholder: (spec.placeholders && spec.placeholders[f.id]) || '' });
        if (hint) inp.setAttribute('aria-describedby', id + '-hint');
        row = el('div', { class: 'field' }, [el('label', { for: id, text: f.label }), inp]);
        if (hint) row.appendChild(hint);
        inp.addEventListener('input', function () { state[f.id] = oneLine(inp.value); update(true); });
        controls[f.id] = { row: row, input: inp, field: f };
      }
      if (f.wide) row.classList.add('field-wide');
      return row;
    }

    spec.sections.forEach(function (s) {
      var sec;
      if (s.collapsible) {                                // closed until asked for (or until the address holds a choice in it)
        sec = el('details', { class: 'card collapsible', id: 'sec-' + s.id }, [
          el('summary', {}, [el('h2', { id: 'h-' + s.id, text: s.title }), el('small', { class: 'hint', text: s.summary || '' })])]);
        var dflt = defaultState(spec);
        if (s.fields.some(function (f) { return String(state[f.id]) !== String(dflt[f.id]); })) sec.setAttribute('open', '');
      } else sec = el('section', { class: 'card', 'aria-labelledby': 'h-' + s.id }, [el('h2', { id: 'h-' + s.id, text: s.title })]);
      if (s.radio) {
        var rg = el('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Your input' });
        spec.inputs.forEach(function (i) {
          var rid = 'in-' + i.id;
          var r = el('input', { type: 'radio', name: 'input', id: rid, value: i.id });
          r.addEventListener('change', function () { state.input = i.id; update(); });
          rg.appendChild(el('label', { class: 'choice', for: rid }, [r, el('span', {}, [el('b', { text: i.label }), el('small', { text: i.hint })])]));
        });
        sec.appendChild(rg);
        controls.__radios = rg;
      }
      var grid = el('div', { class: 'fields' });
      var isoBox = null;
      s.fields.forEach(function (f) {
        var row = fieldRow(f);
        if (f.group === 'isoforms') {
          if (!isoBox) { isoBox = el('div', { class: 'subgroup', id: 'isoform-block' }); grid.appendChild(isoBox); }
          isoBox.appendChild(row);
        } else grid.appendChild(row);
      });
      sec.appendChild(grid);
      if (s.component === 'samples' && spec.samples) {    // the shared samples & comparisons block
        samplesUI = buildSamples(spec, {
          state: function () { return state; },
          mutate: function (fn) { fn(state); update(true); }
        });
        sec.appendChild(samplesUI.root);
      }
      sectionEls.push({ el: sec, when: s.when });
      form.appendChild(sec);
    });
    // the isoform master checkbox sits above its block
    var isoBlock = $('#isoform-block');
    if (isoBlock && controls.isoforms) isoBlock.parentNode.insertBefore(controls.isoforms.row, isoBlock);

    var pre = $('#out'), status = $('#copy-status');
    var lastText = '';

    function update(typing) {
      state = normalize(spec, state);
      var vals = Object.assign({}, state, derive(spec, state));
      var radio = $('#in-' + state.input);
      if (radio) radio.checked = true;
      sectionEls.forEach(function (x) { x.el.hidden = !holds(x.when, vals); });
      allFields(spec).forEach(function (f) {
        var c = controls[f.id];
        var visible = holds(f.when, vals);
        c.row.hidden = !visible;
        if (f.type === 'checkbox') {
          c.input.checked = !!state[f.id];
          var off = !!f.disabled || (f.disabledWhen && holds(f.disabledWhen, vals)) || (f.requires && !state[f.requires]);
          c.input.disabled = !!off;
          var reason = f.disabledWhen && holds(f.disabledWhen, vals) ? f.disabledReason
            : (f.requires && !state[f.requires] ? 'Needs rMATS splicing.' : (f.disabled ? 'Always on.' : ''));
          c.note.textContent = reason; c.note.hidden = !reason;
        } else if (f.type === 'checkgroup') {
          f.options.forEach(function (o) { c.boxes[o].checked = state[f.id].indexOf(o) >= 0; });
        } else if (!typing || document.activeElement !== c.input) {
          c.input.value = state[f.id];
        }
      });
      if (samplesUI) samplesUI.sync(state, vals);
      var res = assemble(spec, state);
      lastText = render(res.blocks);
      pre.textContent = lastText;
      var h = toHash(spec, state);
      try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch (e) { /* file: pages */ }
    }

    function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
      return new Promise(function (ok, fail) {
        var ta = el('textarea', { 'aria-hidden': 'true' });
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy') ? ok() : fail(); } catch (e) { fail(e); }
        document.body.removeChild(ta);
      });
    }
    function say(msg) { status.textContent = msg; clearTimeout(say.t); say.t = setTimeout(function () { status.textContent = ''; }, 2500); }
    $('#copy-btn').addEventListener('click', function () {
      copyText(lastText).then(function () { say('Copied'); }, function () { say('Copy failed: select the text and copy it'); });
    });
    $('#download-btn').addEventListener('click', function () {
      var blob = new Blob([toScript(spec, lastText)], { type: 'text/x-shellscript' });
      var a = el('a', { download: (spec.script && spec.script.file) || 'lab-rnaseq-commands.sh', href: URL.createObjectURL(blob) });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    window.addEventListener('hashchange', function () { state = fromHash(spec, location.hash); update(); });
    update();
  }

  function theme() {
    var btn = $('#theme-btn');
    btn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('rnaseq-builder-theme', next); } catch (e) { /* private mode */ }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    theme();
    var specUrl = window.BUILDER_SPEC || 'data/rnaseq.json';
    fetch(specUrl + '?v=' + (window.BUILDER_VERSION || ''))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(start)
      .catch(function (e) {
        $('#builder-form').innerHTML = '';
        $('#builder-form').appendChild(el('p', { class: 'error', text: 'Could not load ' + specUrl + ' (' + e.message + '). Serve the docs/ folder over http, or open the page from its web address.' }));
      });
  });
  return api;
});
