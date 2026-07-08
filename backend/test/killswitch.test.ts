import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { isServiceKilled, setServiceKilled } from "../src/lib/killswitch";

describe("killswitch", () => {
  it("defaults to not killed when the KV key is unset", async () => {
    expect(await isServiceKilled(env)).toBe(false);
  });

  it("flips on and off via setServiceKilled", async () => {
    await setServiceKilled(env, true);
    expect(await isServiceKilled(env)).toBe(true);

    await setServiceKilled(env, false);
    expect(await isServiceKilled(env)).toBe(false);
  });
});
