// Title folding for search: case, diacritics, apostrophes and punctuation all fall away, so
// "what's my name", "WHATS MY NAME!" and "whåts my name" are the same key. Used at build
// (data-title on every index item) and in the browser (the query), so both sides agree.
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// the letter a title files under in the letter strip: a-z, or # for anything else
export const letterOf = (s: string) => {
  const c = fold(s).charAt(0);
  return c >= 'a' && c <= 'z' ? c : '#';
};
