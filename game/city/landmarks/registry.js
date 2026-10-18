// The list of landmark definitions (see index.js for the format). Landmark modules are imported
// here; keep one module per landmark so they can be worked on independently.
// ES module imports are hoisted, so every module is loaded before LANDMARKS is filled.

// landmarks-a: Keleti, Blaha, Rákóczi út, the Museum quarter.
import keleti from './keleti.js';

// landmarks-b: squares, churches, theatre, market hall, cemetery.
import erkel from './erkel.js';
import vasarcsarnok from './vasarcsarnok.js';

export const LANDMARKS = [keleti, erkel, vasarcsarnok];
