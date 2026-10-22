import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("public GitHub Releases — no private-repo token crutch", () => {
  const ci = read(".github/workflows/ci.yml");
  const release = read(".github/workflows/release.yml");
  const contributing = read("CONTRIBUTING.md");
  const isolation = read("scripts/check-isolation-vectors.mjs");
  const e2eGate = read("scripts/e2e-gate.sh");

  it("keeps CI job names byte-identical", () => {
    expect(ci).toContain("    name: Node ${{ matrix.node }}");
    expect(ci).toContain("    name: OpenAI E2E");
    expect(ci).toContain("    name: e2e-gate");
    expect(ci).toContain("    name: Pack consumers");
  });

  it("does not require LLMTESTLAB_REPO_TOKEN anywhere in workflows or installers", () => {
    expect(ci).not.toContain("LLMTESTLAB_REPO_TOKEN");
    expect(release).not.toContain("LLMTESTLAB_REPO_TOKEN");
    expect(read("scripts/install-proxy.sh")).not.toContain("LLMTESTLAB_REPO_TOKEN");
    expect(isolation).not.toContain("LLMTESTLAB_REPO_TOKEN");
    expect(contributing).not.toContain("LLMTESTLAB_REPO_TOKEN");
    expect(read("src/binary.ts")).not.toContain("repository is private");
  });

  it("installs the public proxy and runs real-proxy tests on fork PRs", () => {
    expect(ci).not.toContain("Skip private-binary tests for fork PR");
    expect(ci).not.toContain("Require LLMTESTLAB_REPO_TOKEN");
    expect(ci).toContain("      - name: Install released proxy");
    expect(ci).toContain("      - name: Real Go proxy tests");
    expect(ci).not.toMatch(/- name: Install released proxy\n\s+if:/);
    expect(ci).not.toMatch(/- name: Real Go proxy tests\n\s+if:/);
    expect(ci).not.toMatch(/- name: Require installed proxy binary\n\s+if:/);
    expect(ci).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("documents the public proxy and the fork e2e-gate result", () => {
    expect(read("docs/assertions-guide.md")).not.toContain("private until");
    expect(read("docs/releasing.md")).not.toContain("once the repo is public");
    expect(read("SECURITY.md")).not.toContain("Once the repository is public");
    expect(read("docs/api.md")).not.toContain("Do not link the private proxy repo");
    expect(contributing).toContain("skipped (fork, no secrets)");
    expect(contributing).toContain("fork PRs still run the real-proxy tests");
    expect(e2eGate).toContain('echo "skipped (fork, no secrets)"');
    expect(isolation).not.toContain('skip: "no GH_TOKEN/GITHUB_TOKEN"');
    expect(read("testdata/isolation/README.md")).toContain("anonymously");
  });

  it("e2e-gate --self-test covers fork skip and same-repo fail corners", () => {
    const result = spawnSync("bash", ["scripts/e2e-gate.sh", "--self-test"], {
      encoding: "utf8",
      cwd: root,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("skipped (fork, no secrets)");
    expect(result.stdout).toContain("event=pull_request, result=skipped");
    expect(result.stdout).toContain("self-test: ok");
  });

  it("e2e-gate passes fork+skipped and fails same-repo+skipped", () => {
    const fork = spawnSync("bash", ["scripts/e2e-gate.sh"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, E2E_RESULT: "skipped", EVENT_NAME: "pull_request", IS_FORK: "true" },
    });
    expect(fork.status, fork.stderr).toBe(0);
    expect(fork.stdout).toContain("skipped (fork, no secrets)");

    const sameRepo = spawnSync("bash", ["scripts/e2e-gate.sh"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, E2E_RESULT: "skipped", EVENT_NAME: "pull_request", IS_FORK: "false" },
    });
    expect(sameRepo.status).toBe(1);
    expect(sameRepo.stdout + sameRepo.stderr).toMatch(/live e2e did not run/);

    const forkFail = spawnSync("bash", ["scripts/e2e-gate.sh"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, E2E_RESULT: "failure", EVENT_NAME: "pull_request", IS_FORK: "true" },
    });
    expect(forkFail.status).toBe(1);
    expect(forkFail.stdout + forkFail.stderr).toMatch(/did not succeed/);
  });
});
