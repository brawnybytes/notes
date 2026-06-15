# System Design Interview Prompt Template

Use this prompt for any system design problem. Replace `[SYSTEM]` with your target system.

---

## The Prompt

```
I need to prepare for a system design interview on [SYSTEM].

Teach me the complete design basics to advanced, covering:

1. Requirements — functional, non-functional, what to scope out
2. Capacity estimation — storage, bandwidth, QPS with real numbers
3. High-level architecture — all major subsystems, how they connect, include a diagram
4. Core flows — go deep on each one: what happens step by step, why each component exists, what happens if you don't use it
5. Database choices — which DB for which data and exactly why (not just "use Cassandra" — explain the reasoning, the trade-offs, the data model)
6. Scaling bottlenecks — the hard problems specific to this system and how to solve them
7. Failure scenarios — what breaks, how you detect it, how you recover
8. Extended scope — cover anything typically scoped out but relevant for senior interviews (e.g. auth flows, payments, notifications, live features)
9. Security — not just basics. Cover transport, auth/authz, data protection, infrastructure, abuse prevention, application-level vulnerabilities
10. FAANG-level depth — data modeling, idempotency, distributed transactions, rate limiting, hot shard problems, geo-replication, cost optimization
11. Observability — metrics, logs, traces, alerting, SLOs
12. Deployment and reliability — canary, feature flags, circuit breaker, chaos engineering

For every topic answer: WHAT it is, WHY you need it, HOW it works.

Use real numbers. Use real technology names. Explain trade-offs, not just solutions.

At the end, give me:
- A key talking points cheatsheet — exact sentences to say in an interview
- Interview time split — what to cover in which minute of a 45-min interview
- A high-level architecture diagram

I have a full day to study so go as deep as possible. Plain language, no unnecessary formatting.
```

---

## How to use this

Paste the prompt above into a new chat, replacing `[SYSTEM]` with your target.

**Examples:**
- Design Twitter / X
- Design Netflix
- Design Uber
- Design WhatsApp
- Design Google Drive
- Design a URL shortener
- Design a rate limiter
- Design an e-commerce platform like Amazon
- Design a ride-sharing system
- Design a notification system
- Design a distributed job scheduler

---

## Follow-up prompts to go deeper

Once the base design is done, use these to push further:

**For any weak area:**
```
Go deeper on [topic] — what, why, how, with real numbers and trade-offs
```

**For FAANG-level depth:**
```
What additional depth would a FAANG interviewer expect beyond what we covered?
Cover each gap in full detail.
```

**For security specifically:**
```
Cover security end to end — transport, authentication, authorization,
data protection, infrastructure, application vulnerabilities, abuse prevention,
and incident response. Go deep on each.
```

**For a specific sub-problem:**
```
The interviewer asked me to design just the [notification system / 
rate limiter / search / recommendation engine] part. 
Go deep on that as a standalone design.
```

**To check if you're ready:**
```
Is what we covered enough for a senior engineer interview at [company]?
What's missing? Be honest.
```

**To generate the study reference:**
```
Generate a complete markdown file of everything we discussed
that I can refer to anytime for interviews. Include a high-level
architecture diagram in ASCII.
```

---

## What makes this prompt work

- **"What, why, how"** — forces the answer to explain reasoning, not just list components
- **"Real numbers"** — forces capacity estimation with actual figures, not vague statements
- **"Full day to study"** — signals you want depth, not a summary
- **"Plain language"** — avoids bullet-point walls that are hard to read
- **Extended scope** — explicitly asks for the things most prompts scope out (DRM, monetization, live streaming etc.)
- **Cheatsheet at the end** — gives you the exact interview sentences, not just knowledge
- **Time split** — tells you how to pace a real 45-minute interview

