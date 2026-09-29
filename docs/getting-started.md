# Getting started with Keel

Keel is a shared canvas for system architecture that checks the design against the flaws that cause outages, and against what is actually running. This guide goes from an empty room to a diagram that watches production, in about the order the in-app checklist walks through.

## 1. Draw the system

Open Keel and choose **Start a new diagram**. The room's link is the invite: anyone you send it to edits with you, live.

- **Add components** by dragging a tile from the rail on the left (service, datastore, queue, cache, gateway, job, external), or click a tile and then the canvas.
- **Connect them** by holding Alt (Option on a Mac) and dragging from one component to another. The rail's S, A and S tiles pick whether the next connection is synchronous, asynchronous or a stream.
- **Say how they behave.** Select anything to open the inspector. For a component: how many instances run, whether a datastore has replicas and backups, whether a queue has a dead-letter queue. For a dependency: its timeout, retries, circuit breaker and whether the consumer is idempotent. These are what the checks read.

Not sure where to start? **See it on an example** from the landing page opens a worked example with live data already flowing in.

## 2. Read the findings

The review dock at the bottom left counts what Keel found. Open it for the list. Thirteen rules run on every edit (single points of failure, calls without timeouts, retry storms, shared databases and more), and **Run AI review** asks a model for the judgement calls a rule cannot make. Click a finding to see it on the canvas.

If a finding is wrong for your system, mark it **Noise**: it moves to a dismissed list for everyone in the room and never alerts. **Real** marks it confirmed. The **Rules** tab shows how often each rule fires and how people have judged it, and lets the room lower, raise or mute a rule.

## 3. Approve the design

In the review dock, **Approve design** records the diagram as the approved baseline. From then on:

- Every change shows up under **Changes**, field by field, to approve or reject. Rejecting puts the approved value back, removes something added, or restores something deleted.
- Production that disagrees with the approved design is flagged as an accident, not just a difference.

## 4. Connect live data

Keel checks the diagram against what is really running. Each component's **Runtime name** (in the inspector) is how production data finds it: the Kubernetes workload or the tracing `service.name`.

**In a cluster**, run the collector: it reports ready instances from Kubernetes and calls, traffic, latency and errors from OpenTelemetry traces. See [apps/collector/README.md](../apps/collector/README.md).

**By hand or from a script**, post an observation set:

```bash
curl -X POST https://<your keel>/api/rooms/<room id>/observations \
  -H 'content-type: application/json' \
  -d '{"source":"manual","observedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","nodes":[{"ref":"checkout","replicas":1}]}'
```

The checklist in the app gives you this command filled in for your room. Observed values override the drawn ones when the rules run, so a stale number cannot hide a real risk. A name production reports that no box carries appears under **Live data** with a one-click suggestion: link it to the box that means it, or add it to the diagram.

## 5. Use it when things break

**Incident** in the bottom toolbar turns the canvas into a live health map: every box and call shows whether it is healthy, degraded or down, edges thicken with traffic, and calls production makes that nobody drew appear dashed. The panel ranks what to look at first, by what depends on it, and lists what changed in the last day, in production and in the approved design.

## 6. Bring in the team

- **Share** makes a diagram private to a workspace, with owner, editor and viewer roles and invite links. Private rooms take live data only from a collector token, issued in the same menu.
- **Alerts** sends Slack or PagerDuty notifications when production drifts from the diagram.
- **The GitHub Action** checks diagrams committed to a repository on every pull request, and comments with only the findings the change introduced. See [packages/action/README.md](../packages/action/README.md). Export a diagram as JSON from the **Export** menu to commit it.
