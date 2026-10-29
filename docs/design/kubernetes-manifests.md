# Kubernetes manifest annotations

## Scope and decisions

Annotato compares two explicit manifest files supplied by a GitHub workflow. The
baseline must represent the last successfully deployed configuration, not merely
the previous Git commit. Both rendered Helm YAML and Kubernetes YAML/JSON are
accepted, including multi-document streams and Kubernetes Lists.

The first version tracks apps/v1 Deployments and StatefulSets: desired replicas
and CPU/memory requests for each regular container. Workloads are matched by kind,
namespace, and name; containers by name. Equivalent quantity spellings are treated
as unchanged. Added and removed workloads are reported explicitly. Missing
replicas use Kubernetes' default of one; missing requests remain unspecified.

One annotation summarizes the changed workloads per invocation, retaining the
existing singular action outputs. Unchanged manifests skip all API calls. Other
operations and custom content/templates cannot be combined with manifest inputs.

The workflow owns deployment and rollout verification. It invokes Annotato only
after success and uses fail-on-error: false for nonblocking reporting. The default
annotation time is the comparison step's time, not the Git commit timestamp.
Existing reports, labels, filters, dry-run behavior and error handling are reused.

Only workload identity, tracked values, repository, environment and workflow link
are included in annotations. Full manifests, images, environment variables,
Secrets and ConfigMaps are excluded. Parse diagnostics omit source excerpts.
Inputs are limited to 5 MiB each and YAML alias expansion is bounded. The module
does not invoke shell commands, contact Kubernetes, or need Kubernetes credentials.

## Alternatives and limits

Live cluster snapshots can capture admission defaults and runtime changes, but
require cluster reads and complicate attribution. Helm-values comparisons are
chart-specific. Manifest comparisons provide a small common starting point.

These events describe configured demand, not measured spend, effective Pod
requests, or live replicas. HPA policies, init containers, Pod-level resources,
limits, autoscaler activity, nodes, and changes outside workflows are out of scope.
Changing namespaces is reported as removal plus addition. The workflow must supply
complete, equally scoped manifests and serialize deployments to avoid mixed baselines.

## Implementation plan

1. Add a YAML parser and a validated extraction/comparison module.
2. Add paired manifest-before/manifest-after inputs and manifest-namespace fallback.
3. Generate annotation content before existing dry-run/create handling; skip no-ops.
4. Add regression tests for comparisons, validation, API payloads and the bundle.
5. Document Helm and kubectl workflow recipes, baseline ownership and limitations.
6. Typecheck, rebuild the action bundle, run the complete tests and dependency audit.
