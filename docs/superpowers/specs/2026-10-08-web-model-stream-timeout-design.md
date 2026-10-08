# Web Model Stream Timeout Design

Date: 2026-10-08
Status: Draft for user review. Only specification work is authorized; implementation and publication are separate steps.
Scope: Public multi-user gateway Web using managed OpenCode, including phone-width viewports.

## 1. Problem and intended outcome

A research conversation can keep receiving model output but fail when a local proxy's fixed request deadline expires. The resulting socket reset hides the actual timeout phase and encourages retries that encounter the same deadline.

A healthy model stream must be allowed to continue beyond two minutes. A stalled request must still terminate, release its resources, and explain the known cause. Completed tool calls and workspace changes must survive a failed model continuation without automatic replay.

This design changes model-request deadlines and their error propagation. It preserves tenant isolation, fixed provider routing, credential handling, individual size/token limits, and concurrency protections. It adds no account quota, provider exception, general retry framework, or settings screen. Desktop UX, standalone CLI runtime timeout changes, and unrelated snapshot warnings are outside scope.

## 2. Evidence and limits of the diagnosis

Inspection on October 8, 2026 identified the effective production source as:

`.deploy/web-releases/2026-10-08T09-52-25-045Z-9c181780/source`

The latest affected session is `ses_ee482daeaffeB7747PpeER5pYE`, titled “模拟剂量—反应数据分析并生成报告”. All incident times below are China Standard Time (UTC+08:00); runtime log timestamps are UTC.

| Observation | Evidence | Conclusion |
| --- | --- | --- |
| The submitted turn reached the runtime | Platform logs record `sessionPrompt_async` returning 204 at approximately 20:29, followed by successful message reads | Submission succeeded; this is distinct from a browser request failing to reach the server |
| Earlier model steps worked | Persisted messages contain successful `opencode / big-pickle` tool-call steps | The provider was usable earlier in this turn |
| The failing continuation was attempted six times | Runtime logs show stream starts at 20:36:04, 20:38:07, 20:40:11, 20:42:20, 20:44:37, and 20:47:08 | One initial attempt and five retries preceded the terminal failure |
| The final attempt lasted 120.020 seconds | Runtime selection at 20:47:08.489; terminal socket error at 20:49:08.509 | Timing closely matches a local two-minute deadline |
| The broker imposes that deadline | `model-broker.mjs:45` defaults `timeoutMs` to 120000; line 135 starts one absolute timer; line 240 passes its signal to the response pipeline | A healthy stream is subject to the same absolute deadline as a stalled request |
| Production uses the default | `sandbox-control-plane.mjs:93` constructs `ModelBroker` without a timeout override | No effective longer timeout was found in this construction path |
| Streaming errors can become resets | The pipeline includes the downstream HTTP response; `sendFailure` destroys a response whose headers are already sent | A local timeout can surface as `ECONNRESET` rather than a useful model error |
| The runtime stayed running | Generation remained 167, service restart count was zero, and no matching kernel OOM event was found | The evidence does not indicate a container restart during these attempts |

The saved assistant error is `APIError`, message `Connection reset by server`, metadata code `ECONNRESET`, marked retryable. The incomplete message includes reasoning content but no completed final answer.

This is strong evidence for the broker deadline, not a completed isolated reproduction of the historical failure. Production did not record a structured broker timeout reason. A temporary reproduction against the deployed class was prepared at `/tmp/scikeel-model-timeout-diagnosis-20261008.test.mjs`, but the guarded package command exited because the active runtime held the shared resource lock; the test did not run. Implementation must first reproduce the current behavior with a local upstream fixture.

The main checkout lacks deployed sandbox modules, including `services/platform/src/model-broker.mjs`. Implementation must identify a complete source baseline matching the running release, reconcile relevant pending changes, and verify the installed OpenCode binary and adapter versions. Do not patch a frozen release in place or reconstruct the missing module from assumptions.

## 3. Alternatives and decision

