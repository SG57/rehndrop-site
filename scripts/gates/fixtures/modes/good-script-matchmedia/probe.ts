// a rule such as @media (forced-colors: active) would belong in a11y-modes.css
export const forced = matchMedia("(forced-colors: active)").matches;
/* @media (prefers-contrast: more) is mentioned here in prose only */
