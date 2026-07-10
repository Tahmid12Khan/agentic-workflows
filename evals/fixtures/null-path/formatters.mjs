// Pure string formatting used by the profile page — no user object touched here.
export function initials(displayName) {
  return displayName.split(' ').map((w) => w[0]).join('').toUpperCase();
}
