import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFIG_REFRESH_DEBOUNCE_MS,
  type ConfigWatchListener,
  createProfileRefreshRunner,
  getPluginConfigCandidates,
  type ProfileRefreshRunnerOptions,
  watchPluginConfigFiles,
} from './config-watch';
import {
  makeTestEnv,
  type TestEnv,
  wait,
  waitFor as waitForImpl,
} from './test-fixtures';

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv('omos-v2cw');
});

afterEach(() => {
  env.restore();
});

/** Polling waits are shared; this file's scheduling tests use a 3s bound. */
const waitFor = (predicate: () => boolean) => waitForImpl(predicate, 3000);

/** Capture (directory, listener) pairs from the watch seam. */
function makeWatchSeam() {
  const dirs: string[] = [];
  const listeners: ConfigWatchListener[] = [];
  let closed = 0;
  return {
    dirs,
    listeners,
    closedCount: () => closed,
    watchImpl: (watchedPath: string, listener: ConfigWatchListener) => {
      dirs.push(watchedPath);
      listeners.push(listener);
      return {
        close: () => {
          closed += 1;
        },
      };
    },
  };
}

type WatchSeam = ReturnType<typeof makeWatchSeam>;

/** The seam listener bound for `dir` (or the first watch when omitted). */
const seamListener = (seam: WatchSeam, dir?: string) =>
  seam.listeners[dir === undefined ? 0 : seam.dirs.indexOf(dir)];

interface StartWatchOptions {
  /** Defaults to the user config path; omit to exercise ancestor discovery. */
  resolvePaths?: () => string[];
  debounceMs?: number;
  /** Extra behavior after the built-in counter increments (gates, probes). */
  onChanged?: (signal: AbortSignal) => void | Promise<void>;
  /** Use the real `fs.watch` implementation instead of the seam. */
  real?: boolean;
}

/** Starts a watcher over the isolated fixture env; `calls()` counts settled
 * refresh runs from the stubbed watches. */
function startWatch(options: StartWatchOptions = {}) {
  const seam = makeWatchSeam();
  let calls = 0;
  const watcher = watchPluginConfigFiles({
    directory: env.projectDir,
    debounceMs: options.debounceMs ?? 20,
    ...(options.resolvePaths ? { resolvePaths: options.resolvePaths } : {}),
    ...(options.real ? {} : { watchImpl: seam.watchImpl }),
    onChanged: async (signal) => {
      calls += 1;
      await options.onChanged?.(signal);
    },
    log: () => {},
  });
  return { seam, watcher, calls: () => calls };
}

type WatchHarness = ReturnType<typeof startWatch>;

/** Starts a watcher, runs `body`, and always disposes it. */
async function withWatch(
  options: StartWatchOptions,
  body: (watch: WatchHarness) => Promise<void>,
): Promise<void> {
  const watch = startWatch(options);
  try {
    await body(watch);
  } finally {
    await watch.watcher.dispose();
  }
}

describe('getPluginConfigCandidates', () => {
  test('includes ancestor configs above a nested worktree location', () => {
    const nested = path.join(env.projectDir, '.slim', 'worktrees', 'feature');
    const candidates = getPluginConfigCandidates(nested);
    expect(candidates).toContain(
      path.join(env.projectDir, '.opencode', 'oh-my-opencode-slim.json'),
    );
    expect(candidates).toContain(
      path.join(
        path.dirname(env.projectDir),
        '.opencode',
        'oh-my-opencode-slim.jsonc',
      ),
    );
    expect(candidates).toContain(
      path.join(
        path.parse(nested).root,
        '.opencode',
        'oh-my-opencode-slim.json',
      ),
    );
  });

  test('returns jsonc and json candidates for user and project, existence-independent', () => {
    const candidates = getPluginConfigCandidates(env.projectDir);
    const userJsonc = path.join(
      path.dirname(env.userConfigPath),
      'oh-my-opencode-slim.jsonc',
    );

    expect(candidates).toContain(env.userConfigPath);
    expect(candidates).toContain(userJsonc);
    expect(candidates).toContain(
      path.join(env.projectDir, '.opencode', 'oh-my-opencode-slim.jsonc'),
    );
    expect(candidates).toContain(
      path.join(env.projectDir, '.opencode', 'oh-my-opencode-slim.json'),
    );
    // All candidates are enumerated regardless of existence; only the
    // project-scoped pair is guaranteed absent in this fixture.
    for (const candidate of candidates) {
      if (candidate.includes(`${path.sep}.opencode${path.sep}`)) {
        expect(fs.existsSync(candidate)).toBe(false);
      }
    }
    expect(fs.existsSync(userJsonc)).toBe(false);
  });
});

