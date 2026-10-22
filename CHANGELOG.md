# Changelog

## [0.4.2](https://github.com/barzoj-co/llmentary-js/compare/v0.4.1...v0.4.2) (2026-10-22)


### Bug Fixes

* **deps:** bundle proxy v0.4.1 ([#39](https://github.com/barzoj-co/llmentary-js/issues/39)) ([22342a3](https://github.com/barzoj-co/llmentary-js/commit/22342a3e148ca57c2764d2992d51f370482f6a78))

## [0.4.1](https://github.com/barzoj-co/llmentary-js/compare/v0.4.0...v0.4.1) (2026-10-22)


### Bug Fixes

* enforce coverage floors and sync the 0.4.0 lockfile ([#32](https://github.com/barzoj-co/llmentary-js/issues/32)) ([d14690d](https://github.com/barzoj-co/llmentary-js/commit/d14690de02449c0019bdfc63211ba63bfaebe9bd))
* fail isolatedFrom on empty other and introduce later-call user texts ([#37](https://github.com/barzoj-co/llmentary-js/issues/37)) ([e9f2b83](https://github.com/barzoj-co/llmentary-js/commit/e9f2b83e21f8b312c66fa09db3d22a3aedb4a9c3))

## [Unreleased]

### Bug Fixes

* list in-flight calls on `WaitTimeoutError` from a 504 `wait_timeout` (DOG-38)
* compare served and packaged OpenAPI with the proxy stamp-then-sha256 check (DOG-44)
* fail `isolatedFrom` on an empty or unknown other session unless `allowEmpty` (DOG-32)
* treat every new user-role message on a later call as introduced (DOG-33)

## [0.4.0](https://github.com/barzoj-co/llmentary-js/compare/v0.3.0...v0.4.0) (2026-10-21)


### Features

* add ControlClient.openapi and ship the control contract ([#29](https://github.com/barzoj-co/llmentary-js/issues/29)) ([f0af2b2](https://github.com/barzoj-co/llmentary-js/commit/f0af2b255478f782915ce39b482bbb80aacd6f06))
* add expectNoCalls and allowEmpty on empty sessions ([#25](https://github.com/barzoj-co/llmentary-js/issues/25)) ([005cbd8](https://github.com/barzoj-co/llmentary-js/commit/005cbd89ffddbe20fa83a353b1e6cfe073fcee0a))
* expose typed clientAborted and abortPhase on calls ([#27](https://github.com/barzoj-co/llmentary-js/issues/27)) ([8b0a6b9](https://github.com/barzoj-co/llmentary-js/commit/8b0a6b9f17c919495bfeb0026978559df1610c83))


### Bug Fixes

* bundle proxy v0.4.0 ([#31](https://github.com/barzoj-co/llmentary-js/issues/31)) ([5ea2028](https://github.com/barzoj-co/llmentary-js/commit/5ea20280e6c17ce100c168978633731cd2408a38))
* label request-only spec status and omit http=0 ([#28](https://github.com/barzoj-co/llmentary-js/issues/28)) ([cbdc6f2](https://github.com/barzoj-co/llmentary-js/commit/cbdc6f2fa09ba188be18b4f37dc7bda1cd6e0b1d))
* match isolatedFrom on foreign user turns only ([#26](https://github.com/barzoj-co/llmentary-js/issues/26)) ([f0d1509](https://github.com/barzoj-co/llmentary-js/commit/f0d1509a9ff285687a979d5051c0d06941783213))

## [0.3.0](https://github.com/barzoj-co/llmentary-js/compare/v0.2.1...v0.3.0) (2026-10-21)


### Features

* map wait 404, expose seq, and add isolatedFrom ([#22](https://github.com/barzoj-co/llmentary-js/issues/22)) ([20fcdcc](https://github.com/barzoj-co/llmentary-js/commit/20fcdcc2e7dff7470c9a8e8aed05ababf5734856))


### Bug Fixes

* bundle proxy v0.2.2 ([#23](https://github.com/barzoj-co/llmentary-js/issues/23)) ([50c3c2d](https://github.com/barzoj-co/llmentary-js/commit/50c3c2df9beadfe3968a5d890e6c50e5e05f5770))
* bundle proxy v0.3.0 ([#24](https://github.com/barzoj-co/llmentary-js/issues/24)) ([8f01fd0](https://github.com/barzoj-co/llmentary-js/commit/8f01fd063b0fab21c9b79366dc78c53fc9f1f4a9))
* fail vacuous empty-filter assertions ([#18](https://github.com/barzoj-co/llmentary-js/issues/18)) ([7c92bc4](https://github.com/barzoj-co/llmentary-js/commit/7c92bc4f6a0d7dda314feb11c7178d646ec8e4e6))

## [0.2.1](https://github.com/barzoj-co/llmentary-js/compare/v0.2.0...v0.2.1) (2026-10-21)


### Bug Fixes

* bundle proxy v0.2.1 ([#19](https://github.com/barzoj-co/llmentary-js/issues/19)) ([b6a5cca](https://github.com/barzoj-co/llmentary-js/commit/b6a5cca0e89f166b13be05405438f54d5ab91087))

## [0.2.0](https://github.com/barzoj-co/llmentary-js/compare/v0.1.1...v0.2.0) (2026-10-20)


### Features

* add listSessions, spec accessors, and default upstream ([#15](https://github.com/barzoj-co/llmentary-js/issues/15)) ([3d6a2fc](https://github.com/barzoj-co/llmentary-js/commit/3d6a2fcdec5c415af5d7d38fd7098d002cb5b3f1))
* add pathBaseURL, turn filters, and mention helpers ([#16](https://github.com/barzoj-co/llmentary-js/issues/16)) ([383f12e](https://github.com/barzoj-co/llmentary-js/commit/383f12e9ebc1c6577ae1e3a84202d52ff810d04e))
* rename lab API to llmentary and slim README ([#11](https://github.com/barzoj-co/llmentary-js/issues/11)) ([a28f909](https://github.com/barzoj-co/llmentary-js/commit/a28f909a41b2fb8439d707d9cd6d8d5403f98b8b))


### Bug Fixes

* bundle proxy v0.2.0 ([#17](https://github.com/barzoj-co/llmentary-js/issues/17)) ([9d69116](https://github.com/barzoj-co/llmentary-js/commit/9d6911611297613a16817de2069f19d9bdf8b951))
* send timeout and quiet wait params the proxy reads ([#14](https://github.com/barzoj-co/llmentary-js/issues/14)) ([f4c790e](https://github.com/barzoj-co/llmentary-js/commit/f4c790e99f8501883d44d7182ddc19348dc66b3a))

## [0.1.1](https://github.com/barzoj-co/llmentary-js/compare/v0.1.0...v0.1.1) (2026-10-20)


### Bug Fixes

* publish local tarballs with explicit ./ path ([#10](https://github.com/barzoj-co/llmentary-js/issues/10)) ([6053104](https://github.com/barzoj-co/llmentary-js/commit/6053104788eee5ce6afe28fc55cf2b0c92431473))

## 0.1.0 (2026-10-20)


### Features

* publish to npm via trusted publishing from private repo ([#8](https://github.com/barzoj-co/llmentary-js/issues/8)) ([d45cfca](https://github.com/barzoj-co/llmentary-js/commit/d45cfcac9a7b29436b3d5f100f1fd1d7f24324b5))
