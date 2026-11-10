# Shechter Lab command builders

Two static pages (plain HTML, CSS and JS; no build, no analytics), linked by a small nav in the header ("Map reads" | "RNA-seq analysis"):

- `docs/index.html`, the RNA-seq analysis builder (spec `docs/data/rnaseq.json`), described first below.
- `docs/map.html`, "Mapping · Shechter Lab" (spec `docs/data/map.json`), described under [Map reads](#map-reads).

## RNA-seq analysis builder

A static page (plain HTML, CSS and JS; no build, no analytics) that writes the `lab-rnaseq` commands for the lab's RNA-seq pipeline from a few choices: FASTQ folder, nf-core/rnaseq results or a count matrix; genome, organism, analyses, enrichment and figure style, and, in a collapsed "Advanced (optional)" section, thresholds, your own gene sets, figure formats, group order, run name, a contrast subset and a dry run only. Empty or unchanged advanced fields write nothing. Copy the commands or download them as a `.sh`; the choices are kept in the page address.

Serve `docs/` (GitHub Pages, or `python3 -m http.server -d docs`) and open it. Each page loads its spec from `docs/data/` (`rnaseq.json`, `map.json`), so it needs http, not `file://`.

## How to update

- Change what the page asks or writes in `docs/data/rnaseq.json` (fields, checkboxes, steps, command templates). `docs/assets/builder.js` only evaluates that file.
- When the pipeline's command line changes, regenerate the CLI snapshot from a lab_pipelines checkout and run the tests:

  ```bash
  python3 /path/to/lab_pipelines/scripts/export_cli_options.py --out docs/data/rnaseq_cli.json
  node --test tests/
  ```

  `tests/check_spec.mjs` fails if the page can write a subcommand or flag that is not in `rnaseq_cli.json`, and tests the quoting and which lines appear for which inputs. In lab_pipelines, `python3 scripts/export_cli_options.py --check docs/data/rnaseq_cli.json` says whether the snapshot is stale.
- After changing `builder.css` or `builder.js`, bump the `?v=` query string (and `BUILDER_VERSION`) in `docs/index.html` and `docs/map.html`.
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

## Map reads

`docs/map.html` takes an assay (RNA-seq, ATAC-seq, ChIP-seq / CUT&RUN / CUT&Tag, PRO-seq) and where the reads come from (a FASTQ folder on the cluster, or GEO / SRA / ENA accessions) and writes the commands from reads to mapped output with nf-core, through `lab-rnaseq`, `lab-atacseq`, `lab-chipseq` and `lab-proseq`. It stops at mapping. Same behaviour as the other page: copy or download a `.sh`, choices in the page address, user text single-quoted, `/path/to/...` placeholders, no lab paths or account names.

What it writes, from the CLIs' own code:

- RNA-seq, FASTQ folder: `cd`, `lab-rnaseq samplesheet`, `map --dry-run`, `map`, `map --status --watch`. RNA-seq has no fetch command, so for public data it writes `accessions.csv` and `nextflow run nf-core/fetchngs -revision 1.12.0 -profile <profile> --input accessions.csv --outdir "$PWD/fetchngs" --nf_core_pipeline rnaseq -resume` (the version `lab-chipseq`'s `configs/versions.yaml` pins; `--nf_core_pipeline rnaseq` makes fetchngs write an nf-core/rnaseq samplesheet), then copies `fetchngs/samplesheet/samplesheet.csv` and continues with `map`.
- ATAC / ChIP / PRO-seq: `lab-X init --project-dir P`, the samplesheet, `check`, `map --dry-run`, `map`, `status --stage map`. `init` writes `P/inputs/project_config.yaml`, so the page edits that rather than writing a config: for CUT&RUN / CUT&Tag it runs a `sed` on the `assay_type:` line (ChIP only); the Slurm account is a comment (`project.slurm_account`), because these CLIs have no `config set`. The `P` folder should be absolute: the fetch job `cd`s into the run folder and a relative `--accessions` path breaks.
- FASTQ names: the user pastes `ls` output; `docs/assets/builder.js` (`fastqSheet`) pairs `_R1/_R2`, `_1/_2`, `.R1/.R2` (a file without a mate is single-end; the single-end box never pairs), drops lane and `_S<n>` tokens, takes the replicate from `<group>_REP<n>` or a trailing `_<n>` / `-<n>` (else the cell is left empty, with a note), and writes `sample,fastq_1,fastq_2,replicate` (ATAC), `...,replicate,antibody,control` (ChIP: `EDIT_ANTIBODY` / `EDIT_CONTROL`, `Input` / `IgG` recognised by name) or `sample,fastq_1,fastq_2,strandedness` (PRO-seq) into `P/inputs/samplesheet.csv` with a `cat > ... <<'EOF'` heredoc. Index (`I1`/`I2`) and `Undetermined` files and anything not `.fastq.gz` / `.fq.gz` are left out and named.
- Accessions: one id per line, no header (what fetchngs 1.12.0 reads; its schema accepts SRA, ENA, DDBJ and GEO GSE/GSM ids) into `P/inputs/accessions.csv`, then `lab-X fetch --run-name fetch --dry-run`, `fetch`, `status --stage fetch`; ATAC-seq copies the fetched samplesheet (columns `sample,fastq_1,fastq_2,replicate`), ChIP and PRO-seq say how to write theirs.
- A freshly scaffolded project has a header-only `inputs/contrasts.csv`, which makes `check` and `map` stop with "No valid contrasts found"; mapping does not use it, so the page moves an empty one aside (`contrasts.csv.empty`).

To change it, edit `docs/data/map.json`. Spec additions used by this page (all in `builder.js`): a `textarea` field (`"wide": true` spans the row; `"trimSlash": true` on a folder), `"derived": ["samplesheet", "accessions"]` (computes `sheet_lines`, `sheet_notes`, `sheet_has`, `acc_lines`, `acc_notes`, `acc_has`), lines `{ "heredoc": { "target": [words], "body": "<derived list>" } }` and `{ "notes": "<derived list>" }` (comment lines), words with `"prefix"` / `"suffix"` (`lab-<assay>`, `<folder>/inputs/x`), and `"script": { "name", "file", "waits" }` for the downloaded `.sh`.

Regenerate the CLI snapshots from a lab_pipelines checkout, then run the tests:

```bash
for p in rnaseq atacseq chipseq proseq; do
  python3 /path/to/lab_pipelines/scripts/export_cli_options.py --pipeline $p --out docs/data/${p}_cli.json
done
node --test tests/
```

`tests/check_map.mjs` fails if any command the page can write (over all assays, sources and options) uses a subcommand or flag that is not in the matching `<pipeline>_cli.json`; it also tests the FASTQ pairing (paired, single-end, mixed, lanes), the heredocs (run through bash with hostile names), the fetchngs parameters (listed from fetchngs 1.12.0's `nextflow_schema.json`), `bash -n` on every rendered script, and that no lab paths appear. `python3 scripts/export_cli_options.py --pipeline chipseq --check docs/data/chipseq_cli.json` (in lab_pipelines) says whether a snapshot is stale. When `configs/versions.yaml` moves fetchngs, change `-revision` in `docs/data/map.json`.
