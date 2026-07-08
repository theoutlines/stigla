import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  getLineByNumber,
  getRouteShape,
  getStopById,
  nearbyStops,
  searchLines,
  searchStops,
} from "../src/lib/gtfsData";

describe("gtfsData (against the real built GTFS bundle)", () => {
  it("finds the Batutova stop used as the smoke-test stop", async () => {
    const stop = await getStopById(env, "20091");
    expect(stop?.name).toBe("Batutova");
    expect(stop?.lines).toContain("79");
  });

  it("searches stops by name, case-insensitively", async () => {
    const results = await searchStops(env, "batutova");
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results.every((s) => s.name.toLowerCase().includes("batutova"))).toBe(true);
  });

  it("returns nearby stops sorted by distance", async () => {
    const results = await nearbyStops(env, 44.795374, 20.499713, 200);
    expect(results[0].stop_id).toBe("20091"); // itself, distance 0
  });

  it("looks up a line by number and its route shape", async () => {
    const line = await getLineByNumber(env, "79");
    expect(line?.route_id).toBe("00079");
    expect(line?.vehicle_type).toBe("bus");

    const shape = await getRouteShape(env, "00079");
    expect(shape?.polyline.length).toBeGreaterThan(0);
    expect(shape?.stops.some((s) => s.stop_id === "20529")).toBe(true);
  });

  it("returns an empty array for a query that matches nothing", async () => {
    expect(await searchStops(env, "zzzznotarealstopzzzz")).toEqual([]);
    expect(await searchLines(env, "zzzznotarealline")).toEqual([]);
  });

  it("returns null for an unknown route_id", async () => {
    expect(await getRouteShape(env, "not-a-real-route")).toBeNull();
  });
});
