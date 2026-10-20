export interface MentionsAnyOptions {
  /** Treat `20°C`, `20 °C`, and `20 degrees` as the same token. Default true. */
  normalizeNumbers?: boolean;
  /** Case-insensitive match. Default true. */
  casefold?: boolean;
}

export interface MentionsAnyResult {
  pass: boolean;
  message: string;
}

const EXCERPT_LIMIT = 200;

/** Plain-text any-of matcher for app answers that are not on the trace. */
export function mentionsAny(
  text: string,
  candidates: readonly string[],
  options: MentionsAnyOptions = {},
): boolean {
  return mentionsAnyResult(text, candidates, options).pass;
}

export function mentionsAnyResult(
  text: string,
  candidates: readonly string[],
  options: MentionsAnyOptions = {},
): MentionsAnyResult {
  const hay = normalizeMention(text, options);
  const matched = candidates.find((candidate) => hay.includes(normalizeMention(candidate, options)));
  const excerpt = text.length > EXCERPT_LIMIT ? text.slice(0, EXCERPT_LIMIT) : text;
  if (matched !== undefined) {
    return { pass: true, message: `answer mentions ${JSON.stringify(matched)}` };
  }
  return {
    pass: false,
    message: `expected answer to mention any of [${candidates.map((candidate) => JSON.stringify(candidate)).join(", ")}]; excerpt: ${excerpt}`,
  };
}

function normalizeMention(text: string, options: MentionsAnyOptions): string {
  let out = text.normalize("NFKC");
  if (options.casefold !== false) out = out.toLocaleLowerCase();
  if (options.normalizeNumbers === false) return out;
  out = out.replace(/\s*degrees(?:\s+c(?:elsius)?)?\b/gi, "°c");
  out = out.replace(/[º˚]/g, "°");
  out = out.replace(/\s*°\s*/g, "°");
  out = out.replace(/(\d)\s+(?=[a-z°])/gi, "$1");
  out = out.replace(/(\d),(\d)/g, "$1.$2");
  out = out.replace(/(\d+)\.0+\b/g, "$1");
  return out;
}
