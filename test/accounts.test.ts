import { describe, expect, test } from "bun:test";
import { isLocalCallbackUrl } from "../src/accounts.ts";

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
