# Simple Web Release Design

## Goal

Publish Gateway Web changes through one short routine: review the changed code,
run affected unit tests, build Web output when required, deploy, and confirm
service health.

## Routine

Use `pnpm web:release run --source CHECKOUT`. The release selector limits tests
and build work to changed frontend or platform behavior. Frontend output changes
build the Web bundle. Platform and runtime changes run platform unit tests and
publish the changed platform source. A unit-test or build failure prevents
publication. After restart, `/health` must respond for publication to succeed.

Routine Web publication has no lint, type-check, Rust, Docker, gVisor, image
provenance, commit matching, browser, or live model-call gates. Native desktop
and scientific-image release work remains separate from Gateway Web publishing.

The release retains the existing resource limits, deployment lock, and recovery
of the prior service configuration after a failed restart or health check. User
workspaces, credentials, and conversations remain untouched.

## Acceptance

- A frontend change runs its affected unit tests, builds Web output, then deploys.
- A platform or runtime change runs affected platform unit tests, then deploys.
- A failed selected test or build prevents deployment.
- A healthy restart completes publication; failed health restores the prior
  service configuration where possible.
- Release-tool tests pass independently and do not become a routine release gate.
