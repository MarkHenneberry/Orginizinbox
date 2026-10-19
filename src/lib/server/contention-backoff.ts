// Keep fast first handoff, then bound contention traffic without shortening ownership windows.
export function contentionBackoff(attempt: number, random: () => number = Math.random) {
  const base = Math.min(1_000, 50 * 2 ** Math.min(attempt, 5));
  return base + Math.floor(random() * base / 2);
}
