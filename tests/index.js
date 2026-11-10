// `node --test tests/` on Node 22+ resolves the directory to this file (older Node finds *.mjs itself).
// The tests are in check_spec.mjs (RNA-seq analysis page) and check_map.mjs (Map reads page).
import('./check_spec.mjs');
import('./check_map.mjs');
