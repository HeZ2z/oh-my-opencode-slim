/**
 * Session-frozen hot-refresh integration: config changes resolve NEW child
 * profiles and the sidebar projection without rebuilding agent definitions or
 * reloading the host registry (AGENTS.md: system prompts and tool sets stay
 * frozen for a session's lifetime). Uses the REAL v1 factory + v2 setup +
 * debounced config-file watcher against a mock host context (not a live host).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { readTuiSnapshot } from '../tui-state';
import { flushLoggerForTesting } from '../utils/logger';
import { createV2Setup } from './setup';
import { makeTestEnv, type TestEnv } from './test-fixtures';
import type { V2Context, V2SessionContextEvent } from './types';

const CHEAP_PLAIN = { explorer: { model: 'openai/gpt-5-mini' } };
const CHEAP_TEMP = {
  explorer: { model: 'openai/gpt-5-mini', temperature: 0.2 },
};
const STRONG_PLAIN = { explorer: { model: 'anthropic/claude-sonnet-4-5' } };
const STRONG_THINKING = {
  explorer: {
    model: 'anthropic/claude-sonnet-4-5',
    options: { thinking: { type: 'enabled' } },
  },
};
/** Both presets present; only the selected `preset` key differs. */
const hot = (preset: string) => ({
  preset,
  presets: { cheap: CHEAP_TEMP, strong: STRONG_THINKING },
});
const plain = (preset: string) => ({
  preset,
  presets: { cheap: CHEAP_PLAIN, strong: STRONG_PLAIN },
});

/** Array-chain configs for the watcher/fallback migration. */
const CHAIN_ABC = {
  companion: { enabled: false },
  agents: { explorer: { model: ['pa/A', 'pb/B', 'pc/C'] } },
};
const CHAIN_XY = {
  companion: { enabled: false },
  agents: { explorer: { model: ['px/X', 'py/Y'] } },
};
const FAILOVER_ERROR = { message: 'rate limit exceeded' };

const created = (sessionID: string, agent = 'explorer', parentID = 'p') => ({
  type: 'session.created',
  data: { sessionID, parentID, agent },
});

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv('omos-v2-hot');
  process.env.XDG_DATA_HOME = path.join(env.configHome, 'data');
  process.env.XDG_CONFIG_HOME = path.join(env.configHome, 'xdg-config');
  process.env.XDG_CACHE_HOME = path.join(env.configHome, 'xdg-cache');
  process.env.OPENCODE_LOG_DIR = path.join(env.configHome, 'logs');
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
});

afterEach(() => {
  env.restore();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await wait(10);
  }
}

interface Harness {
  cleanup: () => void | Promise<void>;
  pushEvent: (event: unknown) => void;
  invokePrompt: (event: Record<string, unknown>) => Promise<void>;
  /** Invoke the v2 session retry hook (in-place steering path). */
  invokeRetry: (event: Record<string, unknown>) => Promise<void>;
  /** Invoke the v2 tool execute.before bridge (delegation model injection). */
  invokeToolBefore: (
    event: Record<string, unknown> & { input: unknown },
  ) => Promise<void>;
  switchCalls: Array<{
    sessionID: string;
    model: { id: string; providerID?: string };
  }>;
  /** Per-session `session.get` overrides (parentID/agent/model). */
  sessionInfos: Map<string, Record<string, unknown>>;
  contextHandler: ((event: V2SessionContextEvent) => Promise<void>) | undefined;
  agentTransformCalls: () => number;
  agentReloadCalls: () => number;
  flushAgentTransform: () => void;
}

/** Live sidebar model projection for the fixture project dir. */
const sidebarModels = () => readTuiSnapshot(env.projectDir).agentModels;

/** Plugin log text for the fixture project (observable failure assertions). */
function pluginLogText(): string {
  const dir = path.join(env.configHome, 'logs');
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      (f) => f.startsWith('oh-my-opencode-slim.') && f.endsWith('.log'),
    );
  } catch {
    return '';
  }
  return files.map((f) => readFileSync(path.join(dir, f), 'utf8')).join('');
}

