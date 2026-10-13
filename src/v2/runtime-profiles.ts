/**
 * Session-frozen v2 runtime profiles.
 *
 * AGENTS.md: system prompts and tool sets stay frozen for the lifetime of a
 * session — so a config/preset change must never rebuild agent definitions or
 * reload the host registry. Instead, the adapter resolves ONLY the
 * inference/runtime fields (model, variant, temperature, provider options)
 * into a per-agent profile, freezes the current profile for each NEW child
 * session, and applies it before that child's first request:
 *
 * - `model`/`variant`: `session.switchModel` for host defaults; per-call models
 *   stay untouched (v2 prompts carry no model).
 * - `temperature`/provider `options`: mutated onto the context hook's
 *   `options` record for that captured session only (never system/messages/
 *   tools — prompt bytes and tool catalogs stay untouched).
 *
 * Existing/resumed child sessions keep the profile captured when they were
 * first seen; parents and foreign-agent sessions are never touched.
 */
import type { V2Context, V2SessionContextEvent } from './types';

/** One agent's hot-applicable inference fields + sidebar projection. */
export interface V2AgentRuntimeProfile {
  model?: { providerID: string; id: string; variant?: string };
  temperature?: number;
  providerOptions?: Record<string, unknown>;
  /** Provider-option keys owned by the startup or refreshed profile. Keys
   * absent from `providerOptions` are removed from the request so clearing a
   * preset field cannot leak the startup registry value into a new child. */
  managedProviderOptionKeys?: readonly string[];
  /**
   * Ordered fallback candidates frozen with the profile (issue #1527).
   * Final wiring populates this for every bound profile; a captured entry
   * without it reads as `startup-policy` (never a chain-less `bound-child`
   * that would silently keep the startup read). An explicit (possibly
   * empty) array is the bound chain for captured children — empty or
   * `fallbackDisabled` never falls back to the startup chain.
   */
  fallbackChain?: ReadonlyArray<{ id: string; variant?: string }>;
  /** Explicitly disabled fallback chain: bound children are not steered. */
  fallbackDisabled?: boolean;
  /**
   * Model source this agent inherits from (issue #1527), frozen with the
   * profile entry. Absence is meaningful: a refresh that removes inheritance
   * must not let delegation revive stale startup inheritance.
   */
  inheritModelFrom?: string;
  sidebarModel: string;
  sidebarVariant?: string;
}

export type V2AgentRuntimeProfiles = Record<string, V2AgentRuntimeProfile>;

/**
 * One published inference generation (issue #1527): the current
 * profiles (each entry carrying its own inference + inheritance + fallback
 * candidates), and the sidebar projection resolved with them. The factory
 * owns the single reference; the builder constructs it, publish swaps it,
 * and the sidebar projects it afterwards. No separate generation owner or
 * session map.
 */
export interface V2InferenceTable {
  profiles: V2AgentRuntimeProfiles;
  projection: {
    agentModels: Record<string, string>;
    agentVariants: Record<string, string>;
  };
}

/** Per-session frozen profile (`null` = frozen with no applicable profile). */
type FrozenProfile = V2AgentRuntimeProfile | null;

/** Cap on lifecycle-independent bookkeeping (ignored roots/foreign sessions
 *  and deletion tombstones). Captured snapshots and awaiting-capture markers
 *  are released by session lifecycle (capture/ignore/delete), never evicted. */
const MAX_PROFILE_SESSIONS = 1024;
const PROFILE_OPERATION_TIMEOUT_MS = 2_000;
/** Bound for the request-path model switch. Rejecting (not proceeding) is
 * fail-closed: the prompt hook aborts the admission before any request can
 * run on a stale model, and a retry re-awaits the idempotent switch. */
const PROFILE_SWITCH_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameModel(a: unknown, b: V2AgentRuntimeProfile['model']): boolean {
  return (
    isRecord(a) &&
    b !== undefined &&
    a.providerID === b.providerID &&
    a.id === b.id &&
    (a.variant ?? 'default') === (b.variant ?? 'default')
  );
}