| Approach | Benefit | Drawback | Decision |
| --- | --- | --- | --- |
| Increase the existing absolute timeout to one hour | Small patch; allows longer generations | A silent or dead upstream can occupy a slot for the entire period | Reject as the complete solution |
| Use only a renewable inactivity timeout | Healthy streams can run for as long as needed | Heartbeats or very slow data can hold a connection indefinitely | Reject |
| Separate initial wait, inactivity, and total deadlines | Allows active long responses while bounding silence and total resource use | Requires explicit lifecycle handling and end-to-end error tests | Recommend |

Defaults are 120 seconds for initial response data, 120 seconds for subsequent inactivity, and one hour for total elapsed time per model HTTP request. These are server-owned operational limits, not a user allowance or an entire research-turn deadline.

This spec supersedes only the model-request timeout row in Section 4 of `2026-10-05-opencode-runtime-usage-policy-design.md`. Its removal of cumulative account limits and its other protections remain applicable.

## 4. Deadline semantics

Apply the new policy to the existing model POST routes: `/v1/responses`, `/v1/chat/completions`, and `/v1/messages`, for streaming and non-streaming bodies. Do not lengthen `/collaboration`, `/network`, or public-web egress operations as a side effect; preserve their existing deadlines.

| Deadline | Default | Starts | Resets | Terminal code |
| --- | --- | --- | --- | --- |
| Initial response data | 120000 ms | When the validated request is dispatched upstream | Never; ends when the first nonempty upstream body chunk arrives | `model_first_byte_timeout` |
| Response inactivity | 120000 ms | On the first nonempty upstream body chunk | On each later nonempty upstream body chunk | `model_idle_timeout` |
| Total model request | 3600000 ms | When the model request is admitted by the broker | Never | `model_total_timeout` |

DNS, connection, TLS, and time to first response body all consume the initial wait. Receiving only headers does not satisfy it. Existing HTTP header/body admission deadlines and body-size validation remain in force; a slowly uploaded body cannot obtain a longer deadline through this change. Dispatch may occur only after authorization and body validation, as today.

Measure elapsed time with a monotonic clock. Deadline options must be positive finite safe integers, initial and inactivity values must not exceed the total, and the total must not exceed the constructor ceiling of 3600000 ms. Tests may use shorter values. Expose no tenant-controlled timeout parameter or unbounded/off value. Reconcile existing constructor callers explicitly rather than silently changing the meaning of `timeoutMs`.

Upstream body bytes establish transport liveness, not semantic completion. SSE comments, ping events, and reasoning data renew inactivity just like text or tool data. Broker-generated diagnostics and downstream/browser activity do not renew it. Heartbeat-only responses must still stop at the total deadline. Do not parse model text or require visible answer tokens to declare activity.

For a non-streaming response, chunks also renew inactivity while bytes remain under the existing response-size limit; a complete valid response is still required for success. Preserve backpressure. A slow downstream consumer must not make a fully buffered upstream response count as completed; it remains subject to bounded resource use and the total deadline. Record downstream blocking when relevant rather than claiming that the provider was silent.

Use a single terminal outcome for each operation. At a boundary race, compare the effective deadlines when settling; total wins when both total and inactivity have expired. Completion already settled cannot later become a timeout, and explicit cancellation already settled cannot later become a model failure.

## 5. Cancellation and bounded streaming

Each request owns its timers, upstream request/body, downstream transfer, and active-capacity entry. Success, timeout, upstream failure, client cancellation, grant expiry/revocation, and broker shutdown must settle once and clean up all of them. Late events cannot write to a closed response or release a slot twice.

User Stop, grant revocation, and shutdown must abort upstream work immediately through the existing authorization and cancellation paths. Increasing stream duration must not extend capability expiry, bypass generation checks, or retain access after revocation.

Keep incremental forwarding and backpressure. Do not buffer an entire model response. An error-reporting path may hold only bounded parser state and a bounded terminal error frame. Individual body, response, output-token, and active-operation limits retain their current values. No additional lifetime request/token/byte counters may be introduced.

A known timeout needs a brief opportunity to report its cause before the downstream connection closes. The implementation must separate cancellation of upstream work from destruction of the downstream writer: aborting the present `pipeline(upstream, limiter, res)` first can destroy the response before the catch block can send an error. The replacement must retain backpressure and clean up promptly rather than merely adding a write to the current catch block.

