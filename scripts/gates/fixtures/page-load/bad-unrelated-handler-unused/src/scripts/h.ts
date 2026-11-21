export function start() {
  document.addEventListener('astro:page-load', () => { document.querySelector('[data-x]'); });
}
export const helper = 1;
