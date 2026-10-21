import { describe, expect, it } from 'vitest';
import { POST_STATUS as P, TARGET_STATUS as T, canTransitionTarget, derivePostStatus } from '../src/index.js';

describe('derivePostStatus', () => {
  const cases = [
    [[], P.DRAFT],
    [[T.DRAFT], P.DRAFT],
    [[T.DRAFT, T.DRAFT], P.DRAFT],
    [[T.SCHEDULED, T.SCHEDULED], P.SCHEDULED],
    [[T.QUEUED, T.PUBLISHED], P.PUBLISHING],
    [[T.PUBLISHING, T.FAILED], P.PUBLISHING],
    [[T.PUBLISHED, T.PUBLISHED], P.PUBLISHED],
    [[T.PUBLISHED, T.CANCELLED], P.PUBLISHED],
    [[T.PUBLISHED, T.FAILED], P.PARTIALLY_PUBLISHED],
    [[T.PUBLISHED, T.NEEDS_REAUTHORIZATION], P.PARTIALLY_PUBLISHED],
    [[T.FAILED, T.FAILED], P.FAILED],
    [[T.FAILED, T.NEEDS_REAUTHORIZATION], P.FAILED],
    [[T.CANCELLED, T.CANCELLED], P.CANCELLED],
    [[T.FAILED, T.CANCELLED], P.FAILED],
    [[T.SCHEDULED, T.FAILED], P.SCHEDULED],
  ];
  it.each(cases)('%j -> %s', (targets, expected) => {
    expect(derivePostStatus(targets)).toBe(expected);
  });
});

describe('target transitions', () => {
  it('allows the documented lifecycle', () => {
    expect(canTransitionTarget(T.DRAFT, T.SCHEDULED)).toBe(true);
    expect(canTransitionTarget(T.QUEUED, T.PUBLISHING)).toBe(true);
    expect(canTransitionTarget(T.PUBLISHING, T.QUEUED)).toBe(true); // transient retry
    expect(canTransitionTarget(T.FAILED, T.QUEUED)).toBe(true); // manual retry
  });
  it('never leaves published', () => {
    for (const to of Object.values(T)) expect(canTransitionTarget(T.PUBLISHED, to)).toBe(false);
  });
  it('cannot jump straight from draft to published', () => {
    expect(canTransitionTarget(T.DRAFT, T.PUBLISHED)).toBe(false);
  });
});
