import { useEffect, useMemo, useState } from "react";
import type { ExplorationBounds } from "./explorationClient";

export const MAP_BOUNDARY_ENDPOINT = "/api/integration/fresh/map-boundary/kostat-2013-v1";

export type MapBoundaryLoadState = "loading" | "ready" | "error";

interface ProjectedCoordinate {
  x: number;
  y: number;
}

interface GeoJsonGeometry {
  type?: unknown;
  coordinates?: unknown;
}

interface GeoJsonFeature {
  type?: unknown;
  geometry?: GeoJsonGeometry | null;
}

interface GeoJsonFeatureCollection {
  type?: unknown;
  features?: unknown;
}

function finiteCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Uses the same 8%-92% projection as live exploration markers. */
export function projectMapCoordinate(longitude: number, latitude: number, bounds: ExplorationBounds): ProjectedCoordinate {
  const horizontal = clamp((longitude - bounds.west) / Math.max(0.000001, bounds.east - bounds.west));
  const vertical = clamp((bounds.north - latitude) / Math.max(0.000001, bounds.north - bounds.south));
  return {
    x: 8 + horizontal * 84,
    y: 8 + vertical * 84
  };
}

function ringPath(value: unknown, bounds: ExplorationBounds): string {
  if (!Array.isArray(value)) return "";
  const points = value.flatMap((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return [];
    const longitude = finiteCoordinate(coordinate[0]);
    const latitude = finiteCoordinate(coordinate[1]);
    if (longitude === null || latitude === null || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return [];
    return [projectMapCoordinate(longitude, latitude, bounds)];
  });
  if (points.length < 3) return "";
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(3)} ${point.y.toFixed(3)}`).join(" ") + " Z";
}

function polygonPath(value: unknown, bounds: ExplorationBounds): string {
  if (!Array.isArray(value)) return "";
  return value.map((ring) => ringPath(ring, bounds)).filter(Boolean).join(" ");
}

/**
 * Projects only Polygon and MultiPolygon geometry. Unknown or malformed geometry
 * is ignored so the caller can expose an explicit partial/error state.
 */
export function boundaryPathsFromGeoJson(value: unknown, bounds: ExplorationBounds | null): readonly string[] {
  if (!bounds || !value || typeof value !== "object") return [];
  const collection = value as GeoJsonFeatureCollection;
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) return [];
  const paths: string[] = [];
  for (const candidate of collection.features) {
    if (!candidate || typeof candidate !== "object") continue;
    const feature = candidate as GeoJsonFeature;
    if (feature.type !== "Feature" || !feature.geometry || typeof feature.geometry !== "object") continue;
    const geometry = feature.geometry;
    if (geometry.type === "Polygon") {
      const path = polygonPath(geometry.coordinates, bounds);
      if (path) paths.push(path);
      continue;
    }
    if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
      for (const polygon of geometry.coordinates) {
        const path = polygonPath(polygon, bounds);
        if (path) paths.push(path);
      }
    }
  }
  return paths;
}

export function useMapBoundary(bounds: ExplorationBounds | null) {
  const [payload, setPayload] = useState<unknown>(null);
  const [state, setState] = useState<MapBoundaryLoadState>(bounds ? "loading" : "error");

  useEffect(() => {
    if (!bounds) {
      setPayload(null);
      setState("error");
      return;
    }
    const controller = new AbortController();
    setPayload(null);
    setState("loading");
    void fetch(MAP_BOUNDARY_ENDPOINT, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/geo+json" },
      signal: controller.signal
    }).then(async (response) => {
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!response.ok || !contentType.startsWith("application/geo+json")) throw new Error("map boundary unavailable");
      const nextPayload: unknown = await response.json();
      if (!boundaryPathsFromGeoJson(nextPayload, bounds).length) throw new Error("map boundary invalid");
      setPayload(nextPayload);
      setState("ready");
    }).catch((reason: unknown) => {
      if ((reason as { name?: string })?.name === "AbortError") return;
      setPayload(null);
      setState("error");
    });
    return () => controller.abort();
  }, [bounds?.east, bounds?.north, bounds?.south, bounds?.west]);

  const paths = useMemo(() => state === "ready" ? boundaryPathsFromGeoJson(payload, bounds) : [], [bounds, payload, state]);
  return { state, paths } as const;
}
