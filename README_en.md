# dsh-efficiency-orchestrator

**One plugin, two kinds of leverage.** A runtime plugin for [DeepSeek Harness](https://deepseek.com/harness) (DSH) that runs four turn/step-efficiency capabilities under a single in-process scheduler for one Host lifetime: OPS read-only tool takeover, reasoning-loop breaking, batch tool-call suggestions, and session-budget guards.

Unlike efficiency plugins that only contribute prompt text, this one **takes over the tool layer**: it swaps the official `read` / `glob` / `grep` out of the model's view and publishes `ops_inspect_local_file` / `ops_glob` / `ops_grep` in their place. Whether those official tools are registered at profile scope (TUI / headless compositions) or moved into Agent presets by Web / Desktop, the plugin completes registration and masking **in the matching scope** — including taking over preset scope from a profile-level mount.

> **Status: developer preview.** Verified at the source level and in a running Host on DSH `0.2.2-rc.2` + `@deepseek-ai/cordis` `4.1.0`. Behavior on other Host compositions follows the version you run.

## Why "takeover" instead of "advice"

Which tools a model can call is decided by the **scope view** of `ToolsService`, and a profile-level plugin's `ctx.tools.definitions()` only sees the global layer. The problem is that DSH's official compositions disagree:

- **TUI / headless:** `dsh-base` mounts `tool-fs` and `tool-fs-search` as host rows, so `read` / `glob` / `grep` are in the profile view.
- **Web / Desktop:** `@deepseek-ai/dsh-web-app/cordis.patch.yml` sets both rows to `disabled: true`, and `presets/standard.patch.yml` mounts them in each Agent's preset scope instead — the profile view contains **none of them**.

A conventional plugin therefore can neither register a replacement on Web (it cannot capture the official `execute`) nor mask the originals (`ctx.tools.restrict()` is rejected by the Host on an unscoped profile context). The opening this plugin uses is `agent/created`: it fires after the preset has mounted and before the first prompt assembly, when `agent.ctx.tools` already sees the preset's registrations and the first tool declaration has not been produced yet.

## Capabilities

| Layer | What it does | Default |
|---|---|---|
| Tool layer | **Dual-path OPS takeover.** Probes the profile view; when the official tools are visible there it registers `ops_*` globally and masks `read`/`glob`/`grep` per Agent; when they live in presets it registers and masks inside each Agent scope at `agent/created`. An existing external OPS provider is reused with zero registrations; after a successful takeover it registers a conditional replacement notice. Freezes the tool mapping table. | On |
| Streaming layer | Listens on `llm/stream` and inspects only `reasoning-delta` chunks for repetition or self-referential spinning. On a hit it drops the remaining reasoning deltas and rewrites `block-end` with the truncated text, so the **persisted** block is the truncated one. | On |
| Execution layer | Registers the static batch-policy section `dsh-efficiency-orchestrator:batch-policy` (order `9550–9599`), resolving tool ids per Agent at assembly time; inserts a ≤80-character notice on the first `pre-step` after compaction. | **Batch section off** |
| Session layer | Registers the static budget section `dsh-efficiency-orchestrator:session-budget` (order `9700`) with conditional reminder text; supports a hard stop and a degraded strong reminder. | Section on, budget inactive |

## The tool layer: dual-path OPS takeover

### Two composition shapes

| Where the official tools live | What the plugin does | How it masks |
|---|---|---|
| Profile scope (TUI / headless) | Registers `ops_*` once at profile scope; each alias captures the official definition from the profile view | Calls `agent.ctx.tools.restrict({ deny: [official] })` for every Agent |
| Agent preset scope (Web / Desktop) | At `agent/created`, captures the official definition from **that Agent's view** and registers `ops_*` in the `agent.ctx` scope | Calls `restrict()` in the same `agent.ctx` scope, hiding only the copy that Agent can see |

After a successful takeover the layer also registers a **conditional notice section**,
`dsh-efficiency-orchestrator:tool-takeover` (order `9600`). It renders only for an
Agent that has actually lost an official name and gained the matching OPS alias, and
then states plainly that the official `read`/`glob`/`grep` are disabled and that the
`ops_*` tools are the way in. The model never has to discover the replacement by
calling a tool that no longer exists; an Agent that was not taken over (another
preset, an external provider, a rolled-back attempt) renders nothing.

### Six invariants of a takeover

1. **Read-only probes, no trial registrations.** The layer queries with `get()` / `definitions()` and never registers a throwaway probe tool. When an external OPS provider is detected (for example `dsh-ops/integration`), it registers and masks nothing and simply reuses it.
2. **Visibility is decided per Agent.** "Can this Agent see the official tool?" is always asked with that Agent as the scope, never inferred from the profile view. No visibility, no publication — an Agent whose preset has no `read` never receives a stray alias.
3. **Mask first, register second, roll back on failure.** The official name is restricted first; if the alias registration or its verification fails, the alias is removed and the mask lifted immediately — **replacement never removes a capability from an Agent**.
4. **Verify after registering.** The alias must be visible to that Agent and the official name must be gone. If either check fails, the layer rolls back and warns instead of silently leaving a "looks taken over" state.
5. **Queries pass an explicit scope.** The viewing scope of `get()` / `definitions()` is an **argument**, not `this.ctx`; only `register()` / `restrict()` bind a scope through the traceable context. Mixing the two collapses a preset-scope query back to the profile view — the exact failure this plugin exists to fix.
6. **The layer owns its lifecycle.** Per-Agent registrations and masks belong to the Agent fiber, not to this plugin, so they are released explicitly on `agent/disposed` and on plugin unload. A reload leaves no stale mask or stale tool behind.

### Timing

```
createAgent()
  ├─ setup(agentCtx, agent)        # the preset mounts here: read/glob/grep enter the preset scope
  ├─ agents.enter(agent)           # joins the registry, not announced yet
  ├─ agents.announce()             # serial agent/created ← this plugin registers + masks here
  └─ first turn → tools.resolve()  # the first tool declaration contains ops_*, not read/glob/grep
```

`agent/created` is the only window where the preset is ready but the model has not seen a tool table yet. Earlier, the preset's registrations are invisible; later, the first declaration is already built. Agents that exist when the plugin activates are handled through `agents.list()`.

### Diagnostics

With `logLevel: debug`, the tool layer leaves logs that identify the active path directly:

- `profile scope exposes none of "read"/"glob"/"grep" … OPS publication runs inside each Agent scope` — recognized as a preset composition, entering the per-Agent path.
- `per-Agent OPS takeover: registered …, hid … for agent …` — the result for each Agent.
- `forced replacement: official … hidden for agent …` — masking result on the profile path.
- `OPS takeover could not replace an official tool …` — a failure that needs attention (already rolled back, no capability lost).

The scheduler's `tools` status records `per-Agent OPS takeover armed` / `active` in step, so the current path is visible in the Plugins panel and Host diagnostics.

## Compatibility

- DSH `0.2.2-rc.2` (`engines.dsh` declares `^0.2.2-rc.2`).
- Cordis `4.1.0` (`peerDependencies` declares `~4.1.0`).
- Node.js `>=20` (the build and runtime use `node:crypto`; the output is ES2022 ESM).
- **Zero third-party runtime dependencies**; `@deepseek-ai/cordis` is type-only (`import type`).

The `ctx.tools` / `ctx.systemPrompt` / `ctx.on('agent/created')` / `ctx.on('agent/pre-step')` / `ctx.on('session/event')` surfaces used here are local structural mirrors (see `src/host.ts`). If a future DSH release changes a signature, the compiler points at the single mirror that needs updating.

## Installation

The repository is **not published to npm**; `lib/` is a build artifact and is not committed. Build from source, then install the local directory:

```bash
npm install          # build-time devDependencies
npm run typecheck    # optional
npm run build        # emits lib/index.js and lib/types/
```

Then choose one:

1. **Web / Desktop Plugins panel:** Plugins → Add plugin → select this directory.
2. **DSH CLI:** `dsh plugin --profile <profile> add <absolute path to this directory>`.

> Make sure `lib/index.js` and `lib/types/index.d.ts` exist first; a local-directory install resolves `package.json#exports["."].default = ./lib/index.js` directly.

### What to expect after installation

- The plugin fiber is `ACTIVE`, with no `live/failed-fiber` and no `live/pending-missing-service`.
- The tool layer takes one of two paths: it reuses an external OPS provider, or it takes over itself — registering OPS aliases globally in a profile composition, or per Agent at `agent/created` in a preset composition.
- A taken-over Agent sees only `ops_inspect_local_file` / `ops_glob` / `ops_grep`; the official `read` / `glob` / `grep` are gone. The system prompt also carries a `⚠️` replacement line naming the OPS tools, so the model never burns a step trying an official name first.
- With the batch section enabled, `dsh-efficiency-orchestrator:batch-policy` appears in the system prompt and names the read-only tools **that Agent can actually see** (usually the `ops_*` ids).
- The session budget section registers according to its switch (it renders empty when no budget is configured).

### Uninstall / reload self-check

Disabling or removing the plugin must restore the pre-install state: profile-scope OPS aliases disappear with the plugin fiber; every Agent's `ops_*` registrations and official-tool masks are released explicitly (`agent/disposed` or teardown); `dsh-efficiency-orchestrator:*` sections are gone from the system prompt; and the `agent/created`, `agent/pre-step`, `session/event`, and `llm/stream` listeners are all disposed. Re-enabling creates a fresh scheduler instance, so no truncation marks, compaction marks, budget state, or frozen mapping table survive a reload.

## Configuration

The plugin exports no schemastery `Config`: the Loader passes the bundle row's `config` through untouched, and `src/config.ts` normalizes it, clamps ranges, and ignores unknown fields. Example:

```yaml
# cordis.patch.yml (or your profile patch row)
- insert:
    - id: dsh-efficiency-orchestrator
      name: 'dsh-efficiency-orchestrator'
      config:
        toolLayer:
          enabled: true
          warning: true      # default true: inject the "official tools disabled" notice after takeover
        streaming:
          enabled: true
        execution:
          enabled: true
          batch:
            enabled: true      # default false: no section unless enabled
            order: 9550        # clamped to 9550–9599
            maxToolHints: 4    # max visible tool ids named in the section
          notice: true         # only effective when the batch section registered
        session:
          enabled: true
          hardStop: false      # reject a step once the budget is exceeded (Host support required)
          fallbackStepLimit: 0 # 0 = the self-built counter never triggers
          warnWithin: 2        # render the reminder within this many steps of the limit
```

| Field | Default | Description |
|---|---|---|
| `toolLayer.enabled` | `true` | When off: no probing, registration, masking, or mapping table |
| `toolLayer.warning` | `true` | Inject the "official tools disabled" notice after takeover; rendered per Agent |
| `streaming.enabled` | `true` | When off: no `llm/stream` listener |
| `execution.enabled` | `true` | When off: no execution layer (batch section and notice both inactive) |
| `execution.batch.enabled` | `false` | Batch-policy section switch (registers only when explicitly enabled) |
| `execution.batch.order` | `9550` | Clamped to `9550–9599` |
| `execution.batch.maxToolHints` | `4` | Max tool ids named in the section (`0–12`) |
| `execution.notice` | `true` | Post-compaction notice (requires the batch section) |
| `session.enabled` | `true` | Session budget section switch |
| `session.hardStop` | `false` | Attempt `{ kind: 'reject' }` when the budget is exceeded |
| `session.fallbackStepLimit` | `0` | Self-built step limit when no external budget is readable; `0` = never triggers |
| `session.warnWithin` | `2` | Render the reminder at or below this many remaining steps / turns |

## Behavior and safety boundaries

- **Tool takeover never drops a capability.** The plugin registers only `ops_*` ids and never overrides an official id, so it cannot produce `live/tool-id-conflict`; the same official name across scopes is naturally shadowed by the nearest scope. Masking is strictly gated on visibility and follows "mask first, register second, roll back on failure, verify after registering": an official name is hidden only when the alias is confirmed visible to that Agent. If the Host lacks an Agent-scoped registration surface or `agent.ctx`, the layer records one diagnostic and leaves the official tools visible rather than forcing a registration.
- **Read-only probes, no trial registrations.** The layer queries with `ctx.tools.get()` / `definitions()`; an external OPS provider means zero registration calls. A profile-scope registration conflict rolls back this attempt, yields, and **never retries**.
- **The batch section resolves per Agent.** Its text queries the Agent's scope for visible read-only tools on every assembly, so Web names `ops_*` and TUI names the official ids; the frozen table is only the fallback for an agent-less preview.
- **Conservative batch-section default.** It registers only when explicitly enabled, when the tool mapping table is frozen, and when a read-only `systemPrompt.assemble()` can confirm that no `batch-tool-calls:policy` exists. When that cannot be confirmed it declines to register and records a diagnostic. The notice likewise requires "section registered + notice enabled".
- **Truncation is decided by what is persisted.** A streaming hit only affects `reasoning` blocks: later deltas are dropped and `block-end`'s `block.text` is replaced with the truncated version; text and tool-call deltas pass through untouched. A detector failure disables detection for that stream only and never blocks the model stream.
- **Post-compaction notice.** `compaction/end` is a session-log event (observed through `session/event`). At most one notice per compaction, at most 80 characters; a failed insertion clears the mark and records a diagnostic without retrying. The notice is injected with the plugin's own source (`form: 'notice'`) and never impersonates user input.
- **Session budget.** The layer only soft-probes `settings.describe()`, `configEditor.configuration()`, and `agentPresets.list()` for explicitly declared `turnLimit`-style fields; it does **not** read, and does not claim to read, the budget of `dsh-flash-presets`. Without a readable limit it falls back to its own step counter, which stays inactive until configured. The hard-stop capability is probed at startup; when unsupported it degrades to a strong in-section reminder and records the overrun in scheduler state.
- **No service is published.** `ctx.on`, `ctx.tools.register`, and `ctx.systemPrompt.section` are Cordis effects and are disposed with the plugin fiber; per-Agent `ctx.tools.register()` and `ctx.tools.restrict()` are released by this plugin on `agent/disposed` and during scheduler teardown. Plugin-owned state (stream buffers, session counters, registration bookkeeping, Agent takeover disposers) drains through the scheduler's serial `ResourceManager`; the root effect's disposer waits for asynchronous mounts to finish before cleaning up.

## Architecture

```
apply(ctx, config)
└─ ctx.effect(...)                       # one root effect + one disposer
   └─ OrchestratorScheduler.start()
      ├─ ToolLayer        # probe the profile view, then either:
      │                   #   ├─ official tools at profile → register ops_* globally + mask per Agent
      │                   #   └─ official tools in presets → register + mask per Agent in agent/created
      ├─ StreamingLayer   # llm/stream: reasoning-delta detection → truncated block-end
      ├─ ExecutionLayer   # batch section (per-Agent tool ids) + compression notice
      └─ SessionLayer     # budget section (conditional text) + counters / hard stop
```

- **Mount order is causal order.** The tool layer completes the takeover first (freezing the mapping table on the profile path), and only then may the execution layer register the batch section; at `pre-step` the execution layer consumes the truncated-reasoning mark before deciding whether to insert a notice.
- **Two paths, one set of invariants.** Whether an alias is registered at profile or Agent scope, visibility checks, masking, rollback, verification, and release follow identical rules, so behavior does not drift with the composition.
- **The scheduler is the single state owner.** `truncatedSessions`, `compactionPending`, `budgetExceeded`, `frozenToolMap`, and the Agent takeover table live on the scheduler / tool-layer instance and are cleared on unload; a new load creates a fresh instance and never reads stale state.
- **Lifecycle race protection.** If an unload happens during an asynchronous mount (the read-only `assemble()` probe), `stop()` waits for the mount chain, and each layer re-checks `isRunning()` after `await`, so no effect is registered after unload begins.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> lib/
npm pack --dry-run   # inspect the packaged files
```

- `lib/` and `node_modules/` are ignored by `.gitignore`; `lib/` must be built before installation.
- Source is ES2022 ESM with `verbatimModuleSyntax` and `isolatedModules`; every relative import carries the `.js` extension (NodeNext).
- Run `npm run typecheck` before committing; CI (GitHub Actions) runs `npm install && npm run typecheck && npm run build && npm pack --dry-run`.

### Directory layout

```
.
├─ package.json
├─ tsconfig.json
├─ cordis.patch.yml
├─ src/
│  ├─ index.ts                  # entry + OrchestratorScheduler + ResourceManager
│  ├─ config.ts                 # config normalization and section constants
│  ├─ types.ts                  # scheduler vocabulary / SchedulerHost
│  ├─ host.ts                   # local structural mirrors, incl. the scope-query contract
│  ├─ notice.ts                 # post-compaction notice message
│  ├─ tool-layer.ts             # tool layer: dual-path OPS takeover
│  ├─ streaming-layer.ts        # streaming loop breaker
│  ├─ reasoning-loop-detector.ts# pure detection kernel
│  ├─ execution-layer.ts        # execution layer
│  └─ session-layer.ts          # session budget layer
└─ lib/                         # generated by npm run build, not committed
```

## Known limitations

- **Chinese prompt text.** The built-in batch and budget section texts are Chinese; tool ids and config keys are English.
- **Three hard-coded tool pairs.** The takeover is fixed to `read ↔ ops_inspect_local_file`, `glob ↔ ops_glob`, and `grep ↔ ops_grep` (`OPS_TOOL_PAIRS`); adding a tool requires extending both that table and the fields forwarded by `aliasDefinition`.
- **Depends on the Agent lifecycle contract.** The Agent path requires `agent.ctx`, serial `agent.created` events, and a `tools.get()` that accepts a scope (the verified version provides all three). Degradation: the profile path keeps working; the Agent path records a diagnostic and leaves the official tools visible, and never fails the fiber.
- **Preset hot-swap boundary.** An alias captures the official definition of the preset revision present at `agent/created`; after a preset switch on a blank session, the alias still points at the previous revision's `execute` until the Agent is recreated. Regular sessions do not take this path.
- **Conservative batch-section registration.** If the read-only `systemPrompt.assemble()` is unavailable or throws, the section is not registered and the log records "cannot confirm … conflict". Check whether the profile's tool executor is mounted first.
- **Hard-stop semantics.** With `session.hardStop` enabled and the budget exceeded, every later `pre-step` of that session is rejected until the budget state is reset (a new session or a plugin reload). That is the intended meaning of "hard stop"; keep `hardStop: false` when you do not want it.
- **Post-compaction notice.** Depends on the Host writing `compaction/end` to the session log; without a compaction plugin or that event, the notice channel stays silent (the batch section is unaffected).
- **External budget probing is heuristic.** It matches `turnLimit`, `maxTurns`, `maxUserTurns`, `maxRounds`, and `roundLimit` in the readable `settings` / `configEditor` / `agentPresets` configuration; another plugin using one of those names for an unrelated value could be mistaken for an explicit turn cap. Disable the `session` layer or avoid those keys in unrelated profile fields if that matters.
- **Coexistence with an external OPS provider.** When `ops_inspect_local_file` / `ops_glob` / `ops_grep` are already resolved, this plugin registers and masks nothing and leaves the replacement semantics entirely to the external implementation.
- **No UI / settings page.** Configuration comes through the bundle row; the plugin registers no Web route and no client module.

## Acknowledgements

This plugin's design is related to the following community projects and specifications (MIT-licensed or public semantic references):

- [dsh-no-loop-plugin](https://github.com/54nanmiao/dsh-no-loop-plugin) — the signal model for streaming reasoning-loop breaking (ritual / recycle / tail with three sensitivity tiers) and the key insight that `block-end` must persist the truncated text.
- [dsh-batch-tool-calls](https://github.com/liancha22/dsh-batch-tool-calls) — placement of the static prompt section around order 9500 and the "insert one notice on the first `pre-step` after compaction" channel design.
- [dsh-ops](https://github.com/T-Auto/dsh-ops) — OPS tool naming and the replacement semantics of "hide the official tool only when the OPS counterpart is visible".

> The detector here is an independent TypeScript implementation (not a verbatim copy of any upstream source), but its signal model is inspired by the projects above. If you redistribute this project, keep this acknowledgement section.

## License

[MIT](./LICENSE) © 2026 dsh-efficiency-orchestrator contributors
