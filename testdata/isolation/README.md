# Isolation test vectors

Vendored copy of the proxy's `testdata/isolation` from
[barzoj-co/llmentary#42](https://github.com/barzoj-co/llmentary/pull/42)
(merged to `main`). Normative cases for `isolatedFrom`
(DOG-29, DOG-32, DOG-33):

1. Every call in X has `session_id == X`.
2. No call id appears in both sessions.
3. No foreign user turn: a user-role message in X that X never introduced
   but Y did. The first call introduces only its last user-role message;
   later calls introduce **each** new user-role message whose normalized
   form was not already present in an earlier call of the same session.
   Inbound history on the first call is seen, not introduced; repeating it
   later is still a leak. Comparison is exact after trim / collapse
   whitespace / casefold; never substring. `min_chars` default 8. System /
   developer / tools are not compared.
4. Empty X fails unless `allowEmpty`. Empty or unknown Y fails unless
   `allowEmpty` (`no calls recorded for session <Y> (isolated_from needs
   calls on both sides)`). New cases include `empty-other`,
   `empty-other-allow`, `missing-other-id`, `unknown-other-id`,
   `later-call-two-new-user-messages`,
   `later-call-two-new-user-messages-responses`, and
   `multi-turn-own-history`.

`scripts/check-isolation-vectors.mjs` diffs this directory against that proxy
path. Set `LLMENTARY_ISOLATION_VECTORS_DIR` to a checkout of
`testdata/isolation`, or let the script fetch
`barzoj-co/llmentary@main:testdata/isolation` anonymously (`GH_TOKEN` /
`GITHUB_TOKEN` are optional, for API rate limits only).
A configured-but-missing directory fails the check.
