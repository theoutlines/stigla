import { describe, expect, it } from "vitest";
import { parseRawArrival } from "../src/lib/transitProvider";

// Shape based on a real captured response for stop 20091 (Batutova, line 79).
const SAMPLE_RAW_ITEM = {
  just_coordinates: "0",
  seconds_left: 1152,
  line_number: "79",
  station_name: "Batutova",
  id: "4935",
  actual_line_number: "4454B",
  stations_between: 11,
  garage_no: "P26624",
  vehicles: [{ garageNo: "P26624", lat: "44.79091000", lng: "20.54057160", station_name: "Semjuela Beketa" }],
};

describe("parseRawArrival", () => {
  it("normalizes a well-formed upstream item", () => {
    const result = parseRawArrival(SAMPLE_RAW_ITEM);
    expect(result).toEqual({
      lineNumber: "79",
      etaSeconds: 1152,
      stopsRemaining: 11,
      garageNo: "P26624",
      gps: { lat: 44.79091, lon: 20.5405716 },
    });
  });

  it("falls back to nulls/zeros when optional fields are missing", () => {
    const result = parseRawArrival({ line_number: "5" });
    expect(result).toEqual({
      lineNumber: "5",
      etaSeconds: 0,
      stopsRemaining: null,
      garageNo: null,
      gps: null,
    });
  });

  it("treats a non-numeric gps payload as absent", () => {
    const result = parseRawArrival({ line_number: "5", vehicles: [{ lat: null, lng: null }] });
    expect(result.gps).toBeNull();
  });
});
