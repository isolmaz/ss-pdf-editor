/**
 * The shape of the pipeline, read from the files that define it. These are the properties a
 * review found missing or broken and that nothing else would notice: a renamed required check
 * silently stops being required, a second build means the deployed bytes were never tested, and a
 * pipe in the deploy's head check turned a failed lookup into a green run.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8');

/** The text of each job of a workflow, by job id (jobs sit two spaces in, under `jobs:`). */
function jobsOf(workflow: string): Map<string, string> {
  const body = workflow.slice(workflow.indexOf('\njobs:\n') + 1);
  const heads = [...body.matchAll(/^ {2}([A-Za-z][\w-]*):[ \t]*$/gm)];
  const jobs = new Map<string, string>();
  for (const [index, head] of heads.entries()) {
    const id = head[1];
    if (id === undefined) continue;
    jobs.set(id, body.slice(head.index ?? 0, heads[index + 1]?.index ?? body.length));
  }
  return jobs;
}

/** The one-line `run:` commands of a job. */
const commandsOf = (job: string): string[] =>
  [...job.matchAll(/^\s*(?:- )?run: (.+)$/gm)].map((match) => (match[1] ?? '').trim());

const ci = read('.github/workflows/ci.yml');
const jobs = jobsOf(ci);
const job = (id: string): string => jobs.get(id) ?? '';

describe('ci.yml', () => {
  it('keeps the names the branch protection requires', () => {
    const names = [...jobs.values()].map((text) => /^\s+name: (.+)$/m.exec(text)?.[1] ?? '');
    expect(names).toEqual(expect.arrayContaining(['verify', 'e2e-service-worker', 'behavior', 'coverage']));
    // the four shards are required one by one, as `e2e (1/4)` to `e2e (4/4)`
    expect(names.filter((name) => /^e2e \(\$\{\{ matrix\.shard \}\}\/4\)$/.test(name))).toHaveLength(1);
    expect(job('e2e')).toMatch(/shard: \[1, 2, 3, 4\]/);
  });

  it('builds the production site once, in verify, and uploads what it assembled', () => {
    const builds = (id: string) =>
      commandsOf(job(id)).filter((command) => /^pnpm (build|assemble:dist)$/.test(command));
    expect(builds('verify')).toEqual(['pnpm build', 'pnpm assemble:dist']);
    for (const id of ['e2e', 'e2e-service-worker', 'behavior', 'deploy']) expect(builds(id), id).toEqual([]);
    expect(job('verify')).toMatch(/upload-artifact@[^\n]*\n\s+with:\n\s+name: dist\n\s+path: dist\/\n/);
  });

  it('serves and deploys the downloaded dist/, never a build of its own', () => {
    for (const id of ['e2e', 'e2e-service-worker', 'behavior', 'deploy']) {
      expect(job(id), id).toMatch(/download-artifact@[^\n]*\n\s+with:\n\s+name: dist\n\s+path: dist\n/);
    }
    expect(job('deploy')).toMatch(/needs: \[verify, e2e, e2e-service-worker, behavior, coverage\]/);
  });

  it("turns a failed lookup of main's head into a failed job", () => {
    const head = /- name: Check this commit is still main's head\n[\s\S]*?(?=\n {6}- |\n {6}#|$)/;
    const step = head.exec(job('deploy'))?.[0];
    expect(step).toBeDefined();
    expect(step).toContain('set -euo pipefail');
    // a pipe after `git ls-remote` would hide its failure behind the status of the last command
    expect(step).not.toMatch(/ls-remote[^\n]*\|/);
    expect(step).toMatch(/if \[ -z "\$head" \]; then[\s\S]*?exit 1/);
  });

  it('runs one pinned wrangler with pnpm dlx, never npx and never as a dependency', () => {
    const pinned = /^ {2}WRANGLER_VERSION: (\S+)$/m.exec(ci)?.[1] ?? '';
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ci).not.toContain('npx');
    // every call names the version through the one variable
    const invocation = /\bwrangler(?:@\S*)? (?:deploy|deployments|rollback)\b/;
    const calls = ci.split('\n').filter((line) => !line.trimStart().startsWith('#') && invocation.test(line));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('pnpm dlx "wrangler@$WRANGLER_VERSION"');
    const manifest = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // wrangler pulls in a library under a licence the project does not accept: not a dependency
    expect(manifest.devDependencies).not.toHaveProperty('wrangler');
    for (const [name, command] of Object.entries(manifest.scripts)) {
      expect(command, name).not.toContain('npx');
    }
    // the scripts run by hand name the version the workflow deploys with
    for (const name of ['worker:deploy', 'worker:deploy:dry']) {
      expect(manifest.scripts[name], name).toContain(`pnpm dlx wrangler@${pinned} deploy`);
    }
  });
});

describe('revert-proof.yml', () => {
  const proof = read('.github/workflows/revert-proof.yml');

  it('starts only when the revert-proof label is added', () => {
    expect(proof).toMatch(/pull_request:\n\s+types: \[labeled\]\n/);
    expect(proof).toContain(
      "if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'revert-proof'",
    );
  });

  it('gives any other label a concurrency group of its own, so it cannot cancel a proof in progress', () => {
    const group = /^ {2}group: (.+)$/m.exec(proof)?.[1] ?? '';
    expect(group).toContain("github.event.label.name != 'revert-proof' && github.run_id");
    expect(proof).toContain('cancel-in-progress: true');
  });
});

describe('dependency versions', () => {
  const manifests = [
    'package.json',
    'tools/behavior/package.json',
    ...['apps', 'packages'].flatMap((group) =>
      readdirSync(`${root}${group}`, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
        .map((entry) => `${group}/${entry.name}/package.json`),
    ),
  ];
  const EXACT = /^(?:\d+\.\d+\.\d+(?:-[\w.]+)?|workspace:\*)$/;

  it('are exact in every manifest, so the lockfile and the manifest name the same version', () => {
    const ranges: string[] = [];
    for (const path of manifests) {
      const manifest = JSON.parse(read(path)) as Record<string, Record<string, string> | undefined>;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(manifest[field] ?? {})) {
          // Peer ranges are ranges by design and not read here.
          if (!EXACT.test(version)) ranges.push(`${path}: ${name}@${version}`);
        }
      }
    }
    expect(ranges).toEqual([]);
  });
});
