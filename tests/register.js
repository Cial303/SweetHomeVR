// Lets Node resolve the browser import map ('three', 'fflate', ...) to vendor/.
// Used by `npm test` via `node --import ./tests/register.js`.
import { register } from 'node:module';

register('./resolve-hooks.js', import.meta.url);
