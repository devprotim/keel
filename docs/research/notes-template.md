# {YYYY-MM-DD} · {role} · {company size and kind, no name}

Copy this file to `notes/YYYY-MM-DD-role-company.md` for each interview. Fill it in within an hour of the call, while it is fresh.

- **Role:** on-call / platform / manager
- **Team:** {services owned, on-call rotation size}
- **Stack:** {Kubernetes? OpenTelemetry? Datadog? cloud?}
- **Recorded:** yes / no (delete the recording once these notes are written)

## Evidence

One line per observation. Start each with the decision tag it bears on, then a theme tag you make up as you go, then what they said or did. Quote exact words in quotation marks; paraphrase without them. Mark what you saw them do with `saw:`, which counts for more than what they said.

The tally script reads lines of exactly this shape: `- [D1] #theme/short-name "quote or paraphrase"`.

- [D1] #theme/dashboards-first "First thing I open is the Grafana overview, then I go to whatever's red"
- [D3] #theme/false-pages "We silenced the disk alert, it fired every Friday"
- [D2] saw: marked the shared-datastore finding as noise without reading it

## The last incident, in order

1. How they found out:
2. First thing they looked at:
3. What they looked at next, and why:
4. How they found what changed:
5. What the cause was, and whether a rule could have caught it:

## Their words

Phrases worth reusing, verbatim, for the landing page **[D10]**.

-

## Surprises

What you did not expect. The most useful section.

-

## Follow-ups

- Promised to send:
- Introductions offered:
- Design partner? yes / maybe / no
