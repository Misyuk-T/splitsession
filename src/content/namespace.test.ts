import { describe, expect, it } from 'vitest';
import { containerNamespace, realNamespace, visibleNames } from './namespace';

describe('container namespace', () => {
  const ns = containerNamespace('abc');
  it('prefixes names and only owns its own prefix', () => {
    expect(ns.toRaw('token')).toBe('__facet:abc:token');
    expect(ns.owns('__facet:abc:token')).toBe(true);
    expect(ns.owns('__facet:xyz:token')).toBe(false);
    expect(ns.owns('token')).toBe(false);
    expect(ns.fromRaw(ns.toRaw(''))).toBe('');
    expect(ns.fromRaw(ns.toRaw('__facet:other:x'))).toBe('__facet:other:x');
  });

  it('round-trips arbitrary names, including ones that look like other namespaces', () => {
    for (const name of ['', 'a', '__facet:xyz:k', ':', 'é🙂']) expect(ns.fromRaw(ns.toRaw(name))).toBe(name);
  });
});

describe('real (managed) namespace', () => {
  const ns = realNamespace();
  it('leaves ordinary names alone and hides every container namespace', () => {
    expect(ns.toRaw('token')).toBe('token');
    expect(ns.owns('token')).toBe(true);
    expect(ns.owns('__facet:abc:token')).toBe(false);
  });

  it('quarantines explicit requests for container names instead of reaching container data', () => {
    const raw = ns.toRaw('__facet:abc:token');
    expect(raw).not.toBe('__facet:abc:token');
    expect(containerNamespace('abc').owns(raw)).toBe(false);
    expect(ns.owns(raw)).toBe(true);
    expect(ns.fromRaw(raw)).toBe('__facet:abc:token');
  });
});

describe('visibleNames', () => {
  it('filters and strips, keeping order', () => {
    const raw = ['plain', '__facet:abc:one', '__facet:xyz:two', '__facet:abc:three'];
    expect(visibleNames(raw, containerNamespace('abc'))).toEqual(['one', 'three']);
    expect(visibleNames(raw, containerNamespace('xyz'))).toEqual(['two']);
    expect(visibleNames(raw, realNamespace())).toEqual(['plain']);
  });
});
