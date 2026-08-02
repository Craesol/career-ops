@AGENTS.md

## Fork rule — never push or propose anything upstream

This repository is a fork of `santifer/career-ops`, and the upstream is off
limits. Never open or suggest a pull request against it, never push to a remote
other than `origin` (`Craesol/career-ops`), and never add a remote pointing at
`santifer`.

In particular, never hand out a `github.com/Craesol/career-ops/pull/new/<branch>`
link: on a fork GitHub preselects the **upstream** as the base, so following that
link opens a PR against `santifer`. That already happened once (PR #2263,
2026-07-28) and must not happen again. If a PR is ever needed it belongs inside
the fork, with the base pinned explicitly: `?base=Craesol:main`. When in doubt,
open no PR and ask.

Work ships as a direct push to the designated branch of `origin`.

## Remote sessions: do not scan, do not email

Everything in this project runs on the user's own machine (daily-consolidated.mjs
via Task Scheduler). Remote/cloud sessions — routines, claude.ai/code, CI — must
NOT scan for roles, must NOT write to data/pipeline.md or data/scan-history.tsv,
and must NOT attempt to send email. The remote environment cannot verify posting
liveness or reach any mail provider; every past attempt delivered stale or
undeliverable results. If a scheduled remote session fires, reply only with a
reminder that the routine should be deleted, and do nothing else.
