// Fire-and-forget diagnostic logging — stateless, nothing shared across calls.
export function logConfigLoad(source) {
  console.log(`config loaded from ${source}`);
}
