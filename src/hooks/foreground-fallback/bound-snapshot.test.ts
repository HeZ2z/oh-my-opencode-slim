import { describe, expect, test } from 'bun:test';
import { type BoundFallbackSnapshot, ForegroundFallbackManager } from './index';

const STARTUP_CHAINS = {
  explorer: ['p/A', 'p/B', 'p/C'],
};

function makeSteeringManager(
  resolveBoundFallback: (sessionID: string) => BoundFallbackSnapshot,
) {
  return new ForegroundFallbackManager(
    STARTUP_CHAINS,
    false,
    { directory: '/test' } as never,
    3,
    undefined,
    undefined,
    0,
    500,
    undefined,
    undefined,
    undefined,
    true,
    resolveBoundFallback,
  );
}

function retryEvent(sessionID: string, modelID: string) {
  return {
    sessionID,
    agent: 'explorer',
    model: { providerID: 'p', id: modelID },
    error: { message: 'rate limit exceeded' },
  };
}

describe('issue-1527 batch 1: bound fallback snapshot reader', () => {
  test('bound child descends its captured chain, never the stale startup chain', async () => {
    const mgr = makeSteeringManager(() => ({
      state: 'bound-child',
      agent: 'explorer',
      entries: [{ id: 'p/X' }, { id: 'p/Y' }],
      disabled: false,
    }));
    const switches: Array<{ providerID: string; id: string }> = [];
    await mgr.handleV2Retry(retryEvent('child-1', 'X'), async (_id, model) => {
      switches.push(model as { providerID: string; id: string });
      return {};
    });

    // X failed: the next model must be the captured Y, not stale A/B/C.
    expect(switches.map((m) => `${m.providerID}/${m.id}`)).toEqual(['p/Y']);
  });

  test('bound variant survives the switch request', async () => {
    const mgr = makeSteeringManager(() => ({
      state: 'bound-child',
      agent: 'explorer',
      entries: [{ id: 'p/X' }, { id: 'p/Y', variant: 'max' }],
      disabled: false,
    }));
    const switches: Array<unknown> = [];
    await mgr.handleV2Retry(
      retryEvent('child-variant', 'X'),
      async (_id, model) => {
        switches.push(model);
        return {};
      },
    );

    expect(switches).toEqual([{ providerID: 'p', id: 'Y', variant: 'max' }]);
  });

  test('bound old-child descent reaches C, sticky-retries C, then stops', async () => {
    const mgr = makeSteeringManager(() => ({
      state: 'bound-child',
      agent: 'explorer',
      entries: [{ id: 'p/A' }, { id: 'p/B' }, { id: 'p/C' }],
      disabled: false,
    }));
    const switched: Array<string> = [];
    const switchModel = async (_id: string, model: unknown) => {
      switched.push(
        `${(model as { providerID: string }).providerID}/${(model as { id: string }).id}`,
      );
      return {};
    };
    const fail = (modelID: string) =>
      mgr.handleV2Retry(retryEvent('old-child', modelID), switchModel);

    // Existing child captured on [A,B,C]: A already failed, B fails next.
    await fail('A');
    await fail('B');
    // C fails → sticky retry of C once (tried/exhaustion retained).
    await fail('C');
    // Sticky C fails again → exhausted, no further steering.
    const event = {
      ...retryEvent('old-child', 'C'),
      decision: undefined as { retry: boolean; delay?: number } | undefined,
    };
    await mgr.handleV2Retry(event, switchModel);

    expect(switched).toEqual(['p/B', 'p/C', 'p/C']);
    expect(event.decision).toBeUndefined();
  });

  test('bound observed model outside the candidates leads the descent', async () => {
    const mgr = makeSteeringManager(() => ({
      state: 'bound-child',
      agent: 'explorer',
      entries: [{ id: 'p/B' }, { id: 'p/C' }],
      disabled: false,
    }));
    const switches: Array<unknown> = [];
    // The session runs an inherited model outside the captured candidates:
    // it leads (dynamic head) and the captured head backs it.
    await mgr.handleV2Retry(
      retryEvent('child-inherit', 'Z'),
      async (_id, model) => {
        switches.push(model);
        return {};
      },
    );

    expect(switches).toEqual([{ providerID: 'p', id: 'B' }]);
  });

  test('a throwing binding reader fails closed: no steering, host decision kept', async () => {
    const mgr = makeSteeringManager(() => {
      throw new Error('reader blew up');
    });
    let switched = 0;
    const event = {
      ...retryEvent('child-broken-reader', 'A'),
      decision: undefined as { retry: boolean; delay?: number } | undefined,
    };
    await mgr.handleV2Retry(event, async () => {
      switched += 1;
      return {};
    });
    // Never the stale startup chain on reader failure.
    expect(switched).toBe(0);
    expect(event.decision).toBeUndefined();
  });

  test('bound empty chain never falls back to the startup chain', async () => {
    const mgr = makeSteeringManager(() => ({
      state: 'bound-child',
      agent: 'explorer',
      entries: [],
      disabled: true,
    }));
    let switched = 0;
    const event = {
      ...retryEvent('child-empty', 'A'),
      decision: undefined as { retry: boolean; delay?: number } | undefined,
    };
    await mgr.handleV2Retry(event, async () => {
      switched += 1;
      return {};
    });
    expect(switched).toBe(0);
    expect(event.decision).toBeUndefined();
  });

  test('pending child is not steered; the host decision is retained', async () => {
    const mgr = makeSteeringManager(() => ({ state: 'pending-child' }));
    let switched = 0;
    const event = {
      ...retryEvent('child-pending', 'A'),
      decision: undefined as { retry: boolean; delay?: number } | undefined,
    };
    await mgr.handleV2Retry(event, async () => {
      switched += 1;
      return {};
    });
    expect(switched).toBe(0);
    expect(event.decision).toBeUndefined();
  });

  test('startup policy keeps the original startup-chain behavior', async () => {
    const mgr = makeSteeringManager(() => ({ state: 'startup-policy' }));
    const switches: Array<{ providerID: string; id: string }> = [];
    // X is outside the startup chain, so the legacy dynamic head applies and
    // the first configured entry backs it.
    await mgr.handleV2Retry(retryEvent('root-1', 'X'), async (_id, model) => {
      switches.push(model as { providerID: string; id: string });
      return {};
    });
    expect(switches.map((m) => `${m.providerID}/${m.id}`)).toEqual(['p/A']);
  });
});
