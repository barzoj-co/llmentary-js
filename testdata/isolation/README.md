# Isolation test vectors

Vendored copy of the proxy's `testdata/isolation` from
[barzoj-co/llmentary#35](https://github.com/barzoj-co/llmentary/pull/35)
(`cursor/dog-29-isolation-spec-f2b6`). Normative cases for `isolatedFrom`
(DOG-29):

1. Every call in X has `session_id == X`.
2. No call id appears in both sessions.
3. No foreign user turn: a user-role message in X that X never introduced
   (last user-role message of each call) but Y did. Comparison is exact after
   trim / collapse whitespace / casefold; never substring. `min_chars` default 8.
   System / developer / tools are not compared.
4. Empty X or Y fails unless `allowEmpty`.

`scripts/check-isolation-vectors.mjs` diffs this directory against that proxy
path. Set `LLMENTARY_ISOLATION_VECTORS_DIR` to a checkout of
`testdata/isolation`, or `GH_TOKEN` to fetch
`barzoj-co/llmentary@cursor/dog-29-isolation-spec-f2b6:testdata/isolation`.
A configured-but-missing directory fails the check.