async function bootHarness(
  deferAgentTransform = false,
  nativeAgents: Record<string, Record<string, unknown>> = {},
): Promise<Harness> {
  const reg = () => ({ dispose() {} });
  /** Transform stub: apply `draft`, then hand back a disposable. */
  const transformWith =
    (draft: unknown) => async (cb: (draft: unknown) => void) => {
      cb(draft);
      return reg();
    };
  const queue: unknown[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const iterator = {
    next: () =>
      new Promise<IteratorResult<unknown>>((resolve) => {
        if (closed) {
          resolve({ value: undefined, done: true });
          return;
        }
        const deliver = () => {
          if (closed) {
            resolve({ value: undefined, done: true });
            return;
          }
          if (queue.length > 0) {
            resolve({ value: queue.shift(), done: false });
          } else {
            wake = deliver;
          }
        };
        deliver();
      }),
    return: () => {
      closed = true;
      wake?.();
      wake = undefined;
      return Promise.resolve({ value: undefined, done: true }) as Promise<
        IteratorResult<unknown>
      >;
    },
  };

  const switchCalls: Array<{
    sessionID: string;
    model: { id: string; providerID?: string };
  }> = [];
  const sessionInfos = new Map<string, Record<string, unknown>>();
  let agentTransformCalls = 0;
  let agentReloadCalls = 0;
  let deferredAgentTransform: ((draft: unknown) => void) | undefined;
  let contextHandler:
    | ((event: V2SessionContextEvent) => Promise<void>)
    | undefined;
  let retryHandler:
    | ((event: Record<string, unknown>) => Promise<void>)
    | undefined;
  let toolBeforeHandler:
    | ((event: Record<string, unknown> & { input: unknown }) => Promise<void>)
    | undefined;
  const promptHandlers: Array<
    (event: Record<string, unknown>) => Promise<void>
  > = [];

  /** Native agent draft exposing the (optional) host agent defaults. */
  const agentDraft = () => ({
    list: () =>
      Object.entries(nativeAgents).map(([id, config]) => ({ id, ...config })),
    get: (id: string) =>
      nativeAgents[id] ? { id, ...nativeAgents[id] } : undefined,
    default: () => {},
    update: () => {},
    remove: () => {},
  });

  const ctx = {
    app: { name: 'opencode', version: 'v2-hot-refresh-test' },
    options: {},
    location: {
      directory: env.projectDir,
      project: {
        id: 'proj_hot',
        directory: env.projectDir,
        canonical: env.projectDir,
      },
    },
    agent: {
      transform: async (cb: (draft: unknown) => void) => {
        agentTransformCalls += 1;
        if (deferAgentTransform) {
          deferredAgentTransform = cb;
        } else {
          cb(agentDraft());
        }
        return reg();
      },
      reload: async () => {
        agentReloadCalls += 1;
      },
      list: async () => [],
    },
    tool: {
      transform: transformWith({ add: () => {} }),
      hook: async (name: string, cb: (event: never) => Promise<void>) => {
        if (name === 'execute.before') {
          toolBeforeHandler = cb as unknown as (
            event: Record<string, unknown> & { input: unknown },
          ) => Promise<void>;
        }
        return reg();
      },
    },
    command: {
      transform: transformWith({ add: () => {} }),
      list: async () => [],
    },
    session: {
      hook: async (
        name: string,
        cb: (event: V2SessionContextEvent) => Promise<void>,
      ) => {
        if (name === 'context') contextHandler = cb;
        if (name === 'prompt') {
          promptHandlers.push(
            cb as unknown as (event: Record<string, unknown>) => Promise<void>,
          );
        }
        if (name === 'retry') {
          retryHandler = cb as unknown as (
            event: Record<string, unknown>,
          ) => Promise<void>;
        }
        return reg();
      },
      // Identity source for the awaited prompt-path capture: children carry
      // a parentID + plugin agent; root/foreign sessions are recognizable.
      // A test may override a session through `sessionInfos`.
      get: async ({ sessionID }: { sessionID: string }) => {
        const override = sessionInfos.get(sessionID);
        if (override) return override;
        return {
          id: sessionID,
          ...(sessionID.startsWith('root') ? {} : { parentID: 'parent-1' }),
          agent: sessionID.startsWith('foreign') ? 'build' : 'explorer',
          ...(sessionID === 'per-call-child' && {
            model: { providerID: 'other', id: 'per-call', variant: 'low' },
          }),
        };
      },
      switchModel: async (input: {
        sessionID: string;
        model: { id: string };
      }) => {
        switchCalls.push(input);
      },
      update: async () => ({}),
    },
    mcp: {
      transform: transformWith({
        list: () => [],
        get: () => undefined,
        set: () => {},
        update: () => {},
        remove: () => {},
      }),
      reload: async () => {},
    },
    event: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }),
    },
  } as unknown as V2Context;

  const cleanup = await createV2Setup()(ctx);

  return {
    cleanup,
    pushEvent: (event: unknown) => {
      if (closed) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    invokePrompt: async (event: Record<string, unknown>) => {
      for (const handler of promptHandlers) {
        await handler(event);
      }
    },
    invokeRetry: async (event: Record<string, unknown>) => {
      await retryHandler?.(event);
    },
    invokeToolBefore: async (
      event: Record<string, unknown> & { input: unknown },
    ) => {
      await toolBeforeHandler?.(event);
    },
    switchCalls,
    sessionInfos,
    get contextHandler() {
      return contextHandler;
    },
    agentTransformCalls: () => agentTransformCalls,
    agentReloadCalls: () => agentReloadCalls,
    flushAgentTransform: () => {
      deferredAgentTransform?.(agentDraft());
    },
  };
}

