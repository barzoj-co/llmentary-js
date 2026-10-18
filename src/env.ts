export function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
