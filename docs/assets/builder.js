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
  function multiLine(v) {
    return String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n').slice(0, 5000)
      .map(function (l) { return l.replace(/\s+$/, '').slice(0, 400); })
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
    return st;
  }

  // a state that is safe to evaluate: unknown ids dropped, selects limited to their options, text on one line,
  // the rules the form enforces (count matrix has no isoforms; SpliceImpactR and sashimi need rMATS)
  function normalize(spec, raw) {
    var st = defaultState(spec);
    raw = raw || {};
    if (spec.inputs.some(function (i) { return i.id === raw.input; })) st.input = raw.input;
    allFields(spec).forEach(function (f) {
      var v = raw[f.id];
      if (v === undefined || f.disabled) return;
      if (f.type === 'checkbox') st[f.id] = v === true || v === 'true' || v === '1';
      else if (f.type === 'checkgroup') {
        var list = Array.isArray(v) ? v : String(v).split(',');
        st[f.id] = f.options.filter(function (o) { return list.indexOf(o) >= 0; });
      } else if (f.type === 'select') {
        if (f.options.indexOf(String(v)) >= 0) st[f.id] = String(v);
      } else st[f.id] = f.type === 'textarea' ? multiLine(v) : oneLine(v);
    });
    if (st.input === 'matrix') st.isoforms = false;
    Object.keys(spec.moduleRequires || {}).forEach(function (m) {
      if (!st[spec.moduleRequires[m]]) st[m] = false;
    });
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

  // replicate number from <group>_REP<n>, else a trailing _<n> / -<n>; '' when the name holds none
  function replicateOf(sample) {
    var m = /^(.*?)[._-]REP(\d+)$/i.exec(sample) || /^(.+?)[._-](\d{1,2})$/.exec(sample);
    return m ? String(parseInt(m[2], 10)) : '';
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

  function csvField(v) { v = String(v); return /[",]|^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  var CONTROL_RE = /(^|[._-])(input|igg)([._-]|$)/i;

  // the samplesheet of an assay (header and columns as the lab CLIs' templates), plus notes for the output
  function fastqSheet(assay, text, folder, singleEnd, strand) {
    var parsed = parseFastqNames(text, folder), rows = pairFastqs(parsed.files, singleEnd), notes = [], lines;
    var header = { atacseq: 'sample,fastq_1,fastq_2,replicate', chipseq: 'sample,fastq_1,fastq_2,replicate,antibody,control',
                   proseq: 'sample,fastq_1,fastq_2,strandedness' }[assay];
    if (!header || !rows.length) return { lines: [], notes: skippedNote(parsed.skipped), rows: rows };
    var edits = 0, noRep = [];
    lines = [header].concat(rows.map(function (r) {
      var rep = replicateOf(r.sample), cols = [r.sample, r.fastq1, r.fastq2];
      if (assay === 'proseq') cols.push(strand || 'forward');
      else {
        cols.push(rep);
        if (!rep && noRep.indexOf(r.sample) < 0) noRep.push(r.sample);
        if (assay === 'chipseq') {
          var c = CONTROL_RE.exec(r.sample);
          if (c) cols.push(c[2].toLowerCase() === 'igg' ? 'IgG' : 'Input', '');
          else { cols.push('EDIT_ANTIBODY', 'EDIT_CONTROL'); edits++; }
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
    if ((spec.derived || []).indexOf('samplesheet') >= 0) {      // map page: the samplesheet written from the pasted names
      var sheet = fastqSheet(st.assay, st.fastq_list, st.fastq_dir || '/path/to/fastqs', !!st.single_end, st.proseq_strand);
      d.sheet_lines = sheet.lines; d.sheet_notes = sheet.notes; d.sheet_has = sheet.lines.length > 0;
    }
    if ((spec.derived || []).indexOf('accessions') >= 0) {       // map page: accessions.csv, one ID per line
      var acc = parseAccessions(st.accessions);
      d.acc_lines = acc.ids; d.acc_notes = acc.notes; d.acc_has = acc.ids.length > 0;
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
  function heredocText(spec, h, r) {
    var body = r.vals[h.body] || [], delim = h.delimiter || 'EOF';
    while (body.indexOf(delim) >= 0) delim += '_X';
    return ['cat > ' + lineText(spec, { words: h.target }, r) + " <<'" + delim + "'"].concat(body, [delim]).join('\n');
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
  function toHash(spec, rawState) {
    var st = normalize(spec, rawState), def = defaultState(spec), p = [];
    function enc(x) { return encodeURIComponent(x).replace(/'/g, '%27'); }
    function add(k, v) { p.push(enc(k) + '=' + enc(v)); }
    if (st.input !== def.input) add('input', st.input);
    allFields(spec).forEach(function (f) {
      if (f.disabled) return;
      var a = st[f.id], b = def[f.id];
      if (f.type === 'checkgroup') { if (a.join(',') !== b.join(',')) add(f.id, a.join(',') || '-'); }
      else if (a !== b) add(f.id, f.type === 'checkbox' ? (a ? '1' : '0') : a);
    });
    return p.join('&');
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
    fastqSheet: fastqSheet, parseAccessions: parseAccessions, sampleName: sampleName, replicateOf: replicateOf
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

  function start(spec) {
    var state = fromHash(spec, location.hash);
    var form = $('#builder-form');
    form.innerHTML = '';
    var controls = {};                                   // id -> {row, inputs, ...}

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
        ta.addEventListener('input', function () { state[f.id] = multiLine(ta.value); update(true); });
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
      $('#in-' + state.input).checked = true;
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
