import { describe, expect, test } from 'bun:test';
import {
  createSessionProfileBridge,
  type V2AgentRuntimeProfiles,
} from './runtime-profiles';

const CHAIN_V1 = [{ id: 'p/A' }, { id: 'p/B' }, { id: 'p/C' }];
const CHAIN_V2 = [{ id: 'p/X' }, { id: 'p/Y' }];

const PROFILES_V1: V2AgentRuntimeProfiles = {
  explorer: {
    model: { providerID: 'p', id: 'A' },
    sidebarModel: 'p/A',
    fallbackChain: CHAIN_V1,
  },
};

const PROFILES_V2: V2AgentRuntimeProfiles = {
  explorer: {
    model: { providerID: 'p', id: 'X' },
    sidebarModel: 'p/X',
    fallbackChain: CHAIN_V2,
  },
};

function makeBridge(table: () => V2AgentRuntimeProfiles) {
  const switchCalls: Array<unknown> = [];
  const bridge = createSessionProfileBridge({
    profiles: table,
    pluginAgents: new Set(['explorer', 'oracle']),
    session: {
      switchModel: async (input: unknown) => {
        switchCalls.push(input);
        return {};
      },
    } as never,
    log: () => {},
  });
  return { bridge, switchCalls };
}

const created = (sessionID: string, agent = 'explorer', parentID = 'p') => ({
  type: 'session.created',
  data: { sessionID, parentID, agent },
});

describe('issue-1527 batch 1: frozen fallback snapshot', () => {
  test('created capture freezes profile and chain together', async () => {
    let table = PROFILES_V1;
    const { bridge } = makeBridge(() => table);

    await bridge.observeEvent(created('child-1'));
    expect(bridge.fallbackBindingForSession('child-1')).toEqual({
      state: 'bound-child',
      agent: 'explorer',
      entries: CHAIN_V1,
      disabled: false,
    });

    // Refresh after a successful created capture must not alter it.
    table = PROFILES_V2;
    await bridge.ensureSessionProfile('child-1');
    expect(bridge.profileForSession('child-1')?.model?.id).toBe('A');
    const frozen = bridge.fallbackBindingForSession('child-1');
    expect(frozen?.state).toBe('bound-child');
    if (frozen?.state === 'bound-child') {
      expect(frozen.entries).toEqual(CHAIN_V1);
    } else {
      throw new Error('expected child-1 to stay bound-child');
    }
  });

  test('a child first captured after refresh uses the new entry', async () => {
    let table = PROFILES_V1;
    const { bridge } = makeBridge(() => table);
    table = PROFILES_V2;

    await bridge.observeEvent(created('child-new'));
    expect(bridge.profileForSession('child-new')?.model?.id).toBe('X');
    const fresh = bridge.fallbackBindingForSession('child-new');
    expect(fresh?.state).toBe('bound-child');
    if (fresh?.state === 'bound-child') {
      expect(fresh.entries).toEqual(CHAIN_V2);
    } else {
      throw new Error('expected child-new to be bound-child');
    }
  });

  test('a captured legacy profile without candidate data reads as startup-policy', async () => {
    const { bridge } = makeBridge(() => ({
      explorer: {
        model: { providerID: 'p', id: 'A' },
        sidebarModel: 'p/A',
      },
    }));
    await bridge.observeEvent(created('legacy-child'));
    // Profile capture itself is unchanged (prompt path still switches).
    expect(bridge.profileForSession('legacy-child')?.model?.id).toBe('A');
    // …but without frozen candidates there is no bound chain to descend.
    expect(bridge.fallbackBindingForSession('legacy-child')).toEqual({
      state: 'startup-policy',
    });
  });

  test('retained live snapshots are never evicted while the child lives', async () => {
    const { bridge } = makeBridge(() => PROFILES_V1);
    for (let index = 0; index < 1100; index += 1) {
      await bridge.observeEvent(created(`live-${index}`));
    }
    expect(bridge.size()).toBe(1100);
    const oldest = bridge.fallbackBindingForSession('live-0');
    expect(oldest?.state).toBe('bound-child');
    if (oldest?.state === 'bound-child') {
      expect(oldest.entries).toEqual(CHAIN_V1);
    } else {
      throw new Error('expected live-0 to stay bound-child');
    }
  });

  test('three-state binding: bound, pending, and startup', async () => {
    const { bridge } = makeBridge(() => PROFILES_V1);

    await bridge.observeEvent(created('bound'));
    expect(bridge.fallbackBindingForSession('bound')?.state).toBe(
      'bound-child',
    );

    // A failed switch leaves a confirmed managed child pending, never
    // startup: no steering, host decision retained, no self-capture.
    const failing = createSessionProfileBridge({
      profiles: () => PROFILES_V1,
      pluginAgents: new Set(['explorer']),
      session: {
        switchModel: async () => {
          throw new Error('host refused');
        },
      } as never,
      log: () => {},
    });
    await failing.observeEvent(created('retry-later'));
    expect(failing.fallbackBindingForSession('retry-later')?.state).toBe(
      'pending-child',
    );

    // Root, foreign, and never-seen sessions stay on startup policy.
    await bridge.observeEvent({
      type: 'session.created',
      data: { sessionID: 'root', agent: 'explorer' },
    });
    expect(bridge.fallbackBindingForSession('root')?.state).toBe(
      'startup-policy',
    );
    expect(bridge.fallbackBindingForSession('never-seen')?.state).toBe(
      'startup-policy',
    );
  });

  test('bound empty chain never falls back to the startup chain', async () => {
    const { bridge } = makeBridge(() => ({
      explorer: {
        model: { providerID: 'p', id: 'A' },
        sidebarModel: 'p/A',
        fallbackChain: [],
        fallbackDisabled: true,
      },
    }));
    await bridge.observeEvent(created('disabled-child'));
    expect(bridge.fallbackBindingForSession('disabled-child')).toEqual({
      state: 'bound-child',
      agent: 'explorer',
      entries: [],
      disabled: true,
    });
  });

  test('deleted sessions release their snapshot', async () => {
    const { bridge } = makeBridge(() => PROFILES_V1);
    await bridge.observeEvent(created('c1'));
    expect(bridge.fallbackBindingForSession('c1')?.state).toBe('bound-child');
    await bridge.observeEvent({
      type: 'session.deleted',
      data: { sessionID: 'c1' },
    });
    expect(bridge.fallbackBindingForSession('c1')?.state).toBe(
      'startup-policy',
    );
  });
});
