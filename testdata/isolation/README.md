# Isolation test vectors

Normative cases for `isolatedFrom` / `IsolatedFrom` / `isolated_from` (DOG-29).

Until the proxy publishes `testdata/isolation` (docs PR), these files follow the spec in DOG-29:

1. Every call in X has `session_id == X`.
2. No call id appears in both sessions.
3. No foreign user turn: a user-role message in X that X never introduced (last user-role message of each call) but Y did. Comparison is exact after trim / collapse whitespace / casefold; never substring. `min_chars` default 8. System / developer / tools are not compared.
4. Empty X or Y fails unless `allowEmpty`.

`scripts/check-isolation-vectors.mjs` diffs this directory against the proxy copy at `PROXY_VERSION` when that copy exists.