async function withProfileTimeout<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs: number = PROFILE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolve the payload of a raw v2 event: live hosts carry it under `data`;
 * `properties` is the legacy spelling. Exported so every raw-event bridge
 * (permission rules, runtime profiles) resolves payloads identically.
 */
export function resolveV2EventPayload(
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(event)) return {};
  if (isRecord(event.data)) return event.data;
  if (isRecord(event.properties)) return event.properties;
  return {};
}

export interface SessionProfileBridgeOptions {
  /** Current profile table (read on every newly seen child). */
  profiles: () => V2AgentRuntimeProfiles;
  /** Startup profiles, matching the host-registered agent defaults. */
  registeredProfiles?: V2AgentRuntimeProfiles;
  /** Plugin-defined agent ids; foreign children are never profiled. */
  pluginAgents: ReadonlySet<string>;
  /** Session domain used for `session.get` (identity) and `switchModel`. */
  session: V2Context['session'] | undefined;
  /** Agent most recently learned from the prompt bridge's context events;
   * consulted when `session.get` carries no `agent` (or is unavailable). */
  knownAgent?: (sessionID: string) => string | undefined;
  /** Observability/log seam (tests inject; defaults to no logging). */
  log?: (message: string, meta?: unknown) => void;
  /** Test seam: override the request-path model-switch bound. */
  switchTimeoutMs?: number;
}

/**
 * Identity fields the child gate keys on. `session.created` payloads carry
 * `{parentID, agent}`; the awaited `session.prompt` hook carries neither, so
 * the prompt path resolves them through `session.get` (and the prompt
 * bridge's learned agent as a fallback).
 */
export interface SessionProfileIdentity {
  parentID?: string;
  agent?: string;
  model?: unknown;
}

export interface SessionProfileBridge {
  /** Observe one raw v2 event (prewarm/cleanup path); never throws. */
  observeEvent(event: Record<string, unknown>): Promise<void>;
  /**
   * Idempotent capture-and-switch for ONE session, awaited on the request
   * path (the native `session.prompt` hook) before the admission's first
   * model request. When `identity` is omitted, `session.get` resolves the
   * session's `parentID`/`agent`. For an identified plugin child, model
   * switching is fully awaited and a failed switch rejects the admission;
   * unknown identity remains untouched because it may be a root or foreign
   * session. Once captured (or proven root/foreign) the call is O(1).
   */
  ensureSessionProfile(
    sessionID: string,
    identity?: SessionProfileIdentity,
  ): Promise<void>;
  /** Frozen profile for a session (undefined when not captured). */
  profileForSession(sessionID: string): V2AgentRuntimeProfile | undefined;
  /**
   * Three-state fallback binding for a session (issue #1527):
   * - `bound-child`: captured entry with frozen `entries`/`disabled`;
   *   an explicit (possibly empty) array is the bound chain, never the
   *   startup chain. A captured legacy profile without candidate data
   *   reads as `startup-policy` until wiring populates every profile.
   * - `pending-child`: confirmed managed child without a successful capture
   *   (in-flight or failed switch); do not steer, retain the host decision.
   * - `startup-policy`: root/foreign/never-seen (or legacy snapshot without
   *   candidate data); keep the original startup policy and isolation rules.
   */
  fallbackBindingForSession(
    sessionID: string,
  ): SessionFallbackBinding | undefined;
  /** Captured session count (released via session.deleted; test seam). */
  size(): number;
}

/**
 * Fallback binding for one session (issue #1527). Discriminated
 * union: `bound-child` always carries the frozen `entries` and `disabled`;
 * `pending-child`/`startup-policy` carry no bound fields. A captured legacy
 * profile without candidate data reads as `startup-policy` until wiring
 * populates every bound profile (final wiring must populate all entries).
 */
export type SessionFallbackBinding =
  | {
      state: 'bound-child';
      /** Agent the bound entry was captured for. */
      agent?: string;
      /** Frozen fallback candidates (possibly empty, never the startup chain). */
      entries: ReadonlyArray<{ id: string; variant?: string }>;
      /** Frozen disabled-chain flag. */
      disabled: boolean;
    }
  | { state: 'pending-child' }
  | { state: 'startup-policy' };

