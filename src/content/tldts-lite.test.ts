import { parse as full } from "tldts";
import { describe, expect, it } from "vitest";

import { parse } from "./tldts-lite";

describe("tldts-lite", () => {
  it.each([
    "a.localhost",
    "sub.a.localhost",
    "www.example.com",
    "example.com",
    "x.y.example.co.uk",
    "user.github.io",
    "localhost",
    "com",
  ])("agrees with the full PSL on common hosts (%s)", (host) => {
    const a = parse(host);
    const b = full(host, { allowPrivateDomains: true });
    expect([a.hostname, a.domain, a.publicSuffix]).toEqual([
      b.hostname,
      b.domain,
      b.publicSuffix,
    ]);
  });

  it("recognises IPs and URLs", () => {
    expect(parse("127.0.0.1")).toMatchObject({ isIp: true, domain: null });
    expect(parse("[::1]")).toMatchObject({ hostname: "::1", isIp: true });
    expect(parse("http://Sub.A.localhost:3000/x")).toMatchObject({
      hostname: "sub.a.localhost",
      domain: "a.localhost",
    });
  });
});
