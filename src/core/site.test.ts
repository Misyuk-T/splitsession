import { describe, expect, it } from 'vitest';
import {
  domainMatches,
  hostnameOf,
  isPotentiallyTrustworthyHost,
  isPublicSuffix,
  isSameSite,
  isSecureUrl,
  labelCount,
  registrableDomain,
  siteOf,
} from './site';

describe('registrableDomain', () => {
  it.each([
    ['example.com', 'example.com'],
    ['www.example.com', 'example.com'],
    ['a.b.example.co.uk', 'example.co.uk'],
    ['user.github.io', 'user.github.io'], // private registry suffix, as in Chrome
    ['a.localhost', 'a.localhost'],
  ])('%s -> %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it.each(['com', 'co.uk', 'github.io', 'localhost', '127.0.0.1', '[::1]', ''])('%s has none', (host) => {
    expect(registrableDomain(host)).toBeNull();
  });
});

describe('isPublicSuffix', () => {
  it.each(['com', 'co.uk', 'github.io', 'localhost'])('%s is a suffix', (host) => {
    expect(isPublicSuffix(host)).toBe(true);
  });
  it.each(['example.com', 'user.github.io', 'a.localhost', '127.0.0.1'])('%s is not', (host) => {
    expect(isPublicSuffix(host)).toBe(false);
  });
});

describe('isSameSite', () => {
  it('compares registrable domains', () => {
    expect(isSameSite('www.example.com', 'api.example.com')).toBe(true);
    expect(isSameSite('example.com', 'example.org')).toBe(false);
    expect(isSameSite('a.example.co.uk', 'b.example.co.uk')).toBe(true);
    expect(isSameSite('a.example.co.uk', 'example.co.uk')).toBe(true);
  });

  it('treats private-registry tenants as different sites', () => {
    expect(isSameSite('alice.github.io', 'bob.github.io')).toBe(false);
  });

  it('keeps the e2e test hosts apart', () => {
    expect(isSameSite('a.localhost', 'sso.localhost')).toBe(false);
    expect(isSameSite('a.localhost', 'a.localhost')).toBe(true);
  });

  it('falls back to host equality without a registrable domain', () => {
    expect(isSameSite('localhost', 'localhost')).toBe(true);
    expect(isSameSite('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(isSameSite('127.0.0.1', '127.0.0.2')).toBe(false);
    expect(isSameSite('localhost', 'a.localhost')).toBe(false);
  });

  it('accepts URLs', () => {
    expect(isSameSite('https://www.example.com/x', 'http://example.com:8080/y')).toBe(true);
  });
});

describe('host helpers', () => {
  it('domainMatches', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('www.example.com', 'example.com')).toBe(true);
    expect(domainMatches('badexample.com', 'example.com')).toBe(false);
    expect(domainMatches('example.com', 'www.example.com')).toBe(false);
    expect(domainMatches('10.0.1.2', '1.2')).toBe(false);
  });

  it('labelCount and hostnameOf', () => {
    expect(labelCount('a.b.example.com')).toBe(4);
    expect(hostnameOf('HTTPS://WWW.Example.COM:8443/x')).toBe('www.example.com');
    expect(hostnameOf('[::1]')).toBe('::1');
  });

  it('knows trustworthy hosts', () => {
    expect(isPotentiallyTrustworthyHost('localhost')).toBe(true);
    expect(isPotentiallyTrustworthyHost('a.localhost')).toBe(true);
    expect(isPotentiallyTrustworthyHost('127.0.0.1')).toBe(true);
    expect(isPotentiallyTrustworthyHost('example.com')).toBe(false);
    expect(isPotentiallyTrustworthyHost('localhost.example.com')).toBe(false);
  });

  it('isSecureUrl: https/wss, or plain schemes on trustworthy hosts', () => {
    expect(isSecureUrl('https://example.com/')).toBe(true);
    expect(isSecureUrl('wss://example.com/socket')).toBe(true);
    expect(isSecureUrl('http://example.com/')).toBe(false);
    expect(isSecureUrl('http://a.localhost:3000/')).toBe(true);
    expect(isSecureUrl('ftp://localhost/')).toBe(false);
    expect(isSecureUrl('not a url')).toBe(false);
  });

  it('siteOf is scheme plus registrable domain', () => {
    expect(siteOf('https://www.example.com/path?q=1')).toBe('https://example.com');
    expect(siteOf('http://a.localhost:3000/')).toBe('http://a.localhost');
    expect(siteOf('http://127.0.0.1:8080/')).toBe('http://127.0.0.1');
  });
});
