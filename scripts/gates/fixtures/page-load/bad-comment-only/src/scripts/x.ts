// remember to hook astro:page-load here: document.addEventListener('astro:page-load', go)
/* addEventListener('astro:after-swap', go) */
export function start() {
  document.querySelector('[data-x]')?.classList.add('on');
}
