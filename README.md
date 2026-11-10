# RNA-seq command builder

A static page (plain HTML, CSS and JS; no build, no analytics) that writes the `lab-rnaseq` commands for the lab's RNA-seq pipeline from a few choices: FASTQ folder, nf-core/rnaseq results or a count matrix; genome, organism, analyses, enrichment and figure style, and, in a collapsed "Advanced (optional)" section, thresholds, your own gene sets, figure formats, group order, run name, a contrast subset and a dry run only. Empty or unchanged advanced fields write nothing. Copy the commands or download them as a `.sh`; the choices are kept in the page address.

Serve `docs/` (GitHub Pages, or `python3 -m http.server -d docs`) and open it. The page loads `docs/data/rnaseq.json`, so it needs http, not `file://`.

## How to update

- Change what the page asks or writes in `docs/data/rnaseq.json` (fields, checkboxes, steps, command templates). `docs/assets/builder.js` only evaluates that file.
- When the pipeline's command line changes, regenerate the CLI snapshot from a lab_pipelines checkout and run the tests:

  ```bash
  python3 /path/to/lab_pipelines/scripts/export_cli_options.py --out docs/data/rnaseq_cli.json
  node --test tests/
  ```

  `tests/check_spec.mjs` fails if the page can write a subcommand or flag that is not in `rnaseq_cli.json`, and tests the quoting and which lines appear for which inputs. In lab_pipelines, `python3 scripts/export_cli_options.py --check docs/data/rnaseq_cli.json` says whether the snapshot is stale.
- After changing `builder.css` or `builder.js`, bump the `?v=` query string in `docs/index.html`.
- `docs/data/rnaseq_config_keys.json` is the allow-list of `config set` keys (every `section.key` of the pipeline's config schema, with its type) that the tests check the spec against. Regenerate it from a lab_pipelines checkout when `lab_ngs_core/config.py` changes (run `python3 scripts/export_config_schema.py` there first so `schema/rnaseq.schema.json` is current):

  ```bash
  python3 - <<'EOF'
  import json
  props = json.load(open('/path/to/lab_pipelines/schema/rnaseq.schema.json'))['properties']
  keys = {f'{s}.{k}': (v['type'] if isinstance(v['type'], str) else '|'.join(v['type']))
          for s, b in sorted(props.items()) if 'properties' in b for k, v in sorted(b['properties'].items())}
  json.dump({'pipeline': 'lab-rnaseq', 'source': 'lab_pipelines/schema/rnaseq.schema.json', 'keys': keys},
            open('docs/data/rnaseq_config_keys.json', 'w'), indent=1)
  EOF
  ```
- Spec format additions used by the Advanced section: a section with `"collapsible": true` is a `<details>`; a text field with `"list": true` gets `<id>_items` and `<id>_list`; with `"numeric": true` (and `min`/`max`) it gets `<id>_num` and `<id>_changed`; a word with `"each": "<list>"` repeats its flag per item; top-level `"flags"` names conditions for `when`.
