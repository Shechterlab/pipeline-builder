// `node --test tests/` on Node 22+ resolves the directory to this file (older Node finds *.mjs itself).
// The tests are in check_spec.mjs (RNA-seq analysis page), check_map.mjs (Map reads page) and check_samples.mjs
// (the samples & comparisons block, and the Proteomics page).
import('./check_spec.mjs');
import('./check_map.mjs');
import('./check_samples.mjs');
