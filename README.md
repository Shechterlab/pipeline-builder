# RNA-seq command builder

A static page (plain HTML, CSS and JS; no build, no analytics) that writes the `lab-rnaseq` commands for the lab's RNA-seq pipeline from a few choices: FASTQ folder, nf-core/rnaseq results or a count matrix; genome, organism, analyses, enrichment and figure style. Copy the commands or download them as a `.sh`; the choices are kept in the page address.

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
