# LinkedIn post — Carbide launch (v1.7.0, 2026-07-15)

Final version as posted. Repo-only (docs/ is export-ignored, never ships).
Splunkbase: https://splunkbase.splunk.com/app/9082

---

The app we used for monitoring data sources in Splunk went premium this year.

Nothing against the developers, they should get paid for their work. But I couldn't get over the idea of paying extra for something that in my head is basic functionality.

If you run Splunk, you need to know when a data source stops sending. That's the ground floor. Every dashboard and every detection is worthless if the data stopped arriving two weeks ago and nobody noticed.

I've had that exact investigation. Empty search results, and the answer was "the forwarder's been dead since March".

So the last few weeks I've been building a replacement in the evenings, mostly with Claude Code. Write down what I want, argue with what comes back, test it on our environment next morning.

I expected a prototype. I ended up with a real app:

- discovers what's reporting into your indexes
- gap and latency thresholds per entity, volume baselines
- business-hours and holiday schedules, so Monday morning isn't an incident
- cluster support, so one dead node in a redundant pool doesn't page anyone unless quorum is lost

Some of it exists because of our own outages. Last week a source with 30+ hours of ingest lag showed up as dead when it wasn't. Root cause found in the morning, fix shipped the same evening. Good luck getting that turnaround from a vendor.

The app is called Carbide. It's on Splunkbase, free, GPL:
https://splunkbase.splunk.com/app/9082

If this is a problem you know, try it and tell me what's broken.
