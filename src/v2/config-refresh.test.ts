import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OhMyOpenCodeLite } from '../index';
import { MarketplaceStore } from '../marketplace/store';
import { readTuiSnapshot } from '../tui-state';
import { makeTestEnv, type TestEnv } from './test-fixtures';

const DEEPSEEK_CHEAP = {
  explorer: {
    model: 'opencode-go/deepseek-v4.1-flash',
    temperature: 0.2,
    options: { thinking: { type: 'enabled' } },
  },
};
const SONNET_STRONG = {
  explorer: { model: 'anthropic/claude-sonnet-4-5', variant: 'thinking' },
};
/** Both presets present; only the selected `preset` key differs. */
const withPreset = (preset: string) => ({
  preset,
  presets: { cheap: DEEPSEEK_CHEAP, strong: SONNET_STRONG },
});
const CHEAP_DEEPSEEK = {
  preset: 'cheap',
  presets: {
    cheap: { explorer: { model: 'opencode-go/deepseek-v4.1-flash' } },
  },
};
/** Array-model chain config (issue #1527 batch 2: [A,B,C] startup chain). */
const CHAIN_ABC = {
  agents: { explorer: { model: ['pa/A', 'pb/B', 'pc/C'] } },
};
const CHAIN_XY = {
  agents: { explorer: { model: ['px/X', 'py/Y'] } },
};

type InferenceTable = {
  profiles: Record<
    string,
    {
      model?: { providerID: string; id: string; variant?: string };
      temperature?: number;
      providerOptions?: Record<string, unknown>;
      fallbackChain?: Array<{ id: string; variant?: string }>;
      fallbackDisabled?: boolean;
      inheritModelFrom?: string;
      sidebarModel: string;
      sidebarVariant?: string;
    }
  >;
  projection: {
    agentModels: Record<string, string>;
    agentVariants: Record<string, string>;
  };
};

type RefreshHook = (options?: {
  allowInvalidFallback?: boolean;
}) => Promise<
  { ok: true; table: InferenceTable } | { ok: false; reason: string }
>;
type PublishHook = (table: InferenceTable) => {
  profiles: InferenceTable['profiles'];
  sidebarOk: boolean;
};
type ReadHook = () => InferenceTable['profiles'] | undefined;
type DelegatedHook = (input: {
  agentType: string;
  parentSessionID: string;
}) => string | undefined;
type RetryHook = (
  event: {
    sessionID: string;
    agent?: string;
    model: { providerID: string; id: string };
    error: unknown;
    decision?: { retry: boolean; delay?: number };
  },
  switchModel: (
    sessionID: string,
    model: { providerID: string; id: string },
  ) => Promise<unknown>,
) => Promise<void>;

/** Live sidebar projections for the fixture project dir. */
const sidebarModels = () => readTuiSnapshot(env.projectDir).agentModels;

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv('omos-v2cr');
});

afterEach(() => {
  env.restore();
});

function createPluginClient() {
  const noop = async () => ({});
  const session = new Proxy({}, { get: () => noop }) as Record<string, unknown>;
  return new Proxy(
    { app: { log: noop }, session },
    {
      get: (target, property) =>
        property in target
          ? target[property as keyof typeof target]
          : new Proxy({}, { get: () => noop }),
    },
  );
}

