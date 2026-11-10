/* RNA-seq command builder. The commands come from data/rnaseq.json (steps, fields, templates);
   this file only evaluates that spec. The same code runs under node for tests/check_spec.mjs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RnaseqBuilder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ shell quoting
  function oneLine(v) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim(); }

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
      } else st[f.id] = oneLine(v);
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

  function derive(spec, st) {
    var d = {};
    var modules = spec.moduleOrder.filter(function (m) { return st[m]; });
    d.modules_list = modules.join(',');
    d.isoforms_on = !!(st.isoforms && st.input !== 'matrix' && modules.length);
    [['go', 'go_list'], ['collections', 'collections_list'], ['fgsea', 'fgsea_list']].forEach(function (p) {
      var chosen = listText(spec, p[0], st);
      d[p[1]] = chosen.join(',');
      d[p[0] + '_changed'] = chosen.length > 0 && chosen.join(',') !== spec.defaults[p[0]].join(',');
    });
    var base = String(st.genome || '').split('_')[0];
    d.preset = PRESET_OF[base] && PRESET_OF[base] === st.organism ? base : '';
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
    var fieldType = {};
    allFields(spec).forEach(function (f) { fieldType[f.id] = f.type; });
    return {
      vals: vals,
      // the word for a value key: user-typed text is single-quoted, an empty field falls back to a placeholder
      value: function (key) {
        var v = vals[key];
        if (typeof v === 'boolean' || v == null) v = v ? 'true' : '';
        v = oneLine(v);
        if (fieldType[key] === 'text') {
          if (v) return shellQuote(v);
          var ph = spec.placeholders && spec.placeholders[key];
          return ph || '';
        }
        return /^[A-Za-z0-9_.,=+-]+$/.test(v) ? v : (v ? shellQuote(v) : '');
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
      var v = undefined;
      if (w.value !== undefined) { v = r.value(w.value); if (!v) { if (w.flag) continue; continue; } }
      else if (w.text !== undefined) v = w.text;
      if (w.flag) { out.push(w.flag); if (v !== undefined) out.push(v); }
      else if (v !== undefined) out.push(v);
    }
    return out.join(' ');
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
    return '#!/usr/bin/env bash\n' +
      '# Written by the Shechter Lab RNA-seq command builder.\n' +
      '# There is no `set -euo pipefail` on purpose: some steps wait on Slurm jobs (map --status --watch,\n' +
      '# status --watch) and a non-zero exit while a job is still running must not stop the script.\n' +
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
    toHash: toHash, fromHash: fromHash
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
      } else {
        var inp = el('input', { type: 'text', id: id, autocomplete: 'off', spellcheck: 'false', placeholder: (spec.placeholders && spec.placeholders[f.id]) || '' });
        if (hint) inp.setAttribute('aria-describedby', id + '-hint');
        row = el('div', { class: 'field' }, [el('label', { for: id, text: f.label }), inp]);
        if (hint) row.appendChild(hint);
        inp.addEventListener('input', function () { state[f.id] = oneLine(inp.value); update(true); });
        controls[f.id] = { row: row, input: inp, field: f };
      }
      return row;
    }

    spec.sections.forEach(function (s) {
      var sec = el('section', { class: 'card', 'aria-labelledby': 'h-' + s.id }, [el('h2', { id: 'h-' + s.id, text: s.title })]);
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
    var isoMaster = controls.isoforms.row, isoBlock = $('#isoform-block');
    if (isoBlock) isoBlock.parentNode.insertBefore(isoMaster, isoBlock);

    var pre = $('#out'), status = $('#copy-status');
    var lastText = '';

    function update(typing) {
      state = normalize(spec, state);
      var vals = Object.assign({}, state, derive(spec, state));
      $('#in-' + state.input).checked = true;
      allFields(spec).forEach(function (f) {
        var c = controls[f.id];
        var visible = f.id === 'exp' || holds(f.when, vals);
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
      var a = el('a', { download: 'lab-rnaseq-commands.sh', href: URL.createObjectURL(blob) });
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
    fetch('data/rnaseq.json?v=' + (window.BUILDER_VERSION || ''))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(start)
      .catch(function (e) {
        $('#builder-form').innerHTML = '';
        $('#builder-form').appendChild(el('p', { class: 'error', text: 'Could not load data/rnaseq.json (' + e.message + '). Serve the docs/ folder over http, or open the page from its web address.' }));
      });
  });
  return api;
});
