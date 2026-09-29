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
    headline: 'The architecture diagram that checks itself against production',
    subhead:
      'Keel reads what is really running from Kubernetes and your traces, and shows where the diagram, the approved design and production disagree, before the difference pages someone.',
    steps: [
      { title: 'Draw it together', body: 'Typed components and dependencies with real timeouts and retries, edited live by the whole team.' },
      { title: 'Connect production', body: 'One collector in the cluster reports instances, traffic, latency and errors onto the diagram.' },
      { title: 'Catch the gap', body: 'Drift, unapproved changes and risky designs are flagged as they happen, in the app, in CI and in Slack.' },
    ],
  },
  {
    id: 'prevent',
    angle: 'Prevention: find outage-causing flaws while it is still a drawing. Easiest to understand, closest to what exists.',
    headline: 'Find the outage in the design, before it ships',
    subhead:
      'Keel is a shared canvas for system architecture that knows what a timeout is. Draw your services together, and it flags the single points of failure, missing timeouts and retry storms that turn into incidents.',
    steps: [
      { title: 'Draw it together', body: 'Components are typed and dependencies carry timeouts, retries and circuit breakers, so the diagram means something.' },
      { title: 'Get told what breaks', body: 'Thirteen rules run on every edit, with an AI second opinion for the calls a rule cannot make.' },
      { title: 'Keep it true', body: 'Connect production so a stale number can never hide a real risk.' },
    ],
  },
  {
    id: 'incident',
    angle: 'Incident: lead with the 3am moment. Strongest pull for on-call, but asks for trust before a team has used it.',
    headline: 'When it breaks, know where to look and what changed',
    subhead:
      'Keel turns your architecture diagram into a live map of what is healthy, what is failing and what depends on it, next to everything that changed in production and in the design in the last day.',
    steps: [
      { title: 'Map it once', body: 'Draw the system with the team, or start from the running cluster.' },
      { title: 'Watch it live', body: 'Health, traffic and errors land on every box and every call.' },
      { title: 'Start in the right place', body: 'What is broken, ranked by what depends on it, beside the change that probably caused it.' },
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
    title: 'Rules that know your runtime',
    body: 'Single points of failure, calls without timeouts, retry storms, missing dead-letter queues. Checked on every edit.',
    dot: '--keel-kind-service',
  },
  {
    title: 'Checked against reality',
    body: 'Observed instances, traffic and latency override what was typed, so a stale diagram cannot hide a real problem.',
    dot: '--keel-kind-datastore',
  },
  {
    title: 'Review changes like a pull request',
    body: 'Every change since the design was approved, field by field, to approve or roll back.',
    dot: '--keel-kind-gateway',
  },
  {
    title: 'Incident mode',
    body: 'Live health on the map, what to look at first, and a timeline of what changed.',
    dot: '--keel-kind-queue',
  },
  {
    title: 'A check on every pull request',
    body: 'A GitHub Action validates committed diagrams and comments with only the findings a change introduced.',
    dot: '--keel-kind-cache',
  },
  {
    title: 'Alerts that stay quiet',
    body: 'Slack or PagerDuty when production drifts, deduplicated, and never for a finding your team marked as noise.',
    dot: '--keel-kind-job',
  },
];
