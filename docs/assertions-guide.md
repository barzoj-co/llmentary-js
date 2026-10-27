# Assertions guide

Trace assertions are deterministic: they read the recorded request and response, not the model's free text. Free-text helpers (`mentionsAny`, `finalResponseMentionsAny`) are probabilistic and belong on answers you already decided to accept.

See the proxy guide for the full split: [docs/assertions-guide.md](https://github.com/barzoj-co/llmentary/blob/main/docs/assertions-guide.md).

## Negative tests: asserting zero LLM calls

A whole-session `expect()` on a session that never went through the proxy fails on purpose. That is how you catch a base URL that bypassed recording. `SessionNotFound` from `wait({ minCalls: 0 })` is the 404, not an empty trace you can chain.

```ts
// Strict default — still fails on a never-created session
await expect(lm.expect().callCount(0)).rejects.toThrow(/no calls recorded/);

// Explicit zero-call assertion: 404 passes; a session with calls fails
await lm.expectNoCalls();

// Same opt-in on the expectation, then use callCount / notCalled / isolatedFrom
await lm.expect({ allowEmpty: true }).callCount(0);
await lm.expect().allowEmpty().notCalled("lookup_weather");
await used.expect().allowEmpty().isolatedFrom(unused);
```

`expectNoCalls()` calls `wait({ minCalls: 0 })`. `SessionNotFound` passes. A session with N recorded calls fails with `expected 0 LLM calls, got N` plus the trace summary.

`isolatedFrom` against a never-created or empty other session maps `SessionNotFound` to an empty other trace and then fails (`isolated_from needs calls on both sides`) unless you pass `{ allowEmpty: true }` or call `allowEmpty()`. Empty **this** session still fails unless you opt in the same way.

Client messages contain `known sessions:` at most once. The proxy 404 hint is `list sessions with GET /sessions`.
