export function start() {
  document.addEventListener('astro:after-swap', () => {
    document.querySelector('[data-x]');
  });
}