/** Boots the harness, runs `body`, and always cleans it up. */
async function withHarness(
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await bootHarness();
  try {
    await body(harness);
  } finally {
    await harness.cleanup();
  }
}

function createChildEvent(sessionID: string): Record<string, unknown> {
  return {
    type: 'session.created',
    data: { sessionID, parentID: 'parent-1', agent: 'explorer' },
  };
}

/** Push probe children until one captures a seeded profile. */
async function captureFirstChild(
  harness: Harness,
  idPrefix: string,
): Promise<string> {
  for (let index = 0; index < 60; index += 1) {
    const id = `${idPrefix}-${index}`;
    harness.pushEvent(createChildEvent(id));
    await wait(15);
    if (harness.switchCalls.some((call) => call.sessionID === id)) {
      return id;
    }
  }
  throw new Error('no child captured a profile');
}

describe('v2 session-frozen hot refresh', () => {
  test('session profile bridge sees plugin agents after deferred agent transform', async () => {
    env.writeUserConfig(hot('cheap'));
    const harness = await bootHarness(true);
    try {
      harness.pushEvent(createChildEvent('early-deferred-child'));
      await wait(50);
      harness.flushAgentTransform();
      await harness.invokePrompt({
        sessionID: 'early-deferred-child',
        messageID: 'msg_deferred_agent',
        prompt: { text: 'capture deferred agent profile' },
      });

      expect(harness.switchCalls).toEqual([
        {
          sessionID: 'early-deferred-child',
          model: { providerID: 'openai', id: 'gpt-5-mini' },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  }, 20_000);

  test('config edit refreshes new-child profiles and sidebar without touching frozen surfaces', async () => {
    env.writeUserConfig(hot('cheap'));

    await withHarness(async (harness) => {
      expect(sidebarModels().explorer).toBe('openai/gpt-5-mini');

      // A child created before the edit captures the initial profile.
      const firstChild = await captureFirstChild(harness, 'first');
      const firstSwitch = harness.switchCalls.find(
        (call) => call.sessionID === firstChild,
      );
      expect(firstSwitch?.model.id).toBe('gpt-5-mini');

      // Root and foreign-agent sessions mixed into the same event stream stay
      // untouched while the first child captures its profile (isolated
      // unit coverage lives in runtime-profiles.test.ts).
      harness.pushEvent({
        type: 'session.created',
        data: { sessionID: 'root-1', agent: 'explorer' },
      });
      harness.pushEvent({
        type: 'session.created',
        data: { sessionID: 'foreign-1', parentID: 'parent-1', agent: 'build' },
      });
      await wait(80);
      expect(
        harness.switchCalls.some(
          (call) =>
            call.sessionID === 'root-1' || call.sessionID === 'foreign-1',
        ),
      ).toBe(false);

      // Manual config edit: the watcher refreshes profiles + sidebar only.
      env.writeUserConfig(hot('strong'));
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );

      // The existing child is NOT re-switched...
      const switchCountBefore = harness.switchCalls.filter(
        (call) => call.sessionID === firstChild,
      ).length;
      harness.pushEvent(createChildEvent(firstChild));
      await wait(60);
      expect(
        harness.switchCalls.filter((call) => call.sessionID === firstChild),
      ).toHaveLength(switchCountBefore);

      // ...while a NEW child gets the fresh profile/options.
      const secondChild = await captureFirstChild(harness, 'second');
      const secondSwitch = harness.switchCalls.find(
        (call) => call.sessionID === secondChild,
      );
      expect(secondSwitch?.model.id).toBe('claude-sonnet-4-5');

      const contextHandler = harness.contextHandler;
      expect(contextHandler).toBeDefined();
      const options: Record<string, unknown> = {};
      await contextHandler?.({
        sessionID: firstChild,
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      // First child applies its frozen temperature, not the new profile.
      expect(options.temperature).toBe(0.2);
      expect(options.thinking).toBeUndefined();

      await contextHandler?.({
        sessionID: secondChild,
        agent: 'explorer',
        model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect((options as { thinking?: unknown }).thinking).toEqual({
        type: 'enabled',
      });
      expect(options.temperature).toBeUndefined();

      // Frozen surfaces: agents registered ONCE and never reloaded globally.
      expect(harness.agentTransformCalls()).toBe(1);
      expect(harness.agentReloadCalls()).toBe(0);
    });
  }, 20_000);

  test('disposal stops watching: no refresh or child capture afterwards', async () => {
    env.writeUserConfig(plain('cheap'));
    const harness = await bootHarness();
    await captureFirstChild(harness, 'pre');

    await harness.cleanup();
    const switchCount = harness.switchCalls.length;

    env.writeUserConfig(plain('strong'));
    await wait(400);

    harness.pushEvent(createChildEvent('post-dispose-child'));
    await wait(100);

    expect(harness.switchCalls).toHaveLength(switchCount);
  }, 20_000);

  test('first prompt captures and switches before session.created; a refresh keeps the captured profile', async () => {
    env.writeUserConfig(hot('cheap'));

    await withHarness(async (harness) => {
      await harness.invokePrompt({
        sessionID: 'per-call-child',
        messageID: 'msg_per_call',
        prompt: { text: 'keep the per-call model' },
      });
      expect(harness.switchCalls).toEqual([]);
      // The host fires the prompt hook BEFORE any session.created event for
      // the child: the awaited request-path capture must still switch the
      // model and freeze the profile before the first request.
      await harness.invokePrompt({
        sessionID: 'race-child',
        messageID: 'msg_1',
        prompt: { text: 'start' },
      });
      expect(harness.switchCalls).toEqual([
        {
          sessionID: 'race-child',
          model: { providerID: 'openai', id: 'gpt-5-mini' },
        },
      ]);

      const options: Record<string, unknown> = {};
      await harness.contextHandler?.({
        sessionID: 'race-child',
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect(options.temperature).toBe(0.2);

      // A config refresh replaces the table for NEW children only.
      env.writeUserConfig(hot('strong'));
      await waitFor(
        () => sidebarModels().explorer === 'anthropic/claude-sonnet-4-5',
      );

      // Replayed prompt + the (delayed) session.created event for the
      // existing child must neither re-switch nor re-freeze it.
      await harness.invokePrompt({
        sessionID: 'race-child',
        messageID: 'msg_2',
        prompt: { text: 'more' },
      });
      harness.pushEvent(createChildEvent('race-child'));
      await wait(80);
      expect(
        harness.switchCalls.filter((call) => call.sessionID === 'race-child'),
      ).toHaveLength(1);

      const optionsAfter: Record<string, unknown> = {};
      await harness.contextHandler?.({
        sessionID: 'race-child',
        agent: 'explorer',
        model: { id: 'gpt-5-mini', providerID: 'openai' },
        options: optionsAfter,
        system: [{ type: 'text', text: 'frozen system' }],
        messages: [],
        tools: {},
      } as unknown as V2SessionContextEvent);
      expect(optionsAfter.temperature).toBe(0.2);
      expect(optionsAfter.thinking).toBeUndefined();

      // A child first seen after the refresh gets the fresh profile.
      const secondChild = await captureFirstChild(harness, 'race-second');
      const secondSwitch = harness.switchCalls.find(
        (call) => call.sessionID === secondChild,
      );
      expect(secondSwitch?.model.id).toBe('claude-sonnet-4-5');
    });
  }, 20_000);
});

describe('v2 hot-refresh integration: watcher, capture, delegation', () => {
  const switchModels = (harness: Harness, sessionID: string) =>
    harness.switchCalls
      .filter((call) => call.sessionID === sessionID)
      .map((call) => call.model);
  const retryFail = (
    harness: Harness,
    sessionID: string,
    provider: string,
    id: string,
  ) =>
    harness.invokeRetry({
      sessionID,
      agent: 'explorer',
      model: { providerID: provider, id },
      error: FAILOVER_ERROR,
    });

  const projectConfigPath = () =>
    path.join(env.projectDir, '.opencode', 'oh-my-opencode-slim.json');

  test('real watcher [A,B,C]->[X,Y]: old child keeps its captured chain, new child uses the refreshed chain, LKG on invalid config, delegation follows the published candidates', async () => {
    env.writeProjectConfig(CHAIN_ABC);

    await withHarness(async (harness) => {
      await waitFor(() => sidebarModels().explorer === 'pa/A');

      // Old child: created capture freezes A with the [A,B,C] entry.
      harness.sessionInfos.set('child-old', {
        parentID: 'p',
        agent: 'explorer',
      });
      harness.pushEvent(created('child-old'));
      await waitFor(() => switchModels(harness, 'child-old').length >= 1);
      expect(switchModels(harness, 'child-old')).toEqual([
        { providerID: 'pa', id: 'A' },
      ]);
      // A fails -> B (captured chain).
      await retryFail(harness, 'child-old', 'pa', 'A');
      expect(switchModels(harness, 'child-old')).toEqual([
        { providerID: 'pa', id: 'A' },
        { providerID: 'pb', id: 'B' },
      ]);

      // Refresh through the real debounced watcher.
      env.writeProjectConfig(CHAIN_XY);
      await waitFor(() => sidebarModels().explorer === 'px/X', 15_000);

      // New child: first capture after refresh freezes X.
      harness.sessionInfos.set('child-new', {
        parentID: 'p',
        agent: 'explorer',
      });
      harness.pushEvent(created('child-new'));
      await waitFor(() => switchModels(harness, 'child-new').length >= 1);
      expect(switchModels(harness, 'child-new')).toEqual([
        { providerID: 'px', id: 'X' },
      ]);
      // X fails -> Y: never the stale A/B/C.
      await retryFail(harness, 'child-new', 'px', 'X');
      expect(switchModels(harness, 'child-new')).toEqual([
        { providerID: 'px', id: 'X' },
        { providerID: 'py', id: 'Y' },
      ]);

      // Old child keeps its captured chain: B fails -> C (tried retained).
      await retryFail(harness, 'child-old', 'pb', 'B');
      expect(switchModels(harness, 'child-old')).toEqual([
        { providerID: 'pa', id: 'A' },
        { providerID: 'pb', id: 'B' },
        { providerID: 'pc', id: 'C' },
      ]);

      // Delegation reads the published candidates: child-new runs py/Y with
      // px down, so a fresh explorer dispatch selects py/Y.
      const toolEvent = {
        tool: 'subagent',
        sessionID: 'child-new',
        id: 'call-1',
        input: { agent: 'explorer', prompt: 'go' },
      };
      await harness.invokeToolBefore(toolEvent);
      expect((toolEvent.input as { model?: unknown }).model).toBe('py/Y');

      // Invalid config: builder fails honestly; last-known-good held. Wait for
      // the OBSERVABLE failure, not a fixed sleep.
      writeFileSync(projectConfigPath(), '{ not json');
      const deadline = Date.now() + 15_000;
      for (;;) {
        await flushLoggerForTesting();
        if (pluginLogText().includes('config load failed')) break;
        if (Date.now() > deadline) {
          throw new Error('config refresh failure was never observed');
        }
        await wait(20);
      }
      expect(sidebarModels().explorer).toBe('px/X');
      harness.sessionInfos.set('child-after', {
        parentID: 'p',
        agent: 'explorer',
      });
      harness.pushEvent(created('child-after'));
      await waitFor(() => switchModels(harness, 'child-after').length >= 1);
      expect(switchModels(harness, 'child-after')).toEqual([
        { providerID: 'px', id: 'X' },
      ]);
      // The last-known-good chain survives too: X fails -> Y.
      await retryFail(harness, 'child-after', 'px', 'X');
      expect(switchModels(harness, 'child-after')).toEqual([
        { providerID: 'px', id: 'X' },
        { providerID: 'py', id: 'Y' },
      ]);

      // Frozen surfaces: registered once, never reloaded globally.
      expect(harness.agentTransformCalls()).toBe(1);
      expect(harness.agentReloadCalls()).toBe(0);
    });
  }, 60_000);

  test('setup returns before deferred finalize; a config edit before finalize never publishes an incomplete table', async () => {
    env.writeProjectConfig(CHAIN_ABC);
    const harness = await bootHarness(true, {
      explorer: { model: { providerID: 'pa', id: 'A' } },
    });
    try {
      // No publish before finalize (the builder refuses a partial roster).
      expect(sidebarModels().explorer).toBeUndefined();
      env.writeProjectConfig(CHAIN_XY);
      // Wait for the OBSERVABLE refusal (registry not finalized) instead of a
      // fixed sleep, so the assertion cannot pass before the watcher ran.
      const refusalDeadline = Date.now() + 15_000;
      for (;;) {
        await flushLoggerForTesting();
        if (pluginLogText().includes('agent registry not finalized')) break;
        if (Date.now() > refusalDeadline) {
          throw new Error('pre-finalize refresh refusal was never observed');
        }
        await wait(20);
      }
      expect(sidebarModels().explorer).toBeUndefined();

      // Deferred finalize publishes the complete startup table from the host
      // agent draft defaults, proving setup never awaited the callback.
      harness.flushAgentTransform();
      await waitFor(() => sidebarModels().explorer === 'pa/A');
      expect(harness.agentReloadCalls()).toBe(0);
    } finally {
      await harness.cleanup();
    }
  }, 30_000);

  test('capture compares the ACTUAL host agent draft default, not a re-parsed plugin config', async () => {
    // The host draft registers explorer on host/A while the plugin config
    // offers the pa/A..pc/C chain: the registered default must come from the
    // finalized host projection (host/A), not from re-parsing the plugin
    // config (pa/A). A child still on host/A is therefore the DEFAULT (switch
    // called), whereas the re-parsed baseline would treat host/A as an
    // unrelated per-call model and skip the switch.
    env.writeProjectConfig(CHAIN_ABC);
    const harness = await bootHarness(false, {
      explorer: { model: { providerID: 'host', id: 'A' } },
    });
    try {
      await waitFor(() => sidebarModels().explorer === 'host/A');

      // Refresh the plugin chain to [X,Y]; the host model override still wins.
      env.writeProjectConfig(CHAIN_XY);
      const refreshDeadline = Date.now() + 15_000;
      for (;;) {
        await flushLoggerForTesting();
        const refreshed =
          pluginLogText().match(/runtime profiles refreshed from disk/g)
            ?.length ?? 0;
        if (refreshed >= 2) break;
        if (Date.now() > refreshDeadline) {
          throw new Error('watcher refresh was never observed');
        }
        await wait(20);
      }
      expect(sidebarModels().explorer).toBe('host/A');

      harness.sessionInfos.set('child-reg', {
        parentID: 'p',
        agent: 'explorer',
        model: { providerID: 'host', id: 'A' },
      });
      await harness.invokePrompt({
        sessionID: 'child-reg',
        messageID: 'msg-reg',
        prompt: { text: 'hi' },
      });
      expect(switchModels(harness, 'child-reg')).toEqual([
        { providerID: 'host', id: 'A' },
      ]);
      expect(harness.agentReloadCalls()).toBe(0);
    } finally {
      await harness.cleanup();
    }
  }, 30_000);
});
