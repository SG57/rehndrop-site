// JSON for a <script type="application/json"> block. JSON.stringify leaves "<" alone, so a title containing
// "</script>" (titles are read from Apple and YouTube at build time) would end the block early and put the rest
// into the page as markup. < is "<" to JSON.parse and plain text to the HTML parser; npm run check:csp fails
// on a raw "<" inside a data block.
/** @param {unknown} value */
export const jsonScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