/**
 * Freeze the current runtime profile for each newly seen plugin child session
 * and apply the model via `session.switchModel`.
 *
 * Two entry points share one idempotent, concurrency-safe capture:
 * - `ensureSessionProfile`: awaited from the native `session.prompt` hook
 *   (and any other request-path caller) so a child's first model request
 *   can never race the asynchronous event pump. Identity comes from
 *   `session.get` (or a caller-provided hint).
 * - `observeEvent`: the `session.created` prewarm plus `session.deleted`
 *   cleanup. It never determines the outcome on its own; a session already
 *   captured here is a no-op.
 *
 * Sessions proven to be roots or foreign-agent children are latched as
 * ignored so the request path does not re-query the host on every prompt.
 */
export function createSessionProfileBridge(
  options: SessionProfileBridgeOptions,
): SessionProfileBridge {
  /**
   * Per-session frozen snapshot: the agent the entry was captured for plus
   * the frozen profile. Stored in the one existing capture map (an extension
   * of existing state, not an independent registry): profile and fallback
   * candidates freeze together, and a refresh never mutates a bound entry.
   * Snapshots are released only via `session.deleted`; they are never
   * pruned while the child is retained — a long-idle live child must not be
   * evicted and rebound to a newer chain.
   */
  const captured = new Map<
    string,
    { agent?: string; profile: FrozenProfile }
  >();
  /** Sessions proven to never qualify (root / foreign / non-plugin agent). */
  const ignored = new Set<string>();
  /** Deleted ids stay inert until a fresh session.created proves reuse. */
  const deleted = new Set<string>();
  /**
   * Confirmed managed children without a successful capture (in-flight
   * captures live in `pending`; this set persists failed attempts so a
   * retry is read as `pending-child`, never `startup-policy`). No
   * independent generation owner/ID and no second session registry: entries
   * are added only from the existing capture identity resolution and
   * released on capture/ignore/delete — never evicted into `startup-policy`
   * while the child is retained.
   */
  const awaitingCapture = new Set<string>();
  /** In-flight captures, so concurrent callers share one switch. */
  const pending = new Map<string, Promise<void>>();
  const emitLog = options.log ?? (() => {});

  /** Bounded bookkeeping only for proven-non-child sessions and tombstones;
   *  captured snapshots and awaiting-capture markers are lifecycle-managed
   *  (released on capture/ignore/delete), never FIFO-evicted. */
  function prune(): void {
    while (ignored.size > MAX_PROFILE_SESSIONS) {
      const oldest = ignored.values().next().value as string | undefined;
      if (oldest === undefined) break;
      ignored.delete(oldest);
    }
    while (deleted.size > MAX_PROFILE_SESSIONS) {
      const oldest = deleted.values().next().value as string | undefined;
      if (oldest === undefined) break;
      deleted.delete(oldest);
    }
  }

  function cleanID(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
  }

  /**
   * Resolve `{parentID, agent}` for a session. A provided hint is
   * authoritative for the fields it carries (an undefined field is a
   * definitive absence — e.g. `session.created` for a root session).
   * Otherwise `session.get` is consulted; `agent` falls back to the prompt
   * bridge's learned state. `authoritative` reports whether the absence of
   * `parentID` is proven (so root sessions can be latched as ignored).
   */
  async function resolveIdentity(
    sessionID: string,
    hint: SessionProfileIdentity | undefined,
  ): Promise<{
    parentID?: string;
    agent?: string;
    model?: unknown;
    authoritative: boolean;
  }> {
    let parentID = cleanID(hint?.parentID);
    let agent = cleanID(hint?.agent);
    let model = hint?.model;
    let authoritative = hint !== undefined;
    const get = options.session?.get;
    if ((!parentID || !agent) && typeof get === 'function') {
      try {
        const response = await withProfileTimeout(
          get.call(options.session, { sessionID }),
          'session profile identity lookup timed out',
        );
        const info =
          isRecord(response) && isRecord(response.data)
            ? response.data
            : response;
        if (isRecord(info)) {
          if (!parentID) parentID = cleanID(info.parentID);
          if (!agent) agent = cleanID(info.agent);
          model ??= info.model;
          authoritative = true;
        }
      } catch (err) {
        emitLog('[v2][profile] session identity lookup failed', {
          sessionID,
          error: String(err),
        });
      }
    }
    if (!agent) {
      agent = cleanID(options.knownAgent?.(sessionID));
    }
    return {
      ...(parentID ? { parentID } : {}),
      ...(agent ? { agent } : {}),
      model,
      authoritative,
    };
  }

  async function ensure(
    sessionID: string,
    identity?: SessionProfileIdentity,
  ): Promise<void> {
    if (
      captured.has(sessionID) ||
      ignored.has(sessionID) ||
      deleted.has(sessionID)
    ) {
      return;
    }
    const inFlight = pending.get(sessionID);
    if (inFlight) {
      await inFlight;
      return;
    }
    const task = (async () => {
      const resolved = await resolveIdentity(sessionID, identity);
      if (!resolved.parentID) {
        if (resolved.authoritative) {
          // Proven root session: never profile it.
          ignored.add(sessionID);
          awaitingCapture.delete(sessionID);
          prune();
          return;
        }
        // Reduced/temporarily unavailable host identity surface: the session
        // may be a root or foreign child, so touching or rejecting it would
        // violate isolation. Leave it uncaptured; a creation event can still
        // prove plugin-child identity before a later request.
        return;
      }
      if (!resolved.agent) {
        return;
      }
      if (!options.pluginAgents.has(resolved.agent)) {
        // Foreign-agent child: its sessions are never touched.
        ignored.add(sessionID);
        awaitingCapture.delete(sessionID);
        prune();
        return;
      }
      // Confirmed managed child: a later failure still reads as
      // pending-child (host decision retained), never startup-policy.
      awaitingCapture.add(sessionID);

      const profile = options.profiles()[resolved.agent];
      if (!profile) {
        // Plugin-managed but absent from the profile table (e.g. a
        // marketplace-agent child: the registry registers it yet the table
        // is built from createAgents, which has no marketplace handling).
        // Freeze null so admission proceeds on the host-registered model
        // with no temperature/options applied — never reject the prompt hook.
        captured.set(sessionID, { agent: resolved.agent, profile: null });
        awaitingCapture.delete(sessionID);
        prune();
        emitLog('[v2][profile] child session captured without a profile', {
          sessionID,
          agent: resolved.agent,
        });
        return;
      }
      const registered = options.registeredProfiles?.[resolved.agent]?.model;
      if (
        !profile.model ||
        (options.registeredProfiles &&
          resolved.model &&
          !sameModel(resolved.model, registered))
      ) {
        // Nothing to switch, or the host already runs a per-call model.
        captured.set(sessionID, { agent: resolved.agent, profile });
        awaitingCapture.delete(sessionID);
        prune();
        emitLog('[v2][profile] child session captured without a model switch', {
          sessionID,
          agent: resolved.agent,
        });
        return;
      }
      const switchModel = options.session?.switchModel;
      if (typeof switchModel !== 'function') {
        throw new Error('session.switchModel unavailable for runtime profile');
      }
      // Bounded and fail-closed: this rejection propagates to the prompt hook
      // and aborts the admission BEFORE any request can run on the wrong
      // model. The host call cannot be cancelled, but a late switch can only
      // affect a later retry, which re-awaits the same idempotent call.
      await withProfileTimeout(
        switchModel.call(options.session, {
          sessionID,
          model: profile.model,
        }),
        'session profile model switch timed out',
        options.switchTimeoutMs ?? PROFILE_SWITCH_TIMEOUT_MS,
      );
      captured.set(sessionID, { agent: resolved.agent, profile });
      awaitingCapture.delete(sessionID);
      prune();
      emitLog('[v2][profile] applied model to child session', {
        sessionID,
        agent: resolved.agent,
        model: profile.model,
      });
    })();
    pending.set(sessionID, task);
    try {
      await task;
    } finally {
      pending.delete(sessionID);
    }
  }

  return {
    async observeEvent(event) {
      try {
        if (!isRecord(event)) return;
        if (event.type === 'session.deleted') {
          const payload = resolveV2EventPayload(event);
          const deletedID = payload.sessionID ?? payload.id;
          if (typeof deletedID === 'string' && deletedID) {
            captured.delete(deletedID);
            ignored.delete(deletedID);
            awaitingCapture.delete(deletedID);
            pending.delete(deletedID);
            deleted.add(deletedID);
            prune();
          }
          return;
        }
        if (event.type !== 'session.created') return;
        // Flat child early-registration shape carries {id, parentID, agent}.
        const payload = isRecord(event.data)
          ? event.data
          : isRecord(event.properties)
            ? event.properties
            : event;
        const sessionID = payload.sessionID ?? payload.id;
        if (typeof sessionID !== 'string' || !sessionID) return;
        deleted.delete(sessionID);
        // The event payload is authoritative for both fields: an absent
        // parentID here means a root session, absent agent means unknown.
        await ensure(sessionID, {
          parentID: cleanID(payload.parentID),
          agent: cleanID(payload.agent),
          model: payload.model,
        });
      } catch (err) {
        emitLog('[v2][profile] bridge failed', String(err));
      }
    },

    async ensureSessionProfile(sessionID, identity) {
      if (typeof sessionID !== 'string' || !sessionID) return;
      await ensure(sessionID, identity);
    },

    profileForSession(sessionID) {
      return captured.get(sessionID)?.profile ?? undefined;
    },

    fallbackBindingForSession(sessionID) {
      if (typeof sessionID !== 'string' || !sessionID) return undefined;
      const entry = captured.get(sessionID);
      if (entry !== undefined) {
        // Null = frozen with no applicable profile (e.g. marketplace
        // agent): bound with an explicitly empty chain so the caller never
        // falls back to the startup chain.
        if (entry.profile === null) {
          return {
            state: 'bound-child',
            ...(entry.agent ? { agent: entry.agent } : {}),
            entries: [],
            disabled: false,
          };
        }
        // A captured legacy profile without candidate data reads as
        // startup-policy until wiring populates every bound profile.
        if (entry.profile.fallbackChain === undefined) {
          return { state: 'startup-policy' };
        }
        return {
          state: 'bound-child',
          ...(entry.agent ? { agent: entry.agent } : {}),
          entries: entry.profile.fallbackChain,
          disabled: entry.profile.fallbackDisabled ?? false,
        };
      }
      if (awaitingCapture.has(sessionID)) {
        return { state: 'pending-child' };
      }
      return { state: 'startup-policy' };
    },

    size() {
      return captured.size;
    },
  };
}