describe('watchPluginConfigFiles scheduling', () => {
  test('refreshes when an inherited project config changes', async () => {
    const configDir = path.join(env.projectDir, '.opencode');
    fs.mkdirSync(configDir);
    const configPath = path.join(configDir, 'oh-my-opencode-slim.json');
    fs.writeFileSync(configPath, '{}');
    const nested = path.join(env.projectDir, '.slim', 'worktrees', 'feature');
    fs.mkdirSync(nested, { recursive: true });
    const seam = makeWatchSeam();
    let calls = 0;
    const watcher = watchPluginConfigFiles({
      directory: nested,
      debounceMs: 20,
      watchImpl: seam.watchImpl,
      onChanged: () => {
        calls += 1;
      },
      log: () => {},
    });
    try {
      const listener = seamListener(seam, configDir);
      expect(listener).toBeDefined();
      fs.writeFileSync(configPath, '{"preset":"inherited"}');
      listener?.('change', 'oh-my-opencode-slim.json');
      await waitFor(() => calls === 1);
    } finally {
      await watcher.dispose();
    }
  });

  test('fires a debounced refresh on a real config-file write', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    await withWatch({ debounceMs: 30, real: true }, async ({ calls }) => {
      fs.writeFileSync(env.userConfigPath, '{"preset":"balanced"}');

      await waitFor(() => calls() > 0);
      expect(calls()).toBe(1);
    });
  });

  test('coalesces two quick writes into one refresh', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    await withWatch(
      { debounceMs: 50, resolvePaths: () => [env.userConfigPath] },
      async ({ seam, calls }) => {
        // The candidate's nearest existing ancestor plus its parent are bound.
        const configListener = seamListener(seam, env.configHome);
        expect(configListener).toBeDefined();
        configListener?.('change', 'oh-my-opencode-slim.json');
        await wait(10);
        configListener?.('change', 'oh-my-opencode-slim.json');

        await wait(120);
        expect(calls()).toBe(1);
      },
    );
  });

  test('an event during an in-flight refresh produces exactly one trailing refresh', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    let firstRun = true;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withWatch(
      {
        debounceMs: 20,
        resolvePaths: () => [env.userConfigPath],
        onChanged: async () => {
          if (firstRun) {
            firstRun = false;
            await gate;
          }
        },
      },
      async ({ seam, calls }) => {
        seamListener(seam)?.('change', 'oh-my-opencode-slim.json');
        await waitFor(() => calls() === 1);

        // Event while the first refresh is blocked: its debounce timer fires
        // during the run, leaving dirty+ready for one trailing run.
        seamListener(seam)?.('change', 'oh-my-opencode-slim.json');
        await wait(60);
        expect(calls()).toBe(1);

        release?.();
        await waitFor(() => calls() === 2);
        await wait(80);
        expect(calls()).toBe(2);
      },
    );
  });

  test('ignores events for unrelated files; the sibling .jsonc variant triggers', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    await withWatch(
      { resolvePaths: () => [env.userConfigPath] },
      async ({ seam, calls }) => {
        seamListener(seam)?.('change', 'opencode.json');
        await wait(60);
        expect(calls()).toBe(0);

        // The sibling .jsonc variant is a valid config path (the loader
        // prefers it over .json), so it must trigger a refresh.
        seamListener(seam)?.('change', 'oh-my-opencode-slim.jsonc');
        await wait(60);
        expect(calls()).toBe(1);
      },
    );
  });

  test('disposal is idempotent, closes every watch, and stops firing', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    const { seam, watcher, calls } = startWatch({
      resolvePaths: () => [env.userConfigPath],
    });

    await watcher.dispose();
    await watcher.dispose();

    expect(seam.closedCount()).toBe(seam.dirs.length);
    seamListener(seam)?.('change', 'oh-my-opencode-slim.json');
    await wait(60);
    expect(calls()).toBe(0);
  });

  test('cancels a pending debounced refresh on disposal', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    await withWatch(
      { debounceMs: 40, resolvePaths: () => [env.userConfigPath] },
      async ({ seam, watcher, calls }) => {
        seamListener(seam)?.('change', 'oh-my-opencode-slim.json');
        await watcher.dispose();
        await wait(80);
        expect(calls()).toBe(0);
      },
    );
  });

  test('aborts the active refresh signal and forbids a trailing run after disposal', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    let aborted: boolean | undefined;
    let firstRun = true;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withWatch(
      {
        debounceMs: 20,
        resolvePaths: () => [env.userConfigPath],
        onChanged: async (signal) => {
          if (firstRun) {
            firstRun = false;
            await gate;
            aborted = signal.aborted;
          }
        },
      },
      async ({ seam, watcher, calls }) => {
        seamListener(seam)?.('change', 'oh-my-opencode-slim.json');
        await waitFor(() => calls() === 1);
        // A second event would normally queue a trailing run; disposal must
        // suppress it.
        seamListener(seam)?.('change', 'oh-my-opencode-slim.json');
        const disposal = watcher.dispose();
        release?.();
        await disposal;
        await wait(80);

        expect(calls()).toBe(1);
        expect(aborted).toBe(true);
      },
    );
  });

  test('watches the nearest existing ancestor of a missing directory', async () => {
    await withWatch({}, async ({ seam }) => {
      // `.opencode` does not exist yet: the project directory itself is the
      // nearest existing ancestor.
      expect(seam.dirs).toContain(env.projectDir);
      expect(seam.dirs).not.toContain(path.join(env.projectDir, '.opencode'));
      // The watched ancestor's parent is bound too, so deleting/renaming the
      // ancestor itself stays observable (e.g. a delayed `.opencode`).
      expect(seam.dirs).toContain(path.dirname(env.projectDir));
    });
  });

  test('rebinds through nested missing ancestors of an arbitrary OPENCODE_CONFIG_DIR', async () => {
    const customDir = path.join(env.projectDir, 'my configs', 'opencode dir');
    process.env.OPENCODE_CONFIG_DIR = customDir;
    await withWatch({}, async ({ seam, calls }) => {
      // Both custom segments are missing: the project directory is the
      // nearest existing ancestor.
      expect(seam.dirs).toContain(env.projectDir);

      // First missing segment appears (arbitrary name, not a basename the
      // old allowlist knew): the watcher must rebind into it.
      const firstSegment = path.join(env.projectDir, 'my configs');
      fs.mkdirSync(firstSegment, { recursive: true });
      seamListener(seam, env.projectDir)?.('rename', 'my configs');
      expect(seam.dirs).toContain(firstSegment);

      // Second missing segment appears.
      fs.mkdirSync(customDir, { recursive: true });
      seamListener(seam, firstSegment)?.('rename', 'opencode dir');
      expect(seam.dirs).toContain(customDir);

      // A config write inside the newly bound directory refreshes.
      fs.writeFileSync(path.join(customDir, 'oh-my-opencode-slim.json'), '{}');
      seamListener(seam, customDir)?.('change', 'oh-my-opencode-slim.json');
      await waitFor(() => calls() === 1);
    });
  });

  test('rebinds when a missing XDG config root is created', async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    const xdgHome = path.join(env.projectDir, 'xdg home');
    const xdgOpenCode = path.join(xdgHome, 'opencode');
    process.env.XDG_CONFIG_HOME = xdgHome;
    await withWatch({}, async ({ seam, calls }) => {
      expect(seam.dirs).toContain(env.projectDir);

      fs.mkdirSync(xdgOpenCode, { recursive: true });
      seamListener(seam, env.projectDir)?.('rename', 'xdg home');
      expect(seam.dirs).toContain(xdgOpenCode);

      fs.writeFileSync(
        path.join(xdgOpenCode, 'oh-my-opencode-slim.json'),
        '{}',
      );
      seamListener(seam, xdgOpenCode)?.('change', 'oh-my-opencode-slim.json');
      await waitFor(() => calls() === 1);
    });
  });

  test('observes deletion of an existing config directory from its parent watch', async () => {
    const opencodeDir = path.join(env.projectDir, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(path.join(opencodeDir, 'oh-my-opencode-slim.json'), '{}');
    await withWatch({}, async ({ seam, calls }) => {
      expect(seam.dirs).toContain(opencodeDir);
      // The parent watch makes the directory's own deletion observable.
      expect(seam.dirs).toContain(env.projectDir);

      fs.rmSync(opencodeDir, { recursive: true, force: true });
      seamListener(seam, env.projectDir)?.('rename', '.opencode');

      await waitFor(() => calls() === 1);
      // The stale `.opencode` watcher was closed during reconcile.
      expect(seam.closedCount()).toBeGreaterThan(0);
    });
  });

  test('ignores unrelated sibling events even with parent watchers bound', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    await withWatch({}, async ({ seam, calls }) => {
      const parentListener = seamListener(seam, path.dirname(env.projectDir));
      parentListener?.('rename', `${path.basename(env.projectDir)}-unrelated`);
      seamListener(seam, env.projectDir)?.('change', 'README.md');

      await wait(80);
      expect(calls()).toBe(0);
    });
  });

  test('reacts to a config file deletion inside the watched directory', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    await withWatch(
      { resolvePaths: () => [env.userConfigPath] },
      async ({ seam, calls }) => {
        fs.rmSync(env.userConfigPath, { force: true });
        seamListener(seam)?.('rename', 'oh-my-opencode-slim.json');
        await waitFor(() => calls() === 1);
      },
    );
  });

  test('rebinds watchers when .opencode appears, then observes its config', async () => {
    await withWatch({}, async ({ seam, calls }) => {
      expect(seam.dirs).toContain(env.projectDir);
      const opencodeDir = path.join(env.projectDir, '.opencode');

      // The directory creation event arrives on the project watcher; the
      // watcher must rebind to the now-existing .opencode directory.
      fs.mkdirSync(opencodeDir, { recursive: true });
      const projectListener = seamListener(seam, env.projectDir);
      projectListener?.('rename', '.opencode');
      await wait(60);

      expect(calls()).toBe(1);
      expect(seam.dirs).toContain(opencodeDir);

      // A write inside the newly bound directory refreshes through the new
      // listener.
      const opencodeListener = seamListener(seam, opencodeDir);
      fs.writeFileSync(
        path.join(opencodeDir, 'oh-my-opencode-slim.jsonc'),
        '{}',
      );
      opencodeListener?.('change', 'oh-my-opencode-slim.jsonc');
      await waitFor(() => calls() === 2);
    });
  });

  test('reacts to a config file rename inside the watched directory', async () => {
    fs.writeFileSync(env.userConfigPath, '{}');
    await withWatch(
      { resolvePaths: () => [env.userConfigPath] },
      async ({ seam, calls }) => {
        seamListener(seam)?.('rename', 'oh-my-opencode-slim.jsonc');
        await waitFor(() => calls() === 1);
      },
    );
  });

  test('default debounce window is the documented value', () => {
    expect(CONFIG_REFRESH_DEBOUNCE_MS).toBe(300);
  });
});

