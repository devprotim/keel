# Interview guide

45 minutes. The first half is about what they do today, before they have seen Keel, because once they have seen it every answer bends toward it. Only the second half shows the product.

Tags in brackets (**[D1]**) say which open decision a question informs; see the [README](README.md). Skip questions freely. Stay longer where the stories are.

## Rules for the interviewer

- Ask about the last time, not usually. "Tell me about the last time" gets a story; "how do you usually" gets an opinion.
- Don't pitch, don't defend, don't explain the product until part 3. If they misunderstand something in the demo, that is data.
- After an answer, count to three before the next question. The second half of an answer is usually the useful half.
- "Why?" once, then "what happened next?". Never "would you use a tool that...": everyone says yes.
- Write down their words, not your summary. Exact phrases feed the landing page **[D10]**.

## 1. Warm-up (5 min)

1. What does your team own, and how many services is that?
2. What does a normal week look like for you?

## 2. How it works today (20 min)

### Everyone

3. **The last incident.** Tell me about the last incident you were involved in. Start from how you found out. **[D1, D3]**
   - What did you look at first? Then what? *(Get the order. This is D1.)*
   - How did you work out what depended on the broken thing?
   - What had changed shortly before? How did you find out? **[D1]**
   - Was the cause something a review could have caught? A missing timeout, a single instance, a retry loop? **[D2]**
4. **Diagrams.** Show me (or describe) your team's architecture diagram. **[D5, D7]**
   - When was it last right? How do you know?
   - Who changes it, and when? Does anyone review the change?
   - What's running in production that isn't on it?

### On-call / SRE

5. What pages you today? What pages you that shouldn't? **[D3]**
   - Last false page: what was it, and what did you do about the alert afterwards?
   - Is there anything you've silenced because it was too noisy? What would make you turn it back on? **[D2]**
6. Where does your telemetry live: Kubernetes, OpenTelemetry, Datadog, a cloud provider's console, something else? What could a tool read from without a security review? **[D5]**
7. During an incident, what's the first screen you open? Why that one? **[D1]**

### Platform / architect

8. Walk me through the last design review you did. What were you checking for? **[D7]**
   - What did you miss that bit you later?
9. Do you check anything about architecture in CI today? Would a failing check there get fixed, or get overridden? **[D4]**
   - Who is allowed to override a failing check?
10. When someone makes a change that nobody approved, how do you find out? **[D6, D7]**

### Manager / buyer

11. What do you pay for today in reliability or developer tooling? Roughly what does it cost, and who approved it? **[D9]**
12. How do you decide who can see or edit your architecture docs? Would a contractor get access? **[D6]**
13. What would have to be true for a new tool to get through procurement at your company? Security review, SSO, data residency? **[D9]**

## 3. The product (15 min)

Share your screen, open a room with the example loaded, and hand them control if you can. Say only: "This is early. Think out loud. Nothing you say will hurt my feelings."

14. **First look.** Before clicking anything: what do you think this is for? What would you do first? **[D8, D10]**
15. **Findings.** Open the review dock. Pick a finding. Is it right? Would your team fix it? Is anything here noise? Have them mark one real and one noise. **[D2]**
16. **Review mode.** Approve the design, change a timeout and delete a box, then open Changes. **[D7]**
   - What do you think happened here? Would you trust this enough to approve from it? What's missing?
17. **Incident mode.** Push the demo observations (the incident e2e test's payloads work), then turn on Incident. **[D1]**
   - Where do you look first? Is that where you'd look in a real incident? Is the order in "Look here first" right?
   - Anything here you'd want at 3am that isn't? Anything you'd want gone?
18. **CI.** Show the PR comment from the Action. Should this block a merge? For which findings? **[D4]**
19. **Sharing.** Show the Share menu. Who at your company should be able to make a diagram private? **[D6]**

## 4. Value and price (5 min)

Ask these last, after they've seen it, and only as questions about their world. **[D9]**

20. If this worked the way you'd want, what would it replace, or what would you stop doing?
21. Who else would need to use it for it to be worth it? How many people is that?
22. What would you compare its price to? *(Don't name a number first.)*
23. At what price would it be so cheap you'd doubt it? At what price too expensive to consider? *(Van Westendorp, only two of its four questions; enough at this stage.)*

## Close (2 min)

24. What should I have asked that I didn't?
25. Who else should I talk to? Would you introduce me?
26. Can I show you what we build from this in a month? *(A yes is a design partner.)*

Thank them, and send what you promised within two days.
