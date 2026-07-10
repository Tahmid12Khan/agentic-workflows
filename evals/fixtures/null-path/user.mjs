// Renders a user's avatar. profile is optional on the User model (set only after onboarding).
export function getAvatarUrl(user) {
  const profile = user.profile;
  return profile.avatar.url; // profile can be null/undefined pre-onboarding — crashes here
}

export function greet(user) {
  return `Hello, ${user.profile.displayName ?? 'friend'}!`;
}
