# Recruiting design partners

## Who

Three roles, because each owns a different part of the problem. Aim for five of each.

| Role | Why | Must have |
|---|---|---|
| **On-call engineer / SRE** | Uses incident mode and alerts at the worst moment. Settles D1, D2, D3, D5. | Carried a pager in the last 6 months for a system with 5+ services |
| **Platform engineer / architect** | Draws and reviews the diagrams, owns CI. Settles D2, D4, D6, D7. | Reviewed or approved an architecture change in the last quarter |
| **Engineering manager / head of platform** | Signs the cheque and owns the process. Settles D6, D9, D10. | Owns a budget line for developer or reliability tooling |

Avoid: people who only draw diagrams for documentation and never run what they draw; companies with one service; friends who will be kind.

## Where to find them

- Former colleagues, one hop removed (the person they would call during an outage).
- Postmortem authors: public postmortems name teams that have had the exact failures Keel's rules catch.
- SRE and platform communities (Rands Leadership Slack, the CNCF Slack's #sre and #platform channels, local SRE meetups). Read the room's rules on outreach first.
- People who star or open issues on the Keel repository or the Action.

## Outreach message

Short, specific, and honest that you are learning, not selling.

> Hi {name}, I'm building a tool that checks system architecture diagrams against what's actually running, and flags the design flaws that cause outages (missing timeouts, retry storms, single points of failure). I saw {specific thing: your postmortem on X, your talk on Y}.
>
> I'm not selling anything yet. I'd like 45 minutes to hear how your team handles this today, especially the last incident where the diagram and reality disagreed. Happy to share what I learn from the other teams I talk to.
>
> Would {two concrete times} work?

Follow up once, a week later. Do not follow up twice.

## Screening questions

Ask before booking, by message or a two-minute call. Book only if the answers fit the role.

1. What's your role, and roughly how many services does your team run in production?
2. When did you last get paged, and what for? *(On-call: must be within 6 months.)*
3. Does your team keep architecture diagrams? Where, and when were they last updated?
4. How does a design change get reviewed before it ships? *(Platform: must describe a real process.)*
5. Who decides which developer tools your team pays for? *(Manager: must be them or one step away.)*

## Consent, at the start of every call

> Thanks for doing this. I'll take notes, and with your OK I'll record so I don't have to write everything down. The recording stays with me and gets deleted once I've written up notes. I won't quote you by name or company anywhere without asking first. Is that all right?

If they say no to recording, take notes only. Never record without an explicit yes.
