# Security policy

## Supported versions

This client is pre-1.0. Only the latest published `0.x` minor of `llm-test-lab` and the matching `@llm-test-lab/<platform>` packages is supported.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories:

https://github.com/barzoj-co/llm-test-lab-js/security/advisories/new

Do **not** file a public issue, discussion, or pull request that describes the vulnerability.

This is a best-effort process with no SLA. The maintainer will acknowledge the report when they can and will coordinate a fix and disclosure.

Issues in the recording proxy binary belong in [`barzoj-co/llm-test-lab`](https://github.com/barzoj-co/llm-test-lab), not this client repository.

## In scope

- Resolution and execution of the bundled proxy binary from an optional `@llm-test-lab/<platform>` package
- The `binary.ts` download/checksum path
- Jest global setup/teardown state files
- Environment variable and token handling in this client

## Out of scope

- Vulnerabilities in upstream LLM providers
- Issues that require a public proof-of-concept against a third-party service
- Support for versions older than the latest `0.x` minor

## Supply chain notes for users

Published packages are intended to use [npm provenance](https://docs.npmjs.com/generating-provenance-statements) once trusted publishing is enabled. You can verify install integrity with `npm audit signatures` after install.