/**
 * Carry the set of provider-option keys managed by previous profile
 * generations into the next table. Captured session objects are never mutated;
 * each refresh receives fresh profile records and key arrays.
 */
export function reconcileRuntimeProfileOptionKeys(
  previous: V2AgentRuntimeProfiles,
  next: V2AgentRuntimeProfiles,
): V2AgentRuntimeProfiles {
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(next)])].map(
      (agent) => {
        const profile = next[agent] ?? previous[agent];
        const managed = new Set([
          ...(previous[agent]?.managedProviderOptionKeys ?? []),
          ...Object.keys(previous[agent]?.providerOptions ?? {}),
          ...Object.keys(profile.providerOptions ?? {}),
        ]);
        return [
          agent,
          {
            ...profile,
            ...(managed.size > 0
              ? { managedProviderOptionKeys: [...managed].sort() }
              : {}),
          },
        ];
      },
    ),
  );
}

/**
 * Apply a captured profile's temperature/provider options to the context
 * event's mutable `options` record. Only that session's requests are affected;
 * `system`, `messages`, and `tools` are never touched (prompt/tool/prefix
 * bytes stay frozen). Reduced hosts without `options` are left alone.
 */
export function applyRuntimeProfileOptions(
  event: V2SessionContextEvent,
  profile: V2AgentRuntimeProfile | undefined,
): void {
  if (!profile) return;
  const options = (event as { options?: Record<string, unknown> }).options;
  if (!isRecord(options)) return;
  delete options.temperature;
  if (typeof profile.temperature === 'number') {
    options.temperature = profile.temperature;
  }
  for (const key of profile.managedProviderOptionKeys ?? []) {
    delete options[key];
  }
  if (profile.providerOptions) {
    for (const [key, value] of Object.entries(profile.providerOptions)) {
      options[key] = value;
    }
  }
}
