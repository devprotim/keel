/**
 * The landing page's words, as swappable options.
 *
 * Which message leads is a human decision (PROJECT_PLAN task 12: brand voice,
 * final message), to be settled with what design partners say (task 11,
 * decision D10). Until then all three live here, `CHOSEN_PITCH` picks the one
 * visitors see, and `?pitch=<id>` previews any of them on the real page.
 * docs/marketing/landing.md explains each and what would favour it.
 */

export interface Pitch {
  id: string;
  /** What this direction bets on, for whoever is choosing. */
  angle: string;
  headline: string;
  subhead: string;
  steps: readonly { title: string; body: string }[];
}

export interface Feature {
  title: string;
  body: string;
  /** A kind colour token, used as the small identity dot. */
  dot: string;
}

export const PITCHES: readonly Pitch[] = [
  {
    id: 'reality',
    angle: 'Truth: the diagram is checked against what is running, which no drawing tool and no dashboard does on its own.',
    headline: $localize`:Landing page headline:The architecture diagram that checks itself against production`,
    subhead:
      $localize`:Landing page subheading under the headline:Keel reads what is really running from Kubernetes and your traces, and shows where the diagram, the approved design and production disagree, before the difference pages someone.`,
    steps: [
      {
        title: $localize`:Landing page step title:Draw it together`,
        body: $localize`:Landing page step description:Typed components and dependencies with real timeouts and retries, edited live by the whole team.`,
      },
      {
        title: $localize`:Landing page step title:Connect production`,
        body: $localize`:Landing page step description:One collector in the cluster reports instances, traffic, latency and errors onto the diagram.`,
      },
      {
        title: $localize`:Landing page step title:Catch the gap`,
        body: $localize`:Landing page step description:Drift, unapproved changes and risky designs are flagged as they happen, in the app, in CI and in Slack.`,
      },
    ],
  },
  {
    id: 'prevent',
    angle: 'Prevention: find outage-causing flaws while it is still a drawing. Easiest to understand, closest to what exists.',
    headline: $localize`:Landing page headline:Find the outage in the design, before it ships`,
    subhead:
      $localize`:Landing page subheading under the headline:Keel is a shared canvas for system architecture that knows what a timeout is. Draw your services together, and it flags the single points of failure, missing timeouts and retry storms that turn into incidents.`,
    steps: [
      {
        title: $localize`:Landing page step title:Draw it together`,
        body: $localize`:Landing page step description:Components are typed and dependencies carry timeouts, retries and circuit breakers, so the diagram means something.`,
      },
      {
        title: $localize`:Landing page step title:Get told what breaks`,
        body: $localize`:Landing page step description:Thirteen rules run on every edit, with an AI second opinion for the calls a rule cannot make.`,
      },
      {
        title: $localize`:Landing page step title:Keep it true`,
        body: $localize`:Landing page step description:Connect production so a stale number can never hide a real risk.`,
      },
    ],
  },
  {
    id: 'incident',
    angle: 'Incident: lead with the 3am moment. Strongest pull for on-call, but asks for trust before a team has used it.',
    headline: $localize`:Landing page headline:When it breaks, know where to look and what changed`,
    subhead:
      $localize`:Landing page subheading under the headline:Keel turns your architecture diagram into a live map of what is healthy, what is failing and what depends on it, next to everything that changed in production and in the design in the last day.`,
    steps: [
      {
        title: $localize`:Landing page step title:Map it once`,
        body: $localize`:Landing page step description:Draw the system with the team, or start from the running cluster.`,
      },
      {
        title: $localize`:Landing page step title:Watch it live`,
        body: $localize`:Landing page step description:Health, traffic and errors land on every box and every call.`,
      },
      {
        title: $localize`:Landing page step title:Start in the right place`,
        body: $localize`:Landing page step description:What is broken, ranked by what depends on it, beside the change that probably caused it.`,
      },
    ],
  },
];

/** The message visitors see. The human decision; see the comment at the top. */
export const CHOSEN_PITCH = 'reality';

export function pitchFor(id: string | null | undefined): Pitch {
  return PITCHES.find((p) => p.id === id) ?? PITCHES.find((p) => p.id === CHOSEN_PITCH)!;
}

/** What Keel does, the same under every pitch. */
export const FEATURES: readonly Feature[] = [
  {
    title: $localize`:Landing page feature title:Rules that know your runtime`,
    body: $localize`:Landing page feature description:Single points of failure, calls without timeouts, retry storms, missing dead-letter queues. Checked on every edit.`,
    dot: '--keel-kind-service',
  },
  {
    title: $localize`:Landing page feature title:Checked against reality`,
    body: $localize`:Landing page feature description:Observed instances, traffic and latency override what was typed, so a stale diagram cannot hide a real problem.`,
    dot: '--keel-kind-datastore',
  },
  {
    title: $localize`:Landing page feature title:Review changes like a pull request`,
    body: $localize`:Landing page feature description:Every change since the design was approved, field by field, to approve or roll back.`,
    dot: '--keel-kind-gateway',
  },
  {
    title: $localize`:Landing page feature title:Incident mode`,
    body: $localize`:Landing page feature description:Live health on the map, what to look at first, and a timeline of what changed.`,
    dot: '--keel-kind-queue',
  },
  {
    title: $localize`:Landing page feature title:A check on every pull request`,
    body: $localize`:Landing page feature description:A GitHub Action validates committed diagrams and comments with only the findings a change introduced.`,
    dot: '--keel-kind-cache',
  },
  {
    title: $localize`:Landing page feature title:Alerts that stay quiet`,
    body: $localize`:Landing page feature description:Slack or PagerDuty when production drifts, deduplicated, and never for a finding your team marked as noise.`,
    dot: '--keel-kind-job',
  },
];