describe('createProfileRefreshRunner', () => {
  const table = {
    profiles: {
      explorer: { sidebarModel: 'openai/gpt-5-mini' },
    },
    projection: { agentModels: {}, agentVariants: {} },
  };

  /** Runner harness: the default apply counts, the default log captures. */
  function startRunner(options: {
    refresh: ProfileRefreshRunnerOptions['refresh'];
    apply?: ProfileRefreshRunnerOptions['apply'];
    log?: ProfileRefreshRunnerOptions['log'];
  }) {
    const logs: string[] = [];
    let applied = 0;
    const runner = createProfileRefreshRunner({
      refresh: options.refresh,
      apply:
        options.apply ??
        (() => {
          applied += 1;
        }),
      log:
        options.log ??
        ((message) => {
          logs.push(message);
        }),
    });
    return { runner, logs, applied: () => applied };
  }

  test('applies resolved profiles and logs success once', async () => {
    const { runner, logs, applied } = startRunner({
      refresh: async () => ({ ok: true, table }),
    });

    await runner(new AbortController().signal);

    expect(applied()).toBe(1);
    expect(logs).toEqual(['[v2] runtime profiles refreshed']);
  });

  test('throws on failure without applying or logging success', async () => {
    const { runner, logs, applied } = startRunner({
      refresh: async () => ({ ok: false, reason: 'config unreadable' }),
    });

    await expect(runner(new AbortController().signal)).rejects.toThrow(
      'config unreadable',
    );
    expect(applied()).toBe(0);
    expect(logs).toEqual([]);
  });

  test('never commits after the signal is aborted', async () => {
    const controller = new AbortController();
    const { runner, applied } = startRunner({
      refresh: async () => {
        controller.abort();
        return { ok: true, table };
      },
    });

    await runner(controller.signal);

    expect(applied()).toBe(0);
  });

  test('skips an already-aborted signal entirely', async () => {
    const controller = new AbortController();
    controller.abort();
    let refreshes = 0;
    const { runner } = startRunner({
      refresh: async () => {
        refreshes += 1;
        return { ok: true, table };
      },
    });

    await runner(controller.signal);

    expect(refreshes).toBe(0);
  });
});
