# Shechter Lab command builders

Three static pages (plain HTML, CSS and JS; no build, no analytics), linked by a small nav in the header ("Map reads" | "RNA-seq analysis" | "Proteomics"):

- `docs/index.html`, the RNA-seq analysis builder (spec `docs/data/rnaseq.json`), described first below.
- `docs/map.html`, "Mapping · Shechter Lab" (spec `docs/data/map.json`), described under [Map reads](#map-reads).
- `docs/proteomics.html`, "Proteomics · Shechter Lab" (spec `docs/data/proteomics.json`), described under [Proteomics](#proteomics).

All three share the [Samples & comparisons](#samples--comparisons) block.

## RNA-seq analysis builder

A static page (plain HTML, CSS and JS; no build, no analytics) that writes the `lab-rnaseq` commands for the lab's RNA-seq pipeline from a few choices: FASTQ folder, nf-core/rnaseq results or a count matrix; genome, organism, analyses, enrichment and figure style, and, in a collapsed "Advanced (optional)" section, thresholds, your own gene sets, figure formats, group order, run name, a contrast subset and a dry run only. Empty or unchanged advanced fields write nothing. Copy the commands or download them as a `.sh`; the choices are kept in the page address.

Serve `docs/` (GitHub Pages, or `python3 -m http.server -d docs`) and open it. Each page loads its spec from `docs/data/` (`rnaseq.json`, `map.json`, `proteomics.json`), so it needs http, not `file://`.

## How to update

- Change what the page asks or writes in `docs/data/rnaseq.json` (fields, checkboxes, steps, command templates). `docs/assets/builder.js` only evaluates that file.
- When the pipeline's command line changes, regenerate the CLI snapshot from a lab_pipelines checkout and run the tests:

  ```bash
  python3 /path/to/lab_pipelines/scripts/export_cli_options.py --out docs/data/rnaseq_cli.json
  node --test tests/
  ```

  `tests/check_spec.mjs` fails if the page can write a subcommand or flag that is not in `rnaseq_cli.json`, and tests the quoting and which lines appear for which inputs. In lab_pipelines, `python3 scripts/export_cli_options.py --check docs/data/rnaseq_cli.json` says whether the snapshot is stale.
- After changing `builder.css` or `builder.js`, bump the `?v=` query string (and `BUILDER_VERSION`) in `docs/index.html`, `docs/map.html` and `docs/proteomics.html` (a test checks they agree).
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
- A freshly scaffolded project has a header-only `inputs/contrasts.csv`; mapping does not use it (`check` and `map` read it with `load_contrasts_if_any`, which treats a header-only file as no contrasts), so the page leaves it alone unless you define comparisons in the [Samples & comparisons](#samples--comparisons) block.

To change it, edit `docs/data/map.json`. Spec additions used by this page (all in `builder.js`): a `textarea` field (`"wide": true` spans the row; `"trimSlash": true` on a folder), `"derived": ["samplesheet", "accessions"]` (computes `sheet_lines`, `sheet_notes`, `sheet_has`, `acc_lines`, `acc_notes`, `acc_has`), lines `{ "heredoc": { "target": [words], "body": "<derived list>" } }` and `{ "notes": "<derived list>" }` (comment lines), words with `"prefix"` / `"suffix"` (`lab-<assay>`, `<folder>/inputs/x`), and `"script": { "name", "file", "waits" }` for the downloaded `.sh`.

Regenerate the CLI snapshots from a lab_pipelines checkout, then run the tests:

```bash
for p in rnaseq atacseq chipseq proseq proteomics; do
  python3 /path/to/lab_pipelines/scripts/export_cli_options.py --pipeline $p --out docs/data/${p}_cli.json
done
node --test tests/
```

`tests/check_map.mjs` fails if any command the page can write (over all assays, sources and options) uses a subcommand or flag that is not in the matching `<pipeline>_cli.json`; it also tests the FASTQ pairing (paired, single-end, mixed, lanes), the heredocs (run through bash with hostile names), the fetchngs parameters (listed from fetchngs 1.12.0's `nextflow_schema.json`), `bash -n` on every rendered script, and that no lab paths appear. `python3 scripts/export_cli_options.py --pipeline chipseq --check docs/data/chipseq_cli.json` (in lab_pipelines) says whether a snapshot is stale. When `configs/versions.yaml` moves fetchngs, change `-revision` in `docs/data/map.json`.

## Samples & comparisons

One component in `docs/assets/builder.js` (`buildSamples`; the logic is DOM-free functions, tested without a browser) used by all three pages. A spec turns it on with a top-level `"samples": { "pipeline": "$assay" | "rnaseq" | "proteomics", "showWhen": [[conditions], ...], "introBy": {...}, "listing": { "field", "kind": "fastq" | "columns", "note" } }` and a section with `"component": "samples"` (the section's `fields` hold its own checkboxes). Files are read in the browser (`FileReader`) and never uploaded; the page says so.

Three ways in, all filling one table (`state.samples`: sample, group, replicate, plus antibody / control for ChIP and strandedness for PRO-seq):

- a pasted listing: the FASTQ names of the map page (`fastq_list`, paired by `fastqSheet`'s code; one row per sample, lanes merged) or, on the proteomics page, the intensity column names or a proteinGroups header line (`columns`, `parseColumnNames`: `LFQ intensity` / `Intensity` / `iBAQ` columns become the labels). The table follows the list; edits to a row survive changes of the list, and a renamed sample, replicate, antibody, control or strandedness is used in the samplesheet too (so `check`'s sample alignment holds). Rows that come from the list cannot be removed in the table; remove the name from the list.
- a dropped or chosen CSV (`samplesFromCsv`): an nf-core `samplesheet.csv`, a `metadata.csv` or a proteomics `experimental_design.csv`. Columns are recognised by name (sample / sample_id / name / label, condition / group / treatment, replicate / rep, fastq_1, fastq_2, antibody, control, strandedness); the page shows which were recognised and which were not used. Non-CSV files, files over 1 MB, binary content, a file without a sample column and more than 500 samples are refused or cut, with a message.
- typed rows (add and remove).

Group and replicate are taken from the name when the file or list gives none (`<group>_REP<n>`, `_rep<n>`, `_R<n>`, a trailing `_<n>`, `-<n>` or `.<n>`; for proteomics labels the `LFQ intensity ` prefix and a `_LFQ` suffix are ignored first), and stay editable.

Comparisons: the group chips (draggable, HTML5 drag and drop) are dropped onto a Target and a Reference slot; the second drop adds the comparison. The same works by tapping two chips, or with the two selects and "Add comparison" (touch screens, keyboard). "All vs <reference>" adds every other group against one. Each comparison has an editable ID (`<target>_vs_<reference>` by default; unique), and a remove button. A comparison whose group left the table is left out of the CSV, with a note.

What is written (quoted heredocs; the delimiter is made unique among the lines), in the formats the pipelines read, from `lab_ngs_core/templates.py` (`<pipeline>_metadata`, `proteomics_experimental_design`, `<pipeline>_contrasts`) and `config.py` (`load_contrasts`, `_contrast_from_row`):

| file | columns |
|------|---------|
| `metadata.csv` (ATAC, PRO-seq, RNA-seq count matrix) | `sample,condition,replicate` |
| `metadata.csv` (ChIP / CUT&RUN / CUT&Tag) | `sample,condition,replicate,antibody` |
| `experimental_design.csv` (proteomics) | `label,condition,replicate` |
| `contrasts.csv` (all) | `id,variable,reference,target` (`variable` is `condition`; `label`, `blocking`, `notes` and the other optional columns are not written) |

Where it goes: ATAC / ChIP / PRO-seq on the map page write `P/inputs/metadata.csv` and, with comparisons, `P/inputs/contrasts.csv` (both replace the header-only files `init` wrote), before `check` and `map`. RNA-seq on the map page shows the block as an optional extra: with "Also save my comparisons as contrasts.csv" it writes `contrasts.csv` in the experiment folder and says that nothing reads it yet (`lab-rnaseq setup` drafts its own later). On the RNA-seq analysis page, "Define comparisons here" (nf-core results or FASTQ input) writes `analysis/inputs/contrasts.csv` right after `lab-rnaseq setup`, overwriting its draft, with a comment saying so (the groups must be values of the `condition` column `setup` drafted); for a count matrix the block writes `analysis/inputs/metadata.csv` and `analysis/inputs/contrasts.csv` before `lab-rnaseq run`, which then uses them (`run` copies a metadata file in only when the project has none, and drafts contrasts only when the project has none).

State in the address: `s=` (the table: cells joined by `~`, rows by `!`, `%`, `~`, `!` escaped; rows the pasted list brings back unedited are left out) and `c=` (`target~reference[~id]`, joined by `!`). When they would make the address longer than `HASH_LIMIT` (6000 characters) they are left out and the card says so; "Save state (JSON)" and "Load state" keep and restore them as a small file (`lab-builder-samples/1`).

## Proteomics

`docs/proteomics.html` (spec `docs/data/proteomics.json`) writes the `lab-proteomics` commands (`init`, `check`, `analyze` with a dry run first, `status`, `report`) and, from the Samples & comparisons block, `inputs/experimental_design.csv` and `inputs/contrasts.csv`. The label of a sample is the name of its intensity column in the protein table: paste the table's header line or its column names to fill the labels. Settings: imputation method (`imputation.method`: GSimp, MinProb, knn, bpca, RF, knn_GSimp, bpca_MinProb), significance column (`analysis.significance_column`: padj, pvalue), the matching threshold and the log2 fold-change threshold, and in Advanced the FDR correction (`analysis.fdr_correction`), Slurm account and partition, run name and a dry run.

`lab-proteomics` has no `config set`, so the page edits `inputs/project_config.yaml` with a small `python3 - ... <<'PY'` script (set `section.key`, keep comments, insert a missing key under its section; `init` does not write `significance_column`, for example). It also sets `project.name` (what you typed, else the folder's name): `init` leaves the example project name in the config. `tests/fixtures/proteomics_project_config.yaml` is what `lab-proteomics init` really writes; the tests run the script on it and, when a lab_pipelines checkout is next to this folder (or `LAB_PIPELINES` points at one), check the fixture against a fresh `init`, load the edited file with the pipeline's own `load_config` (schema validation) and run `analyze --dry-run` on the files the page writes. Every config key written must be in `docs/data/proteomics_config_keys.json` (made from `schema/proteomics.schema.json` the way the README snippet above makes the RNA-seq one).

What the protein table needs, from `R/run_dep2_analysis.R`: columns `Accession` and `Description` (or `Symbol`), and every column whose name contains an underscore is read as an intensity column (the labels must equal those names), so keep one intensity family in the table. A raw MaxQuant `proteinGroups.txt` names its ID columns `Protein IDs` / `Majority protein IDs` / `Fasta headers`, so (by reading the script, not run on real MaxQuant output) it needs those two columns added or renamed first.

## Tests

`node --test tests/` runs all of these (Node 22; the lab_pipelines-dependent ones are skipped when no checkout is found):

- `tests/check_spec.mjs`: the RNA-seq analysis page against `rnaseq_cli.json` and `rnaseq_config_keys.json`.
- `tests/check_map.mjs`: the map page against the four NGS CLI exports, the FASTQ pairing, heredocs and quoting.
- `tests/check_samples.mjs`: CSV detection (samplesheet, metadata, experimental design, junk, non-CSV, too large), group and replicate derivation, listings to table, comparisons to `contrasts.csv` and the metadata per pipeline (columns checked against `lab_ngs_core` when available, `load_contrasts` run on the output), heredoc quoting of odd names (run through bash), the drag-and-drop and select fallback functions, state in the address and as JSON, the map / RNA-seq / proteomics page flows, proteomics commands against `proteomics_cli.json`, and the config edit against the real `init` config.
- `tests/cli_model.mjs` is the shared command checker; `tests/index.js` loads the three test files.

In lab_pipelines: `python3 -m pytest lab-rnaseq/tests/test_export_cli_options.py`.
