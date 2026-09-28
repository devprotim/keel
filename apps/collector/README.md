# Keel collector

Reports what a running system actually looks like to a Keel room, so the diagram is checked against production and not just against what someone typed. Runs in the cluster, as one small process with no runtime dependencies.

Two sources, each pushed as its own observation set (`POST /api/rooms/:roomId/observations`):

| Source | What it reports | How |
|---|---|---|
| `kubernetes` | Ready replicas per component, plus opt-in flags | Lists Deployments and StatefulSets every push interval |
| `otel` | Who calls whom, requests per second, caller-side p99 latency, and requests per second per serving component | Receives OTLP/HTTP JSON traces and folds them into a service graph |

What Keel does with these: rules run against the observed values where they differ from the drawn ones (a box that says 3 replicas while 1 is ready is a single point of failure), drift and unapproved-change checks compare the three, a call seen in traces but not drawn is flagged, and components with no traffic have their findings demoted. See `packages/shared/src/evidence.ts`.

## Matching to the diagram

Every component on the diagram has a **Runtime name** (`ref`) in the inspector. The collector reports under:

- **Kubernetes:** the `keel.dev/ref` annotation, else the `app.kubernetes.io/name` label, else the workload name. Workloads that share one (a canary and its stable deployment, or one service in two namespaces) are added together.
- **Traces:** the resource's `service.name`. For a call whose far end isn't instrumented (a database, a third-party API), the first of `peer.service`, `db.namespace`, `db.name`, `messaging.destination.name`, or the first label of `server.address`.

Anything reported that matches no component shows up in Keel as an unmatched ref, which is usually a missing runtime name on the diagram.

## Workload annotations

| Annotation | |
|---|---|
| `keel.dev/ref: orders` | Report under this runtime name. |
| `keel.dev/ignore: "true"` | Leave the workload out. |
| `keel.dev/has-replica`, `keel.dev/has-backup`, `keel.dev/has-dlq` | `"true"` or `"false"`. Facts the cluster can't observe, declared next to the workload, where they're more likely to stay true than on a diagram. |

## Deploying

```bash
docker build -f apps/collector/Dockerfile -t <registry>/keel-collector .   # from the repo root
docker push <registry>/keel-collector

kubectl create namespace keel
kubectl -n keel create configmap keel-collector \
  --from-literal=KEEL_URL=https://keel.example.com \
  --from-literal=KEEL_ROOMS=<room id>
# set the image in deploy/kubernetes/collector.yaml, then:
kubectl apply -f apps/collector/deploy/kubernetes/collector.yaml
```

Then point traces at it. With an OpenTelemetry Collector, add the exporter in [`deploy/otel-collector.yaml`](deploy/otel-collector.yaml) to your traces pipeline. SDKs can also export to it directly: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://keel-collector.keel:4318/v1/traces` with `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`.

Run one replica. Two would each see half the traces and push competing sets.

## Configuration

| Variable | Default | |
|---|---|---|
| `KEEL_URL` | required | Keel's base URL. |
| `KEEL_ROOMS` | required | Room ids to report to, comma-separated. |
| `KEEL_CLUSTER` | | Appended to source names (`kubernetes:eu-west`), so two clusters are two sources. |
| `KEEL_PUSH_INTERVAL_SECONDS` | `30` | Also the window rates are averaged over. |
| `KEEL_KUBERNETES` | `true` | |
| `KEEL_KUBERNETES_API_URL` | in-cluster | Set outside a pod, e.g. `http://127.0.0.1:8001` with `kubectl proxy`. |
| `KEEL_KUBERNETES_NAMESPACES` | all | Comma-separated. |
| `KEEL_OTLP` | `true` | |
| `KEEL_OTLP_PORT` | `4318` | |
| `KEEL_OTLP_SAMPLE_RATIO` | `1` | The fraction of traces your pipeline keeps. Rates are scaled up by its inverse. |
| `KEEL_OTLP_PAIR_TIMEOUT_SECONDS` | `10` | How long a call's two halves wait for each other. |
| `KEEL_OTLP_IDLE_RETENTION_SECONDS` | `600` | How long something seen keeps being reported, at 0 rps, after it goes quiet. |
| `KEEL_OTLP_MAX_BODY_BYTES` | `8388608` | Largest accepted export. |

## Trying it locally

```bash
kubectl proxy &   # or skip Kubernetes with KEEL_KUBERNETES=false
KEEL_URL=http://localhost:8787 KEEL_ROOMS=<room id> KEEL_KUBERNETES_API_URL=http://127.0.0.1:8001 \
  pnpm --filter @keel/collector dev
```

## Limits worth knowing

- **JSON only.** OTLP protobuf is refused with a 415 that names the fix (`encoding: json`), so a misconfigured exporter fails loudly instead of silently.
- **Timeouts, retries and circuit breakers are not observed yet.** Traces can't show a configured timeout. A service-mesh source (Istio `VirtualService` timeouts and retries, `DestinationRule` outlier detection) is the natural next one, and would feed the rules that matter most.
- **A failed Kubernetes round is skipped, not pushed empty.** An empty set would tell Keel the whole cluster vanished.
- **The ingest endpoint has no credential** today: the room id is the capability, as it is for the canvas. See `docs/security-audit.md`.
- **Not yet tried on a real cluster.** It is tested against a fake API server with real Kubernetes response shapes, and against traces from the real OpenTelemetry JS SDK.
