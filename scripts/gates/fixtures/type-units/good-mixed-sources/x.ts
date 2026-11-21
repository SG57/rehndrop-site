// a comment about font-size: 12px must not count
export function f(el: HTMLElement) {
  el.style.fontSize = '1.1rem';
  el.style.setProperty('padding', '12px');
}
