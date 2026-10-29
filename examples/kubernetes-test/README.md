# Try Kubernetes capacity annotations

Run these commands from the repository root with Node.js, kubectl and Helm
installed. Use your intended test-cluster context (`kubectl config current-context`).
The examples use the namespace `annotato-test`, two separate Deployment names, and
ClusterIP Services. They do not create public load balancers or persistent disks.
The image is `nginx:alpine`; mirror or replace it if your cluster requires a
different registry or security policy.

Both deployment options make the same changes:

| Field | Baseline | Scaled |
| --- | --- | --- |
| Desired replicas | 1 | 2 |
| CPU request per pod | 25m | 50m |
| Memory request per pod | 32Mi | 64Mi |
| CPU/memory limit per pod | 100m / 128Mi | 100m / 128Mi |

These idle HTTP servers test annotation behavior. Resource requests reserve
capacity; this is not a load generator or a guarantee of a visible spend change.

## Plain Kubernetes manifests

Install the baseline, then apply the increased-capacity manifest:

```bash
kubectl apply -f examples/kubernetes-test/manifests/namespace.yaml
kubectl apply -f examples/kubernetes-test/manifests/baseline.yaml
kubectl rollout status deployment/annotato-plain -n annotato-test --timeout=180s

kubectl apply -f examples/kubernetes-test/manifests/scaled.yaml
kubectl rollout status deployment/annotato-plain -n annotato-test --timeout=180s
```

After a successful rollout, preview the annotation locally:

```bash
ANNOTATO_TEST_DIR="$(mktemp -d)"
INPUT_MANIFEST_BEFORE=examples/kubernetes-test/manifests/baseline.yaml \
INPUT_MANIFEST_AFTER=examples/kubernetes-test/manifests/scaled.yaml \
INPUT_DRY_RUN=true \
ENVIRONMENT=annotato-test \
GITHUB_STEP_SUMMARY="$ANNOTATO_TEST_DIR/summary.md" \
node dist/index.js

cat "$ANNOTATO_TEST_DIR/summary.md"
```

The summary should include all three changes for
`Deployment annotato-test/annotato-plain`. The Service should produce no changes.
No DoiT credentials are needed for this preview.

To inspect the app, run `kubectl port-forward -n annotato-test
service/annotato-plain 8080:80`, then open `http://localhost:8080`.

## Helm chart

This chart uses the release name for its Deployment and Service. The separate
release name below allows it to coexist with the plain-manifest example.

```bash
ANNOTATO_HELM_DIR="$(mktemp -d)"
helm install annotato-helm examples/kubernetes-test/chart \
  --namespace annotato-test --create-namespace --wait --timeout 180s
helm get manifest annotato-helm -n annotato-test > "$ANNOTATO_HELM_DIR/before.yaml"

helm upgrade annotato-helm examples/kubernetes-test/chart \
  --namespace annotato-test \
  --values examples/kubernetes-test/chart/values-scaled.yaml \
  --wait --timeout 180s
kubectl rollout status deployment/annotato-helm -n annotato-test --timeout=180s
helm get manifest annotato-helm -n annotato-test > "$ANNOTATO_HELM_DIR/after.yaml"

INPUT_MANIFEST_BEFORE="$ANNOTATO_HELM_DIR/before.yaml" \
INPUT_MANIFEST_AFTER="$ANNOTATO_HELM_DIR/after.yaml" \
INPUT_DRY_RUN=true \
ENVIRONMENT=annotato-test \
GITHUB_STEP_SUMMARY="$ANNOTATO_HELM_DIR/summary.md" \
node dist/index.js

cat "$ANNOTATO_HELM_DIR/summary.md"
```

You should see the same three changes for `Deployment annotato-test/annotato-helm`.
If a rollout fails or times out, inspect the pods before running Annotato; these
commands are intended to be run one successful step at a time.

To test without a cluster, replace installation/upgrading with rendering:

```bash
helm template annotato-helm examples/kubernetes-test/chart \
  --namespace annotato-test > "$ANNOTATO_HELM_DIR/before.yaml"
helm template annotato-helm examples/kubernetes-test/chart \
  --namespace annotato-test \
  --values examples/kubernetes-test/chart/values-scaled.yaml \
  > "$ANNOTATO_HELM_DIR/after.yaml"
```

Then run the same dry-run command above. Initialize `ANNOTATO_HELM_DIR` with
`mktemp -d` first if using a fresh shell.

## GitHub Actions and live DoiT annotations

In your test workflow, check out this feature branch and run the deployment and
rollout steps above. Then use the checked-out action:

```yaml
- name: Annotate test capacity changes
  uses: ./
  env:
    ENVIRONMENT: annotato-test
  with:
    doit-api-key: ${{ secrets.DOIT_API_KEY }}
    manifest-before: examples/kubernetes-test/manifests/baseline.yaml
    manifest-after: examples/kubernetes-test/manifests/scaled.yaml
    reports: ${{ vars.DOIT_REPORT_IDS }}
    dry-run: 'true'
    fail-on-error: 'false'
```

For Helm, save the before/after files under `$RUNNER_TEMP` and use
`${{ runner.temp }}/before.yaml` and `${{ runner.temp }}/after.yaml` as the inputs.
Change `dry-run` to `'false'` to create a real annotation using your DoiT token.
Only run the action after successful rollout checks; do not use `if: always()`.
GitHub supplies the repository, commit and workflow link automatically.

For a local live annotation, export `DOIT_API_KEY` in your shell and rerun the
local preview command with `INPUT_DRY_RUN=false`. Optionally set `INPUT_REPORTS`
to your comma-separated report IDs.

## Repeat, reverse and clean up

- **No change:** pass the scaled file as both inputs. Expect
  `annotation-skipped: true` and no DoiT request.
- **Decrease:** reapply `baseline.yaml`, verify rollout, and compare scaled →
  baseline. With Helm, upgrade using the chart's `values.yaml` and capture the
  new manifest after success.
- **Remove test workloads:**

```bash
helm uninstall annotato-helm --namespace annotato-test
kubectl delete -f examples/kubernetes-test/manifests/scaled.yaml --ignore-not-found
```

Run only the cleanup commands for the option(s) you installed. The namespace is
left in place so other resources in it are preserved.
