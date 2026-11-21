// Pointer from a gate's failure output to a guide in the platform-currency pack (the /platform-currency skill).
// Cite an id only where that guide really covers the rule; read the guide first. The repo's own rules always win
// over a guide, which the pointer says every time. selftest.mjs checks every id cited here against PACK_GUIDE_IDS.
export const platformGuide = (id, note = '') =>
  `platform-currency guide: ${id} (repo rules still win${note ? `; ${note}` : ''})`;
