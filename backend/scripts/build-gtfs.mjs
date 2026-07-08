#!/usr/bin/env node
// Preprocesses the raw Belgrade GTFS feed (backend/gtfs_raw/extracted) into
// compact bundles served by the Worker: public/gtfs/stops.json,
// public/gtfs/lines.json, public/gtfs/shapes/{route_id}.json.
//
// Run once locally after downloading a fresh GTFS export; output is checked
// into the repo (public/gtfs) so the Worker doesn't need the raw feed.
import { createReadStream, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const RAW_DIR = join(import.meta.dirname, "..", "gtfs_raw", "extracted");
const OUT_DIR = join(import.meta.dirname, "..", "public", "gtfs");

const VEHICLE_TYPE_BY_ROUTE_TYPE = { "0": "tram", "3": "bus", "11": "trolleybus" };

function splitCsvLine(line) {
  return line.split(",");
}

async function readCsv(path, onRow) {
  const rl = createInterface({ input: createReadStream(path, "utf-8"), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (line === "") continue;
    if (header === null) {
      header = splitCsvLine(line);
      continue;
    }
    const cols = splitCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i] ?? "";
    onRow(row);
  }
}

async function main() {
  if (!existsSync(RAW_DIR)) {
    console.error(`Raw GTFS not found at ${RAW_DIR}. Download+unzip the feed there first.`);
    process.exit(1);
  }

  console.log("Reading routes.txt ...");
  const routesById = new Map();
  await readCsv(join(RAW_DIR, "routes.txt"), (r) => {
    routesById.set(r.route_id, {
      routeId: r.route_id,
      line: r.route_short_name,
      vehicleType: VEHICLE_TYPE_BY_ROUTE_TYPE[r.route_type] ?? "bus",
    });
  });
  console.log(`  ${routesById.size} routes`);

  console.log("Reading trips.txt ...");
  const tripRouteId = new Map(); // trip_id -> route_id
  const tripDirectionId = new Map(); // trip_id -> direction_id
  const tripShapeId = new Map(); // trip_id -> shape_id
  const representativeTripByRoute = new Map(); // route_id -> trip_id (prefers direction_id === "0")
  await readCsv(join(RAW_DIR, "trips.txt"), (t) => {
    tripRouteId.set(t.trip_id, t.route_id);
    tripDirectionId.set(t.trip_id, t.direction_id);
    tripShapeId.set(t.trip_id, t.shape_id);
    const current = representativeTripByRoute.get(t.route_id);
    if (!current) {
      representativeTripByRoute.set(t.route_id, t.trip_id);
    } else if (tripDirectionId.get(current) !== "0" && t.direction_id === "0") {
      representativeTripByRoute.set(t.route_id, t.trip_id);
    }
  });
  console.log(`  ${tripRouteId.size} trips, ${representativeTripByRoute.size} representative trips`);

  const representativeTripIds = new Set(representativeTripByRoute.values());

  console.log("Reading stops.txt ...");
  const stopsById = new Map();
  await readCsv(join(RAW_DIR, "stops.txt"), (s) => {
    if (s.location_type && s.location_type !== "0") return; // skip parent stations etc.
    stopsById.set(s.stop_id, {
      stopId: s.stop_id,
      name: s.stop_name,
      lat: round6(parseFloat(s.stop_lat)),
      lon: round6(parseFloat(s.stop_lon)),
    });
  });
  console.log(`  ${stopsById.size} stops`);

  console.log("Reading stop_times.txt (this is the big one, ~2.3M rows) ...");
  const linesByStop = new Map(); // stop_id -> Set(line)
  const repTripStopSeq = new Map(); // trip_id -> [{stop_id, seq}]
  let rows = 0;
  await readCsv(join(RAW_DIR, "stop_times.txt"), (row) => {
    rows++;
    const routeId = tripRouteId.get(row.trip_id);
    if (!routeId) return;
    const route = routesById.get(routeId);
    if (!route) return;
    if (!linesByStop.has(row.stop_id)) linesByStop.set(row.stop_id, new Set());
    linesByStop.get(row.stop_id).add(route.line);

    if (representativeTripIds.has(row.trip_id)) {
      if (!repTripStopSeq.has(row.trip_id)) repTripStopSeq.set(row.trip_id, []);
      repTripStopSeq.get(row.trip_id).push({ stopId: row.stop_id, seq: parseInt(row.stop_sequence, 10) });
    }
    if (rows % 500000 === 0) console.log(`  ...${rows} rows`);
  });
  console.log(`  done, ${rows} rows total`);

  console.log("Reading shapes.txt ...");
  const neededShapeIds = new Set(
    [...representativeTripByRoute.values()].map((tripId) => tripShapeId.get(tripId)).filter(Boolean),
  );
  const shapePoints = new Map(); // shape_id -> [{lat, lon, seq}]
  await readCsv(join(RAW_DIR, "shapes.txt"), (r) => {
    if (!neededShapeIds.has(r.shape_id)) return;
    if (!shapePoints.has(r.shape_id)) shapePoints.set(r.shape_id, []);
    shapePoints.get(r.shape_id).push({
      lat: round6(parseFloat(r.shape_pt_lat)),
      lon: round6(parseFloat(r.shape_pt_lon)),
      seq: parseInt(r.shape_pt_sequence, 10),
    });
  });
  console.log(`  ${shapePoints.size} shapes kept (of interest)`);

  // --- Assemble output ---
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, "shapes"), { recursive: true });

  console.log("Writing stops.json ...");
  const stopsOut = [];
  for (const stop of stopsById.values()) {
    const lines = linesByStop.get(stop.stopId);
    if (!lines || lines.size === 0) continue;
    stopsOut.push({
      stop_id: stop.stopId,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      lines: [...lines].sort(lineCompare),
    });
  }
  writeFileSync(join(OUT_DIR, "stops.json"), JSON.stringify({ stops: stopsOut }));
  console.log(`  ${stopsOut.length} stops with service written`);

  console.log("Writing lines.json + per-route shape files ...");
  const linesOut = [];
  let shapesWritten = 0;
  for (const [routeId, route] of routesById) {
    const tripId = representativeTripByRoute.get(routeId);
    if (!tripId) continue;
    const stopSeq = (repTripStopSeq.get(tripId) ?? []).sort((a, b) => a.seq - b.seq);
    if (stopSeq.length === 0) continue;
    const stopsForRoute = stopSeq
      .map(({ stopId, seq }) => {
        const s = stopsById.get(stopId);
        if (!s) return null;
        return { stop_id: s.stopId, name: s.name, lat: s.lat, lon: s.lon, seq };
      })
      .filter(Boolean);
    if (stopsForRoute.length === 0) continue;

    const origin = stopsForRoute[0].name;
    const destination = stopsForRoute[stopsForRoute.length - 1].name;
    linesOut.push({ line: route.line, vehicle_type: route.vehicleType, route_id: routeId, origin, destination });

    const shapeId = tripShapeId.get(tripId);
    const rawPoints = (shapePoints.get(shapeId) ?? []).sort((a, b) => a.seq - b.seq);
    const polyline = rawPoints.length > 0 ? rawPoints.map((p) => [p.lat, p.lon]) : stopsForRoute.map((s) => [s.lat, s.lon]);

    const shapeDoc = {
      route_id: routeId,
      vehicle_type: route.vehicleType,
      origin,
      destination,
      polyline,
      stops: stopsForRoute,
    };
    writeFileSync(join(OUT_DIR, "shapes", `${routeId}.json`), JSON.stringify(shapeDoc));
    shapesWritten++;
  }
  linesOut.sort((a, b) => lineCompare(a.line, b.line));
  writeFileSync(join(OUT_DIR, "lines.json"), JSON.stringify({ lines: linesOut }));
  console.log(`  ${linesOut.length} lines written, ${shapesWritten} shape files written`);

  console.log("Done.");
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Natural-ish sort so "7L" sits near "7", "9A" near "9", numeric lines in order.
function lineCompare(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
