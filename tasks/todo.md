# API improvement implementation checklist

Specification and acceptance criteria: [plan.md](plan.md).

- [x] 1. Preserve JSON content across streaming boundaries.
- [x] 2. Preserve schema property names during sanitization.
- [x] 3. Preserve union semantics or reject unsupported conversion explicitly.
- [x] Checkpoint A1: focused tests, typecheck, build, full tests, both smoke suites.
- [x] 4. Enforce named tool choice on the effective wire payload.
- [x] 5. Preserve parallel tool-result call IDs.
- [x] 6. Validate base64 and exact decoded image limits.
- [x] Checkpoint A2: all compatibility fixes verified; full checkpoint passes.
- [x] 7. Detect malformed/truncated upstream streams.
- [x] 8. Add first-response, idle, and total request deadlines.
- [x] 9. Handle response backpressure and bound buffers.
- [x] Checkpoint B: stream failure/cancellation/resource tests and full checkpoint pass.
- [x] 10. Add offline CI and sanitized client compatibility fixtures.
- [x] 11. Extend bounded metrics and run a local load harness.
- [x] 12a. Unify encrypted cache persistence paths.
- [x] 12b. Implement and test recoverable legacy-cache migration.
- [x] 12c. Complete token-manager integration and configuration documentation.
- [x] Final checkpoint: all commands, audit, load report, diff review, and local testing handoff.
- [x] Confirm no push, deployment, production load test, or Render configuration change occurred.
