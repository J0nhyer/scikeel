# Simple Web Release Implementation Plan

1. Add release-policy and publication tests that specify affected unit tests,
   conditional Web build, health check, and restoration after failed health.
2. Simplify policy selection and preparation so routine publication does not
   run lint, type checks, Rust/image checks, browser workflows, or live model
   calls.
3. Remove image compatibility and source-commit checks from the routine Web
   publication path while preserving the currently configured image value.
4. Keep deployment recovery and resource limits; use service health as the
   post-restart publication check.
5. Update `AGENTS.md` and `scripts/README.md`, run focused release tests, review
   the implementation, then run the requested publication and health check.
