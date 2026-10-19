// Site constants in one place. Plain numbers; each is read by the component or script named.

// index (Index.astro, list.ts)
export const INDEX_CAP = 12; // items a section shows before `more.`
export const LETTER_STRIP_AFTER = 40; // the letter strip appears once the catalogue passes this many tracks

// arrival (data.ts): the newest release leads the stage while it is this fresh
export const ARRIVAL_DAYS = 14;

// toasts (sheet.ts, track.ts)
export const TOAST_MS = 2000;

// the portrait phone velvet (Base.astro): one media query for the preload, the CSS and the lens
export const PHONE_VELVET_MQ = '(max-width: 700px) and (orientation: portrait)';