async function bootFactory(options?: { hostFlavor?: string }) {
  const hooks = await OhMyOpenCodeLite({
    client: createPluginClient(),
    directory: env.projectDir,
    worktree: env.projectDir,
    serverUrl: new URL('http://127.0.0.1:4096'),
    ...(options?.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as never);
  // The host calls the config hook once at init; mirror that so the initial
  // registry/tui-state snapshot exists (startup inference table published).
  await hooks.config?.({} as never);
  const extra = hooks as unknown as {
    'v2.refreshProfiles'?: RefreshHook;
    'v2.publishInference'?: PublishHook;
    'v2.readPublishedInference'?: ReadHook;
    'v2.resolveDelegatedModel'?: DelegatedHook;
    'v2.session.retry'?: RetryHook;
  };
  if (!extra['v2.refreshProfiles'])
    throw new Error('v2.refreshProfiles hook missing');
  if (!extra['v2.publishInference'])
    throw new Error('v2.publishInference hook missing');
  if (!extra['v2.readPublishedInference'])
    throw new Error('v2.readPublishedInference hook missing');
  return {
    hooks,
    refresh: extra['v2.refreshProfiles'],
    publish: extra['v2.publishInference'],
    readPublished: extra['v2.readPublishedInference'],
    resolveDelegatedModel: extra['v2.resolveDelegatedModel'],
    retry: extra['v2.session.retry'],
  };
}

/** Boots the factory, runs `body`, and always disposes the hooks. */
async function withFactory(
  body: (fac: Awaited<ReturnType<typeof bootFactory>>) => Promise<void>,
  options?: { hostFlavor?: string },
): Promise<void> {
  const fac = await bootFactory(options);
  try {
    await body(fac);
  } finally {
    await fac.hooks.dispose?.();
  }
}

/** Build-then-publish helper: the runner-apply path in one call. */
async function refreshAndPublish(
  fac: Awaited<ReturnType<typeof bootFactory>>,
  options?: { allowInvalidFallback?: boolean },
) {
  const built = await fac.refresh(options);
  if (!built.ok) return built;
  const res = fac.publish(built.table);
  return { ...built, published: res };
}

describe('v2 profile refresh hook', () => {
  test('re-reads the config, resolves profiles, and rewrites the sidebar model entries', async () => {
    env.writeUserConfig(withPreset('cheap'));

    await withFactory(async (fac) => {
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');

      // Preset manager Save & Apply rewrites the file; the refresh hook is
      // what the watcher / direct call runs afterwards.
      env.writeUserConfig(withPreset('strong'));
      const built = await fac.refresh();

      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error(built.reason);
      // The builder resolves without touching the sidebar (publish does).
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');
      expect(built.table.profiles.explorer?.model).toEqual({
        providerID: 'anthropic',
        id: 'claude-sonnet-4-5',
        variant: 'thinking',
      });
      expect(built.table.profiles.explorer?.sidebarModel).toBe(
        'anthropic/claude-sonnet-4-5',
      );

      const res = fac.publish(built.table);
      expect(res.sidebarOk).toBe(true);
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');
      expect(readTuiSnapshot(env.projectDir).agentVariants.explorer).toBe(
        'thinking',
      );
    });
  });

  test('resolves temperature and provider options for captured profiles', async () => {
    env.writeUserConfig({
      preset: 'cheap',
      presets: {
        cheap: {
          explorer: {
            model: 'opencode-go/deepseek-v4.1-flash',
            temperature: 0.25,
            options: { thinking: { type: 'enabled', budgetTokens: 4096 } },
          },
        },
      },
    });

    await withFactory(async (fac) => {
      const built = await fac.refresh();
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error(built.reason);
      expect(built.table.profiles.explorer?.temperature).toBe(0.25);
      expect(built.table.profiles.explorer?.providerOptions).toEqual({
        thinking: { type: 'enabled', budgetTokens: 4096 },
      });
    });
  });

  test('picks up manual project-config edits', async () => {
    env.writeUserConfig({});
    env.writeProjectConfig({
      preset: 'project-local',
      presets: {
        'project-local': { oracle: { model: 'openai/gpt-5-mini' } },
      },
    });

    await withFactory(async (fac) => {
      expect(sidebarModels().oracle).toBe('openai/gpt-5-mini');

      env.writeProjectConfig({
        preset: 'project-local',
        presets: {
          'project-local': { oracle: { model: 'openai/o3' } },
        },
      });
      const refreshed = await refreshAndPublish(fac);

      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok || !('published' in refreshed))
        throw new Error('expected a published refresh');
      expect(refreshed.table.profiles.oracle?.model).toEqual({
        providerID: 'openai',
        id: 'o3',
      });
      expect(sidebarModels().oracle).toBe('openai/o3');
    });
  });

  test('keeps host opencode.json agent overrides across a refresh', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);
    const hooks = await OhMyOpenCodeLite({
      client: createPluginClient(),
      directory: env.projectDir,
      worktree: env.projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      // The host layer wins the shallow merge (same as at init).
      await hooks.config?.({
        agent: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
      } as never);
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');

      const refresh = (
        hooks as unknown as { 'v2.refreshProfiles'?: RefreshHook }
      )['v2.refreshProfiles'];
      const publish = (
        hooks as unknown as { 'v2.publishInference'?: PublishHook }
      )['v2.publishInference'];
      const built = await refresh?.();

      expect(built?.ok).toBe(true);
      if (!built?.ok) throw new Error(built?.reason);
      expect(built.table.profiles.explorer?.model).toEqual({
        providerID: 'anthropic',
        id: 'claude-sonnet-4-5',
      });
      publish?.(built.table);
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('does not rebuild agent definitions or mutate session-frozen surfaces', async () => {
    env.writeUserConfig({
      preset: 'cheap',
      presets: {
        cheap: {
          explorer: {
            model: 'opencode-go/deepseek-v4.1-flash',
            prompt: 'You are a custom explorer.',
            permission: { edit: 'deny' },
          },
        },
      },
    });

    await withFactory(async ({ hooks, refresh }) => {
      const beforeAgentDefs = JSON.stringify(hooks.agent?.explorer);
      env.writeUserConfig({
        preset: 'cheap',
        presets: {
          cheap: {
            explorer: {
              model: 'anthropic/claude-sonnet-4-5',
              prompt: 'You are a DIFFERENT explorer.',
              permission: { edit: 'allow' },
            },
          },
        },
      });
      await refresh();

      // Prompt/permission surfaces stay frozen: the refresh only resolves
      // the inference profile (the v2 adapter never re-registers agents).
      expect(JSON.stringify(hooks.agent?.explorer)).toBe(beforeAgentDefs);
    });
  });

  test('malformed JSON is a hard refresh failure: last-good sidebar (and profiles) retained', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async (fac) => {
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');

      fs.writeFileSync(env.userConfigPath, '{ not json');
      const built = await fac.refresh();

      expect(built.ok).toBe(false);
      if (built.ok) throw new Error('expected a hard failure');
      expect(built.reason).toContain('invalid-json');
      // No swap and no sidebar write: the builder commits nothing; the
      // last-known-good sidebar model entry survives without any publish.
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');
      expect(fac.readPublished()?.explorer?.model).toEqual({
        providerID: 'opencode-go',
        id: 'deepseek-v4.1-flash',
      });
    });
  });

  test('startup can seed fallback profiles before any last-good table exists', async () => {
    fs.writeFileSync(env.userConfigPath, '{ not json');
    const { refresh } = await bootFactory();

    const result = await refresh({ allowInvalidFallback: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.table.profiles).length).toBeGreaterThan(0);
      expect(result.table.profiles.explorer).toBeDefined();
    }
  });

  test('schema-invalid config is a hard refresh failure: last-good sidebar retained', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async (fac) => {
      env.writeUserConfig({
        preset: 'cheap',
        presets: {
          // `temperature` must be a number: schema rejection.
          cheap: {
            explorer: { model: 'openai/gpt-5-mini', temperature: 'hot' },
          },
        },
      });
      const built = await fac.refresh();

      expect(built.ok).toBe(false);
      if (built.ok) throw new Error('expected a hard failure');
      expect(built.reason).toContain('invalid-schema');
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');
    });
  });

  test('warning-only kinds (missing preset) do not fail the refresh', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async (fac) => {
      env.writeUserConfig({
        preset: 'ghost', // missing-preset warning, not a hard failure
        presets: {
          cheap: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
        },
      });
      const built = await fac.refresh();

      // The selected preset is missing (defaults apply) — a warning, not
      // malformed config.
      expect(built.ok).toBe(true);
    });
  });

  test('refresh preserves marketplace agents in the sidebar roster', async () => {
    // Isolate the marketplace store for this test (test-isolation also sets
    // XDG_DATA_HOME, but a per-test root avoids cross-test package leakage).
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-v2cr-data-'));
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      new MarketplaceStore({ pluginVersion: '3.0.2' }).install({
        manifest: {
          schemaVersion: 2,
          id: 'team/market',
          version: '1.0.0',
          displayName: 'market-agent',
          description: 'Marketplace agent for refresh regression',
          agentName: 'market-agent',
          prompt: 'Marketplace prompt',
          skills: [],
          mcps: [],
          tools: ['read'],
          author: { name: 'Test author' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=1.0.0' },
          model: {
            source: 'explicit',
            candidates: ['provider/package', 'provider/fallback'],
          },
          routing: {
            description: 'Marketplace lane',
            when: 'Marketplace task',
            keywords: ['marketplace'],
          },
        },
      } as never);
      env.writeUserConfig({
        preset: 'market',
        presets: { market: { marketplace: { agents: ['team/market'] } } },
      });

      await withFactory(async (fac) => {
        // Registry path wrote the full roster (core + marketplace).
        expect(sidebarModels()['market-agent']).toBeDefined();

        const built = await fac.refresh();
        expect(built.ok).toBe(true);
        if (!built.ok) throw new Error(built.reason);
        // The rebuilt table must populate the finalized roster: a missing
        // marketplace profile must not silently lose its chain.
        expect(built.table.profiles['market-agent']?.fallbackChain).toEqual([
          { id: 'provider/package' },
          { id: 'provider/fallback' },
        ]);

        fac.publish(built.table);
        // The refresh must not clobber the marketplace roster entry.
        expect(sidebarModels()['market-agent']).toBeDefined();
      });
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('v2 inference table (issue #1527 batch 2)', () => {
  test('refresh updates the primary model and clears stale variant/temperature/options', async () => {
    env.writeUserConfig({
      agents: {
        explorer: {
          model: 'pa/A',
          variant: 'v1',
          temperature: 0.5,
          options: { thinking: { type: 'enabled' } },
        },
      },
    });

    await withFactory(async (fac) => {
      const before = await refreshAndPublish(fac);
      expect(before.ok).toBe(true);
      if (!before.ok || !('published' in before))
        throw new Error('expected a published refresh');
      const first = before.table.profiles.explorer;
      expect(first?.model).toEqual({
        providerID: 'pa',
        id: 'A',
        variant: 'v1',
      });
      expect(first?.temperature).toBe(0.5);
      expect(first?.providerOptions).toEqual({ thinking: { type: 'enabled' } });
      expect(first?.sidebarVariant).toBe('v1');
      expect(readTuiSnapshot(env.projectDir).agentVariants.explorer).toBe('v1');

      // Remove variant/temperature/options and change the model: the fresh
      // registry must not carry the old fields forward, and the sidebar must
      // not keep the stale variant from the previous projection.
      env.writeUserConfig({ agents: { explorer: { model: 'px/X' } } });
      const after = await refreshAndPublish(fac);
      expect(after.ok).toBe(true);
      if (!after.ok || !('published' in after))
        throw new Error('expected a published refresh');
      const second = after.table.profiles.explorer;
      expect(second?.model).toEqual({ providerID: 'px', id: 'X' });
      expect(second?.temperature).toBeUndefined();
      expect(second?.providerOptions).toBeUndefined();
      expect(second?.sidebarVariant).toBeUndefined();
      expect(
        readTuiSnapshot(env.projectDir).agentVariants.explorer,
      ).toBeUndefined();
    });
  });

  test('an explicit one-entry model array survives refresh (observed outside configured)', async () => {
    env.writeUserConfig({
      agents: { explorer: { model: ['px/X', 'py/Y'] } },
    });

    await withFactory(async (fac) => {
      const before = await refreshAndPublish(fac);
      expect(before.ok).toBe(true);
      if (!before.ok || !('published' in before))
        throw new Error('expected a published refresh');
      expect(before.table.profiles.explorer?.fallbackChain).toEqual([
        { id: 'px/X' },
        { id: 'py/Y' },
      ]);

      // Explicit one-entry array: an observed model outside it is a legitimate
      // dynamic-head descent, so the configured entry must stay a chain.
      env.writeUserConfig({ agents: { explorer: { model: ['py/Y'] } } });
      const after = await refreshAndPublish(fac);
      expect(after.ok).toBe(true);
      if (!after.ok || !('published' in after))
        throw new Error('expected a published refresh');
      expect(after.table.profiles.explorer?.fallbackChain).toEqual([
        { id: 'py/Y' },
      ]);
    });
  });

  test('refresh recomputes marketplace candidates after the owner override is removed', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-v2cr-mkt-'));
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      new MarketplaceStore({ pluginVersion: '3.0.2' }).install({
        manifest: {
          schemaVersion: 2,
          id: 'team/mkt',
          version: '1.0.0',
          displayName: 'mkt-agent',
          description: 'Marketplace agent for override regression',
          agentName: 'mkt-agent',
          prompt: 'Marketplace prompt',
          skills: [],
          mcps: [],
          tools: ['read'],
          author: { name: 'Test author' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=1.0.0' },
          model: {
            source: 'explicit',
            candidates: ['pkg/one', 'pkg/two'],
          },
          routing: {
            description: 'Marketplace lane',
            when: 'Marketplace task',
            keywords: ['marketplace'],
          },
        },
      } as never);
      const withOverride = {
        preset: 'market',
        presets: { market: { marketplace: { agents: ['team/mkt'] } } },
        agents: { 'mkt-agent': { model: ['owner/A', 'owner/B'] } },
      };
      env.writeUserConfig(withOverride);

      await withFactory(async (fac) => {
        const before = await refreshAndPublish(fac);
        expect(before.ok).toBe(true);
        if (!before.ok || !('published' in before))
          throw new Error('expected a published refresh');
        expect(
          before.table.profiles['mkt-agent']?.fallbackChain?.map((c) => c.id),
        ).toEqual(['owner/A', 'owner/B']);

        // Remove the owner override: the fresh registry recomputation must
        // return the package defaults, not the stale startup candidates.
        env.writeUserConfig({
          preset: 'market',
          presets: { market: { marketplace: { agents: ['team/mkt'] } } },
        });
        const after = await refreshAndPublish(fac);
        expect(after.ok).toBe(true);
        if (!after.ok || !('published' in after))
          throw new Error('expected a published refresh');
        expect(after.table.profiles['mkt-agent']?.model).toEqual({
          providerID: 'pkg',
          id: 'one',
        });
        expect(
          after.table.profiles['mkt-agent']?.fallbackChain?.map((c) => c.id),
        ).toEqual(['pkg/one', 'pkg/two']);
      });
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('array chains publish fallback candidates with variants and inheritance', async () => {
    env.writeUserConfig({
      agents: {
        explorer: {
          model: ['pa/A', { id: 'pb/B', variant: 'max' }, 'pc/C'],
          inheritModelFrom: 'session',
        },
      },
    });

    await withFactory(async (fac) => {
      const built = await fac.refresh();
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error(built.reason);
      expect(built.table.profiles.explorer?.fallbackChain).toEqual([
        { id: 'pa/A' },
        { id: 'pb/B', variant: 'max' },
        { id: 'pc/C' },
      ]);
      expect(built.table.profiles.explorer?.fallbackDisabled).toBe(false);
      expect(built.table.profiles.explorer?.inheritModelFrom).toBe('session');

      const res = fac.publish(built.table);
      expect(res.sidebarOk).toBe(true);
      // The published table is readable through the shared reference.
      expect(fac.readPublished()?.explorer?.fallbackChain).toEqual(
        built.table.profiles.explorer?.fallbackChain,
      );
      expect(fac.readPublished()?.explorer?.inheritModelFrom).toBe('session');
    });
  });

  test('host scalar override disables the chain without resurrecting it on refresh', async () => {
    env.writeUserConfig(CHAIN_ABC);
    const hooks = await OhMyOpenCodeLite({
      client: createPluginClient(),
      directory: env.projectDir,
      worktree: env.projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    try {
      // Host-persisted scalar model differs from the chain head: the
      // disableChain constraint latches at finalize.
      await hooks.config?.({
        agent: { explorer: { model: 'other/X' } },
      } as never);
      const extra = hooks as unknown as {
        'v2.readPublishedInference'?: ReadHook;
        'v2.refreshProfiles'?: RefreshHook;
        'v2.publishInference'?: PublishHook;
      };
      expect(
        extra['v2.readPublishedInference']?.()?.explorer?.fallbackDisabled,
      ).toBe(true);

      // A later refresh keeps the chain AND the disabled flag.
      const built = await extra['v2.refreshProfiles']?.();
      expect(built?.ok).toBe(true);
      if (!built?.ok) throw new Error(built?.reason);
      expect(
        built.table.profiles.explorer?.fallbackChain?.map((c) => c.id),
      ).toEqual(['pa/A', 'pb/B', 'pc/C']);
      expect(built.table.profiles.explorer?.fallbackDisabled).toBe(true);
      extra['v2.publishInference']?.(built.table);
      expect(
        extra['v2.readPublishedInference']?.()?.explorer?.fallbackDisabled,
      ).toBe(true);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('v2 delegation reads the published table, not the startup chain', async () => {
    env.writeUserConfig(CHAIN_ABC);

    await withFactory(
      async (fac) => {
        if (!fac.retry || !fac.resolveDelegatedModel)
          throw new Error('delegation hooks missing');
        // Parent fails on px/X (outside the fresh startup chain [A,B,C]):
        // dynamic head, so it steers to pa/A and records px as down.
        const switches: Array<unknown> = [];
        await fac.retry(
          {
            sessionID: 'p1',
            agent: 'explorer',
            model: { providerID: 'px', id: 'X' },
            error: { message: 'rate limit exceeded' },
          },
          async (_id, model) => {
            switches.push(model);
            return {};
          },
        );
        expect(switches).toEqual([{ providerID: 'pa', id: 'A' }]);
        // Startup table: primary pa is not down → no delegation.
        expect(
          fac.resolveDelegatedModel({
            agentType: 'explorer',
            parentSessionID: 'p1',
          }),
        ).toBeUndefined();

        // Refresh to [X,Y] and publish: delegation follows the new table.
        env.writeUserConfig(CHAIN_XY);
        const refreshed = await refreshAndPublish(fac);
        expect(refreshed.ok).toBe(true);
        expect(
          fac.resolveDelegatedModel({
            agentType: 'explorer',
            parentSessionID: 'p1',
          }),
        ).toBe('py/Y');
      },
      { hostFlavor: 'v2' },
    );
  });

  test('installed marketplace content is frozen at startup for later refreshes', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-v2cr-frz-'));
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      const store = new MarketplaceStore({ pluginVersion: '3.0.2' });
      store.install({
        manifest: {
          schemaVersion: 2,
          id: 'team/frozen',
          version: '1.0.0',
          displayName: 'frozen-agent',
          description: 'Frozen marketplace agent',
          agentName: 'frozen-agent',
          prompt: 'Frozen prompt',
          skills: [],
          mcps: [],
          tools: ['read'],
          author: { name: 'Test author' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=1.0.0' },
          model: {
            source: 'explicit',
            candidates: ['pkg/one', 'pkg/two'],
          },
          routing: {
            description: 'Frozen lane',
            when: 'Frozen task',
            keywords: ['frozen'],
          },
        },
      } as never);
      env.writeUserConfig({
        preset: 'market',
        presets: { market: { marketplace: { agents: ['team/frozen'] } } },
      });

      await withFactory(async (fac) => {
        expect(fac.readPublished()?.['frozen-agent']?.model).toEqual({
          providerID: 'pkg',
          id: 'one',
        });
        // Replace the installed package AFTER startup: the frozen snapshot
        // must keep the captured installed content, not leak the new one.
        store.remove('team/frozen');
        new MarketplaceStore({ pluginVersion: '3.0.2' }).install({
          manifest: {
            schemaVersion: 2,
            id: 'team/frozen',
            version: '2.0.0',
            displayName: 'frozen-agent',
            description: 'Replaced marketplace agent',
            agentName: 'frozen-agent',
            prompt: 'Replaced prompt',
            skills: [],
            mcps: [],
            tools: ['read'],
            author: { name: 'Test author' },
            tags: [],
            license: 'MIT',
            compatibility: { plugin: '>=1.0.0' },
            model: {
              source: 'explicit',
              candidates: ['pkg/three', 'pkg/four'],
            },
            routing: {
              description: 'Replaced lane',
              when: 'Replaced task',
              keywords: ['replaced'],
            },
          },
        } as never);

        const refreshed = await refreshAndPublish(fac);
        expect(refreshed.ok).toBe(true);
        if (!refreshed.ok || !('published' in refreshed))
          throw new Error('expected a published refresh');
        expect(
          refreshed.table.profiles['frozen-agent']?.fallbackChain?.map(
            (c) => c.id,
          ),
        ).toEqual(['pkg/one', 'pkg/two']);
      });
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('refresh keeps the frozen roster/identities (displayName + disabled edits ignored)', async () => {
    env.writeUserConfig({
      agents: {
        explorer: { displayName: 'Scout', model: 'pa/A' },
      },
    });

    await withFactory(async (fac) => {
      // Startup froze the roster/identities from the finalized registration.
      expect(fac.readPublished()?.explorer).toBeDefined();
      const frozenKeys = Object.keys(fac.readPublished() ?? {});

      // A displayName change must not add a new published key, and disabling
      // the agent must not drop the host-registered one.
      env.writeUserConfig({
        disabled_agents: ['explorer'],
        agents: {
          explorer: { displayName: 'Ranger', model: 'px/X' },
        },
      });
      const refreshed = await refreshAndPublish(fac);
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok || !('published' in refreshed))
        throw new Error('expected a published refresh');
      const publishedKeys = Object.keys(fac.readPublished() ?? {});
      expect(publishedKeys.sort()).toEqual([...frozenKeys].sort());
      expect(publishedKeys).toContain('explorer');
      expect(publishedKeys).not.toContain('ranger');
      expect(sidebarModels().ranger).toBeUndefined();
      expect(sidebarModels().explorer).toBeDefined();
    });
  });
});
