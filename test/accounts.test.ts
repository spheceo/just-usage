import { describe, expect, test } from "bun:test";
import { isLocalCallbackUrl } from "../src/accounts.ts";
import { isAntigravityCallbackUrl, parseAntigravityAuthInput } from "../src/adapters/antigravity.ts";

describe("isLocalCallbackUrl", () => {
  test("accepts loopback http(s) redirects", () => {
    expect(isLocalCallbackUrl("http://localhost:1455/auth/callback?code=abc")).toBe(true);
    expect(isLocalCallbackUrl("http://127.0.0.1:1455/?code=abc")).toBe(true);
    expect(isLocalCallbackUrl("https://[::1]/cb?code=abc")).toBe(true);
  });
  test("rejects anything that is not this machine's listener", () => {
    expect(isLocalCallbackUrl("https://chatgpt.com/oauth/callback?code=abc")).toBe(false);
    expect(isLocalCallbackUrl("http://192.168.1.10:1455/?code=abc")).toBe(false);
    expect(isLocalCallbackUrl("file:///etc/passwd")).toBe(false);
    expect(isLocalCallbackUrl("not a url")).toBe(false);
    expect(isLocalCallbackUrl("")).toBe(false);
  });
});

describe("isAntigravityCallbackUrl", () => {
  test("accepts the official Google redirect with a code", () => {
    expect(isAntigravityCallbackUrl("https://antigravity.google/oauth-callback?code=abc&state=xyz")).toBe(true);
  });
  test("rejects anything else", () => {
    expect(isAntigravityCallbackUrl("https://antigravity.google/oauth-callback")).toBe(false);
    expect(isAntigravityCallbackUrl("http://localhost:1455/oauth-callback?code=abc")).toBe(false);
    expect(isAntigravityCallbackUrl("https://accounts.google.com/o/oauth2/auth?code=abc")).toBe(false);
  });
});

describe("parseAntigravityAuthInput", () => {
  test("accepts the code shown on the Antigravity page", () => {
    expect(parseAntigravityAuthInput("4/0ATsMZqDKHTu3NmSw1NQT_qtlVpkyVKUd5zm26_QTmhGgphESdC4hzV2ijWe6MJhPkDOwRw")).toEqual({
      code: "4/0ATsMZqDKHTu3NmSw1NQT_qtlVpkyVKUd5zm26_QTmhGgphESdC4hzV2ijWe6MJhPkDOwRw",
      state: null,
    });
  });
  test("accepts the official callback URL", () => {
    expect(parseAntigravityAuthInput("https://antigravity.google/oauth-callback?code=4%2F0ATs&state=xyz")).toEqual({
      code: "4/0ATs",
      state: "xyz",
    });
  });
  test("rejects junk", () => {
    expect(parseAntigravityAuthInput("")).toBeNull();
    expect(parseAntigravityAuthInput("sk-not-a-google-code")).toBeNull();
    expect(parseAntigravityAuthInput("https://example.com/?code=4/0ATs")).toBeNull();
  });
});
