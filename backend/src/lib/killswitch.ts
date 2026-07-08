import type { Env } from "../env";

const KV_KEY = "service_killed";

export async function isServiceKilled(env: Env): Promise<boolean> {
  const value = await env.STIGLA_KV.get(KV_KEY);
  return value === "1";
}

export async function setServiceKilled(env: Env, killed: boolean): Promise<void> {
  await env.STIGLA_KV.put(KV_KEY, killed ? "1" : "0");
}
