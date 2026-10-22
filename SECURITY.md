# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

https://github.com/barzoj-co/llmentary-js/security/advisories/new

Do **not** open a public issue for a security report.

Issues in the recording proxy binary itself belong in [`barzoj-co/llmentary`](https://github.com/barzoj-co/llmentary), not in this client repository.

## Supported versions

The latest `0.x` minor of `llmentary` is supported.

## Scope

In scope for this repository:

- platform-package binary resolution and execution
- the `binary.ts` download/checksum path
- Jest global setup/teardown state files
- environment variable and token handling in this client

## Policy

Reports are handled on a best-effort basis. There is no SLA.

npm trusted publishing generates provenance automatically. Consumers can verify the install tree with `npm audit signatures`.