Terminal error delivery may wait at most 1000 ms for a writable downstream. If the client disconnects, the response is malformed, the byte limit is exhausted, or the terminal frame cannot be delivered within that bound, destroy the connection and log the actual terminal reason. Never append a synthetic error inside a partially forwarded SSE frame: retain only enough bounded framing state to finish at an event boundary, or terminate the malformed stream. Never fabricate a successful finish marker to conceal failure.

## 6. Errors, persistence, and retries

Use stable codes for the three timeout phases. Before downstream headers are committed, return HTTP 504 with a bounded, sanitized error body containing the stable code, a short English message, and a broker-generated correlation ID. Keep it compatible with the selected adapter's existing HTTP error parser.

After streaming has begun, HTTP status cannot be changed. Emit the route's supported terminal error representation and close normally only when the installed OpenCode adapter has been proven to treat it as a failed generation. Responses, Chat Completions compatibility, and Messages do not share a universal error envelope. Document the exact tested representation and pinned parser version during implementation; use official protocol shapes, not a custom SSE event that the runtime silently ignores.

All enabled routes must pass a fixture through the installed OpenCode runtime, the existing SDK translation, and the Web session state. Messages compatibility is verified with deterministic fixtures only; no live Claude endpoint or alternative model probe is allowed. With a connected, writable downstream and valid SSE framing, a route whose known timeout still arrives as success or only an unexplained reset fails acceptance. Disconnected clients and the bounded malformed-frame/error-delivery fallbacks in Section 5 retain an accurate broker record; they cannot be promised delivery over a broken connection. If its pinned parser requires a narrowly scoped compatibility change, include that change and its regression test in this work; do not release a logging-only workaround as a complete repair.

The Web client continues to receive runtime events through `packages/sdk`. It must not call the broker directly or infer a timeout by matching every `ECONNRESET` string. Preserve the stable timeout code in a bounded marker/metadata field that survives the selected adapter and persisted assistant error. Reuse the existing session error and retry notice presentation, with localized copy:

| Code | Default English copy |
| --- | --- |
| `model_first_byte_timeout` | The model did not start responding within 2 minutes. Try again or choose another model. |
| `model_idle_timeout` | The model response was interrupted after 2 minutes without data. Your existing work is preserved. |
| `model_total_timeout` | This model request reached the one-hour limit. Your existing work is preserved; continue in another turn. |

Copy must reflect effective limits when tests or a trusted server configuration use different values. Unknown remote resets remain connection interruptions; never relabel them as proven local timeouts. Cancellation, permission denial, upstream refusal, size limits, and service interruption retain their distinct existing handling.

A retry notice is transient, not a final failure. If a permitted retry succeeds, remove the notice and do not leave a failed-turn banner. If retries exhaust, persist the final error so refresh or reopening the session shows the same cause and preserved partial output.

The broker introduces no retries. Initial-wait and inactivity timeouts may follow the pinned runtime's existing bounded retry policy; do not increase attempt limits or add a second retry loop. Total-deadline errors must not automatically restart the same one-hour request. Verify this behavior in the real adapter path rather than relying solely on a JSON `isRetryable` field that an adapter might discard.

Timeout recovery retries only a model continuation. It must not replay already executed tools, rerun the entire research workflow, overwrite completed files, or automatically append a user message to the affected conversation. Continuing after terminal failure is an explicit user action through the existing composer.

## 7. Diagnostic evidence

Emit one sanitized structured terminal record per model operation, including success and cancellation, with:

- Broker-generated correlation ID, trusted tenant/instance/generation identity, route, provider/model identifier, and outcome code.
- Total elapsed time, time to first upstream body data when present, time since last observed upstream data, and effective deadline values.
- Bytes received/forwarded, whether response headers were committed, whether downstream backpressure was active, and whether a terminal error was delivered.

Reuse existing logging and trusted context. Include a session identifier only when the existing route supplies one that can be verified; do not trust an arbitrary client header as authorization or invent a session mapping. Each retry attempt has its own operation record.

