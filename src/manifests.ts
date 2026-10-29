import * as fs from 'node:fs';
import { parseAllDocuments } from 'yaml';
import { GitHubEventContext } from './types.js';
import { trimTrailingSlashes } from './utils.js';

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

interface TrackedValue {
  display: string;
  comparable: string;
}

interface Workload {
  identity: string;
  fields: Map<string, TrackedValue>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a manifest object.');
  }
  return value as Record<string, unknown>;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(value) || value.length > 253) {
    throw new Error('Invalid or missing Kubernetes name.');
  }
  return value;
}

// Exact rational comparison avoids floating-point noise and ignores unit spelling.
function quantity(value: unknown): TrackedValue {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('CPU and memory requests must be Kubernetes quantities.');
  }
  const display = String(value);
  const match = /^\+?(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+|[numkMGTPE]|[KMGTPE]i)?$/.exec(display);
  if (!match || display.length > 100) {
    throw new Error('Invalid CPU or memory request quantity.');
  }
  const [, amount, suffix = ''] = match;
  const decimalPlaces = amount.includes('.') ? amount.length - amount.indexOf('.') - 1 : 0;
  let numerator = BigInt(amount.replace('.', ''));
  let denominator = 10n ** BigInt(decimalPlaces);
  const decimalExponents: Record<string, number> = {
    n: -9, u: -6, m: -3, '': 0, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18,
  };
  if (suffix.endsWith('i')) {
    numerator *= 2n ** BigInt(('KMGTPE'.indexOf(suffix[0]) + 1) * 10);
  } else {
    const exponent = suffix.length > 1 ? Number(suffix.slice(1)) : decimalExponents[suffix];
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) {
      throw new Error('CPU or memory request exponent is out of range.');
    }
    if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
    else denominator *= 10n ** BigInt(-exponent);
  }
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { display, comparable: `${numerator / a}/${denominator / a}` };
}

function extractWorkload(resource: Record<string, unknown>, namespace: string): Workload {
  if (resource.apiVersion !== 'apps/v1') {
    throw new Error('Deployment and StatefulSet manifests must use apps/v1.');
  }
  const metadata = record(resource.metadata);
  const identity = `${resource.kind} ${name(metadata.namespace ?? namespace)}/${name(metadata.name)}`;
  const spec = record(resource.spec);
  const replicas = spec.replicas ?? 1;
  if (typeof replicas !== 'number' || !Number.isSafeInteger(replicas) || replicas < 0) {
    throw new Error('Workload replicas must be a nonnegative integer.');
  }
  const fields = new Map<string, TrackedValue>([
    ['desired replicas', { display: String(replicas), comparable: String(replicas) }],
  ]);
  const podSpec = record(record(spec.template).spec);
  if (!Array.isArray(podSpec.containers) || podSpec.containers.length === 0) {
    throw new Error('Workloads must contain at least one regular container.');
  }
  const containers = new Set<string>();
  for (const entry of podSpec.containers) {
    const container = record(entry);
    const containerName = name(container.name);
    if (containers.has(containerName)) throw new Error('Duplicate container name in workload.');
    containers.add(containerName);
    const resources = container.resources === undefined ? {} : record(container.resources);
    const requests = resources.requests === undefined ? {} : record(resources.requests);
    for (const resourceName of ['cpu', 'memory']) {
      if (requests[resourceName] !== undefined) {
        fields.set(`container ${containerName} ${resourceName} request`, quantity(requests[resourceName]));
      }
    }
  }
  return { identity, fields };
}

function extractResources(value: unknown, namespace: string, workloads: Map<string, Workload>, depth = 0): void {
  if (depth > 20) throw new Error('Manifest Lists are nested too deeply.');
  // Documents that cannot be workloads (empty, scalar, or without a kind) are
  // ignored so unrelated content never blocks an annotation.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const resource = value as Record<string, unknown>;
  if (['List', 'DeploymentList', 'StatefulSetList'].includes(String(resource.kind))) {
    if (!Array.isArray(resource.items)) throw new Error('Kubernetes List must have an items array.');
    for (const item of resource.items) extractResources(item, namespace, workloads, depth + 1);
    return;
  }
  if (resource.kind !== 'Deployment' && resource.kind !== 'StatefulSet') return;
  const workload = extractWorkload(resource, namespace);
  if (workloads.has(workload.identity)) throw new Error('Duplicate workload identity in manifest.');
  workloads.set(workload.identity, workload);
}

function readWorkloads(file: string, namespace: string): Map<string, Workload> {
  if (fs.statSync(file).size > MAX_MANIFEST_BYTES) {
    throw new Error('Manifest files must be at most 5 MiB.');
  }
  const source = fs.readFileSync(file, 'utf8');
  const workloads = new Map<string, Workload>();
  try {
    for (const document of parseAllDocuments(source, { prettyErrors: false })) {
      if (document.errors.length > 0) throw new Error('Invalid YAML.');
      const value: unknown = document.toJS({ maxAliasCount: 50 });
      extractResources(value, namespace, workloads);
    }
  } catch {
    // Parser diagnostics can contain manifest excerpts, including Secret values.
    throw new Error('Invalid Kubernetes manifest: check YAML syntax, workload identities, replicas, and requests. Source content omitted.');
  }
  return workloads;
}

/** Compares only configured capacity fields; never returns full manifest content. */
export function compareManifestFiles(beforeFile: string, afterFile: string, namespace = 'default'): string[] {
  name(namespace);
  const before = readWorkloads(beforeFile, namespace);
  const after = readWorkloads(afterFile, namespace);
  const changes: string[] = [];
  for (const identity of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(identity);
    const current = after.get(identity);
    if (!previous || !current) {
      const workload = current ?? previous;
      if (!workload) continue;
      const fields = [...workload.fields].sort(([a], [b]) => a.localeCompare(b))
        .map(([field, value]) => `${field}: ${value.display}`).join('; ');
      changes.push(`${identity}: ${current ? 'added to' : 'removed from'} manifests (${fields})`);
      continue;
    }
    const differences: string[] = [];
    for (const field of [...new Set([...previous.fields.keys(), ...current.fields.keys()])].sort()) {
      const oldValue = previous.fields.get(field);
      const newValue = current.fields.get(field);
      if (oldValue?.comparable !== newValue?.comparable) {
        differences.push(`${field}: ${oldValue?.display ?? 'unspecified'} → ${newValue?.display ?? 'unspecified'}`);
      }
    }
    if (differences.length > 0) changes.push(`${identity}: ${differences.join('; ')}`);
  }
  return changes;
}

/** Renders the annotation body for a non-empty list of manifest changes. */
export function renderManifestContent(
  context: GitHubEventContext,
  changes: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const serverUrl = trimTrailingSlashes(env.GITHUB_SERVER_URL || 'https://github.com');
  const workflowUrl = env.GITHUB_RUN_ID
    ? `${serverUrl}/${context.repo}/actions/runs/${env.GITHUB_RUN_ID}`
    : context.url;
  return [
    `[${context.repo}] Kubernetes configuration changes in ${context.environment} (${context.shortSha || context.release})`,
    ...changes,
    'Configured demand only; not measured spend or live capacity.',
    `Workflow: ${workflowUrl}`,
  ].join('\n');
}
