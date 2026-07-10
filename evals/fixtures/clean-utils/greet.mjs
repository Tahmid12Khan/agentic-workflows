// Small formatting helpers, no external state, no I/O.
export function greet(name) {
  return `Hello, ${name}!`;
}

export function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}
