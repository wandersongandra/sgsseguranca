# Worker health contract — September 2026

`/health/live` reports process liveness independently of dependencies.
`/health/ready`, `/health` and `/health/public` return 200 only after application
initialization and successful readiness checks; otherwise they return 503.
Responses do not expose connection strings, hosts, queue contents or diagnostics.

Readiness requires:

- fresh successful heartbeat reporting by this process, with reporting enabled;
- queue and cache Redis connections ready and answering PING;
- an initialized PostgreSQL connection answering `SELECT 1`;
- registered BullMQ consumers running and not paused;
- each consumer's command and blocking connections ready, and its queue not
  globally paused (read-only query of BullMQ's pause flag).

Dependency probes have a two-second response deadline. A timed-out operation
remains the single in-flight probe until it settles, preventing accumulation of
Redis commands during outages. Probes never enqueue or execute a test job.
Shutdown clears readiness before dependencies are closed.

Both Docker worker images use `scripts/healthcheck-worker.js`, which checks
`127.0.0.1:$PORT/health/ready`. A shared Redis heartbeat from another process cannot
make this container healthy. External process monitors should use `/health/live`;
deployment readiness checks should use `/health/ready`. Existing health aliases
now deliberately fail closed during dependency failures.

Runtime verification remains required on the isolated test VPS, including Redis
outage, stopped consumer, heartbeat expiry and recovery. Local tests do not prove
the deployed worker is running this code.