Never record credentials, authorization headers, model request/response text, reasoning, workspace file contents, or raw upstream error bodies. Do not copy upstream strings into a public error without sanitization. This adds no durable broker database or separate monitoring service.

## 8. Acceptance criteria

Run deterministic verification through repository package scripts with the shared host lock and verified cgroup limits. If the lock is occupied, report the check as not run; do not bypass the guard. Use short injected deadlines and controlled upstream fixtures for most cases, with a default-duration test where specified.

1. Reproduce the existing absolute-deadline defect against the release-matching class: a continuously active stream is cut at its configured total timeout and the client observes a reset. Record this baseline before changing behavior.
2. A stream delivering data at intervals below the inactivity deadline completes after more than 120 seconds with production defaults. A scaled deterministic version also crosses the former deadline. The hard limit is separately asserted as one hour; no routine test needs to wait one hour.
3. No headers/body, and headers without body, both terminate at the initial-data deadline with `model_first_byte_timeout`. A delayed first body chunk before the deadline succeeds.
4. A stream that starts and then stops sending bytes terminates at the inactivity deadline with `model_idle_timeout`. Repeated chunks renew that deadline but never the total deadline.
5. Ping/comment-only SSE and streams with continuous reasoning hit `model_total_timeout` if they do not complete before the total deadline. Fragmented frames and UTF-8 boundaries do not corrupt forwarding or terminal errors.
6. Non-streaming success and stalled non-streaming responses obey the corresponding deadlines, content-type checks, and individual byte limit.
7. Each allowed protocol route carries all three timeout reasons through a local fixture and the installed OpenCode adapter into persisted session errors. A refresh/reopen shows the correct localized reason at desktop browser width and 360 px. No timeout is shown as successful completion.
8. Successful runtime retry clears transient warnings; exhausted retry retains the actual cause. Unknown upstream resets are not mislabeled. A total-deadline error does not trigger an automatic second full request.
9. Success, all timeout phases, malformed upstream data, upstream disconnect, downstream disconnect/backpressure, Stop, grant expiry/revocation, and shutdown release the active slot and all timers/listeners. A subsequent authorized request succeeds, with no duplicate terminal record or write-after-close error.
10. Cancellation/timeout/completion races produce exactly one outcome. Error delivery respects the 1000 ms drain bound and does not bypass the individual response-byte limit.
11. Existing tenant identity, generation, model/route allowlist, fixed endpoint, concurrency, individual body/response/token limits, credential redaction, and unlimited cumulative OpenCode usage regression checks continue to pass. `/network`, `/collaboration`, and egress retain their existing limits.
12. A controlled research turn that has already executed a tool can fail its next model continuation without replaying that tool or losing earlier output/files. Do not use the user's affected conversation as a destructive fixture.

Live acceptance uses an available non-Claude provider and a separate controlled conversation only after implementation and deployment are authorized. Deterministic long-duration streaming fixtures are required even if a live provider returns quickly. No provider availability assumption substitutes for timeout coverage.

## 9. Delivery and review boundary

This artifact is a specification for review. It does not authorize implementation, an implementation-plan document, service restart, deployment, or mutation of the original conversation.

After approval, the implementation plan must identify the complete source baseline, pinned parser compatibility, focused changes, guarded regression commands, Web acceptance at desktop/phone widths, and the existing release/rollback procedure. Publish only a validated candidate through the repository release workflow. Failed builds leave the deployed Web bundle untouched; rollback must preserve conversations, credentials, and workspace state.

## 10. Protocol references

Protocol references inform error transport; the installed adapter's deterministic tests remain authoritative for compatibility. Consulted October 8, 2026:

- Node.js v24 stream documentation, `stream.pipeline()` destruction behavior: `https://nodejs.org/docs/latest-v24.x/api/stream.html`.
- OpenAI Responses streaming event reference, terminal error events: `https://developers.openai.com/api/reference/resources/responses/streaming-events`.
- Anthropic Messages streaming documentation, ping and error events: `https://platform.claude.com/docs/en/build-with-claude/streaming`.
- Vercel AI SDK OpenAI-compatible chat adapter source: `https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts`. The moving main branch is a reference, not proof of the deployed parser version.
