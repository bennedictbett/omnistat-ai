import { Dataset, quantile, toNumber } from '@/lib/chartStudio'

// Pure functions behind the Maps tab: boundary parsing, joining data to boundaries, class breaks, colours
// and point extraction. No React and no MapLibre runtime in here, so everything is easy to test.

// ---------- Types ----------

export type Position = [number, number]

export interface PolygonGeometry {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: unknown
}

export interface BoundaryFeature {
  type: 'Feature'
  properties: Record<string, unknown>
  geometry: PolygonGeometry
}

export interface Boundaries {
  features: BoundaryFeature[]
  /** Features dropped because they are not polygons (points, lines, empty geometry) */
  skipped: number
  vertices: number
}

export interface PointFeature {
  type: 'Feature'
  properties: { w: number }
  geometry: { type: 'Point'; coordinates: Position }
}

export type Bounds = [Position, Position]

/** An error whose message is safe to show to the user. */
export class MapError extends Error {}

export const MAX_BOUNDARY_BYTES = 25_000_000
export const MAX_FEATURES = 20_000
export const MAX_VERTICES = 2_000_000
export const MAX_POINTS = 200_000
export const MAX_CLASSES = 7

// ---------- Boundaries ----------

const COORDINATE_HELP = 'Boundaries must use longitude/latitude in degrees (WGS84, EPSG:4326).'

function checkPosition(p: unknown): Position {
  if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') {
    throw new MapError('A boundary contains a coordinate that is not a pair of numbers.')
  }
  const [lon, lat] = p as number[]
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    throw new MapError(`A boundary coordinate is outside the world (${lon}, ${lat}). ${COORDINATE_HELP}`)
  }
  return [lon, lat]
}

/** Validates every ring of a polygon and returns how many vertices it holds. */
function checkRings(rings: unknown): number {
  if (!Array.isArray(rings)) throw new MapError('A polygon boundary has malformed coordinates.')
  let count = 0
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new MapError('A polygon ring has fewer than four points, so it cannot be drawn.')
    }
    for (const p of ring) checkPosition(p)
    count += ring.length
  }
  return count
}

function asFeatures(json: unknown): unknown[] {
  if (typeof json !== 'object' || json === null) throw new MapError('This file is not valid GeoJSON.')
  const obj = json as Record<string, unknown>
  if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) return obj.features
  if (obj.type === 'Feature') return [obj]
  if (obj.type === 'Polygon' || obj.type === 'MultiPolygon') return [{ type: 'Feature', properties: {}, geometry: obj }]
  throw new MapError('This file is not a GeoJSON FeatureCollection, Feature or Polygon.')
}

/** Reads GeoJSON text and keeps its polygon features. Throws MapError with a user-facing message otherwise. */
export function parseBoundaries(text: string): Boundaries {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new MapError('This file is not valid JSON. Choose a GeoJSON file (.geojson or .json).')
  }
  const raw = asFeatures(json)
  if (raw.length > MAX_FEATURES) {
    throw new MapError(`This file has ${raw.length} features; the limit is ${MAX_FEATURES}. Simplify or split it.`)
  }

  const features: BoundaryFeature[] = []
  let skipped = 0
  let vertices = 0
  for (const item of raw) {
    const f = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const g = f.geometry as { type?: unknown; coordinates?: unknown } | null | undefined
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) {
      skipped++
      continue
    }
    if (g.type === 'Polygon') {
      vertices += checkRings(g.coordinates)
    } else {
      if (!Array.isArray(g.coordinates)) throw new MapError('A MultiPolygon boundary has malformed coordinates.')
      for (const polygon of g.coordinates) vertices += checkRings(polygon)
    }
    if (vertices > MAX_VERTICES) {
      throw new MapError(`These boundaries have more than ${MAX_VERTICES} points. Simplify them and try again.`)
    }
    const props = f.properties
    features.push({
      type: 'Feature',
      properties: typeof props === 'object' && props !== null && !Array.isArray(props) ? { ...(props as object) } : {},
      geometry: { type: g.type, coordinates: g.coordinates },
    })
  }
  if (features.length === 0) throw new MapError('No polygon boundaries were found in this file.')
  return { features, skipped, vertices }
}

/** Property names that hold text or numbers on at least one feature, in order of first appearance. */
export function propertyKeys(b: Boundaries): string[] {
  const keys: string[] = []
  for (const f of b.features) {
    for (const [k, v] of Object.entries(f.properties)) {
      if ((typeof v === 'string' || typeof v === 'number') && !keys.includes(k)) keys.push(k)
    }
  }
  return keys
}

/** Visits every position of every boundary. */
function forEachPosition(g: PolygonGeometry, visit: (p: Position) => void) {
  const polygons = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as Position[][][]
  for (const rings of polygons) for (const ring of rings) for (const p of ring) visit(p)
}

export function boundsOfBoundaries(features: BoundaryFeature[]): Bounds | null {
  return boundsOf((visit) => features.forEach((f) => forEachPosition(f.geometry, visit)))
}

export function boundsOfPoints(points: PointFeature[]): Bounds | null {
  return boundsOf((visit) => points.forEach((p) => visit(p.geometry.coordinates)))
}

function boundsOf(each: (visit: (p: Position) => void) => void): Bounds | null {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  each(([lon, lat]) => {
    if (lon < w) w = lon
    if (lon > e) e = lon
    if (lat < s) s = lat
    if (lat > n) n = lat
  })
  return Number.isFinite(w) ? [[w, s], [e, n]] : null
}

// ---------- Joining data to boundaries ----------

export type Aggregate = 'mean' | 'sum' | 'median' | 'count'

export const AGGREGATES: { id: Aggregate; label: string }[] = [
  { id: 'mean', label: 'Mean' },
  { id: 'sum', label: 'Sum' },
  { id: 'median', label: 'Median' },
  { id: 'count', label: 'Number of rows' },
]

export interface JoinConfig {
  /** Boundary property holding the area name or code */
  boundaryKey: string
  /** Data column holding the same name or code */
  dataKey: string
  aggregate: Aggregate
  /** Numeric column to summarise (not needed for 'count') */
  valueColumn?: string
}

export interface JoinResult {
  /** One value per boundary feature (null where no data matched) */
  values: (number | null)[]
  matched: number
  unmatchedFeatures: number
  /** Data keys that match no boundary (first few) */
  unmatchedKeys: string[]
  unmatchedKeyCount: number
  /** Rows ignored because the key was blank or the value was not a number */
  skippedRows: number
  notes: string[]
}

/** Keys match ignoring case and surrounding spaces. */
export function normalizeKey(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim().toLowerCase()
}

function summarise(values: number[], how: Aggregate): number {
  if (how === 'count') return values.length
  if (how === 'sum') return values.reduce((a, b) => a + b, 0)
  if (how === 'mean') return values.reduce((a, b) => a + b, 0) / values.length
  return quantile([...values].sort((a, b) => a - b), 0.5)
}

export function joinData(b: Boundaries, ds: Dataset, cfg: JoinConfig): JoinResult {
  if (!cfg.boundaryKey) throw new MapError('Choose the boundary property that names each area.')
  if (!cfg.dataKey) throw new MapError('Choose the data column that names each area.')
  if (cfg.aggregate !== 'count' && !cfg.valueColumn) throw new MapError('Choose the numeric column to map.')

  const groups = new Map<string, number[]>()
  const displayKey = new Map<string, string>()
  let skippedRows = 0
  for (const row of ds.rows) {
    const key = normalizeKey(row[cfg.dataKey])
    if (key === '') {
      skippedRows++
      continue
    }
    let value = 1
    if (cfg.aggregate !== 'count') {
      const n = toNumber(row[cfg.valueColumn as string])
      if (n === null) {
        skippedRows++
        continue
      }
      value = n
    }
    const list = groups.get(key)
    if (list) list.push(value)
    else {
      groups.set(key, [value])
      displayKey.set(key, String(row[cfg.dataKey]).trim())
    }
  }

  const featureKeys = b.features.map((f) => normalizeKey(f.properties[cfg.boundaryKey]))
  const seen = new Set<string>()
  const duplicateKeys = new Set<string>()
  for (const k of featureKeys) {
    if (k === '') continue
    if (seen.has(k)) duplicateKeys.add(k)
    seen.add(k)
  }

  const values = featureKeys.map((k) => {
    const list = k === '' ? undefined : groups.get(k)
    return list ? summarise(list, cfg.aggregate) : null
  })
  const matched = values.filter((v) => v !== null).length
  const unmatched = Array.from(groups.keys()).filter((k) => !seen.has(k))

  const notes: string[] = []
  if (matched === 0) {
    notes.push('No data row matched any boundary. Check that you chose the matching name or code columns.')
  }
  if (duplicateKeys.size > 0) {
    notes.push(`${duplicateKeys.size} boundary name(s) appear on more than one area; those areas share one value.`)
  }
  if (skippedRows > 0) notes.push(`${skippedRows} data row(s) were ignored (blank name or non-numeric value).`)

  return {
    values,
    matched,
    unmatchedFeatures: b.features.length - matched,
    unmatchedKeys: unmatched.slice(0, 10).map((k) => displayKey.get(k) ?? k),
    unmatchedKeyCount: unmatched.length,
    skippedRows,
    notes,
  }
}

// ---------- Classes and colours ----------

export type ClassMethod = 'quantile' | 'equal'

/** Light-to-dark sequential ramp (ColorBrewer YlOrRd, 7 classes). */
const RAMP = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026']
export const NO_DATA_COLOR = '#374151'

export function rampColors(k: number): string[] {
  const n = Math.max(1, Math.min(k, RAMP.length))
  if (n === 1) return [RAMP[4]]
  return Array.from({ length: n }, (_, i) => RAMP[Math.round((i * (RAMP.length - 1)) / (n - 1))])
}

/**
 * Class edges for `k` classes, ascending, from the minimum to the maximum.
 * Duplicate edges (ties) are merged, so fewer classes may come back.
 */
export function classBreaks(values: number[], k: number, method: ClassMethod): number[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  if (min === max) return [min, max]
  const classes = Math.max(1, Math.min(Math.floor(k), MAX_CLASSES))
  const edges: number[] = []
  for (let i = 0; i <= classes; i++) {
    edges.push(method === 'equal' ? min + ((max - min) * i) / classes : quantile(sorted, i / classes))
  }
  return edges.filter((e, i) => i === 0 || e > edges[i - 1])
}

/** Which class a value falls in: the first one whose upper edge is at or above it. */
export function classIndex(value: number, edges: number[]): number {
  const last = edges.length - 2
  for (let i = 0; i <= last; i++) if (value <= edges[i + 1]) return i
  return last
}

export interface LegendEntry {
  color: string
  from: number
  to: number
  count: number
}

export interface Choropleth {
  features: BoundaryFeature[]
  legend: LegendEntry[]
}

/** Copies the boundaries with `_value` and `_fill` properties, ready to colour a map layer. */
export function colorBoundaries(
  b: Boundaries,
  values: (number | null)[],
  k: number,
  method: ClassMethod,
): Choropleth {
  const present = values.filter((v): v is number => v !== null)
  const edges = classBreaks(present, k, method)
  const colors = rampColors(Math.max(edges.length - 1, 1))
  const legend: LegendEntry[] = colors.slice(0, Math.max(edges.length - 1, 0)).map((color, i) => ({
    color,
    from: edges[i],
    to: edges[i + 1],
    count: 0,
  }))
  const features = b.features.map((f, i) => {
    const v = values[i]
    if (v === null || v === undefined || legend.length === 0) {
      return { ...f, properties: { ...f.properties, _value: null, _fill: NO_DATA_COLOR } }
    }
    const c = classIndex(v, edges)
    legend[c].count++
    return { ...f, properties: { ...f.properties, _value: v, _fill: legend[c].color } }
  })
  return { features, legend }
}

// ---------- Points and heatmap ----------

const LAT_NAMES = /^(lat|latitude)$/i
const LON_NAMES = /^(lon|lng|long|longitude)$/i

/** Picks likely latitude and longitude columns by name ('' when none look right). */
export function guessCoordinateColumns(ds: Dataset): { lat: string; lon: string } {
  return {
    lat: ds.numericCols.find((c) => LAT_NAMES.test(c)) ?? '',
    lon: ds.numericCols.find((c) => LON_NAMES.test(c)) ?? '',
  }
}

export interface PointsResult {
  points: PointFeature[]
  skipped: number
  maxWeight: number
}

/** One point per row with valid coordinates; an optional weight column makes some rows count more. */
export function extractPoints(ds: Dataset, latCol: string, lonCol: string, weightCol?: string): PointsResult {
  if (!latCol || !lonCol) throw new MapError('Choose the latitude and longitude columns.')
  const points: PointFeature[] = []
  let skipped = 0
  let maxWeight = 0
  for (const row of ds.rows) {
    const lat = toNumber(row[latCol])
    const lon = toNumber(row[lonCol])
    const w = weightCol ? toNumber(row[weightCol]) : 1
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || w === null || w < 0) {
      skipped++
      continue
    }
    points.push({ type: 'Feature', properties: { w }, geometry: { type: 'Point', coordinates: [lon, lat] } })
    if (w > maxWeight) maxWeight = w
  }
  if (points.length > MAX_POINTS) {
    throw new MapError(`This dataset has ${points.length} mappable points; the limit is ${MAX_POINTS}.`)
  }
  if (points.length === 0) {
    throw new MapError('No rows have a valid latitude (-90 to 90) and longitude (-180 to 180).')
  }
  return { points, skipped, maxWeight }
}

/** MapLibre paint settings for a heat layer; weights are scaled so the largest weight counts as 1. */
export function heatmapPaint(maxWeight: number, radius: number) {
  const top = maxWeight > 0 ? maxWeight : 1
  return {
    'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0, top, 1],
    'heatmap-radius': radius,
    'heatmap-opacity': 0.85,
    'heatmap-color': [
      'interpolate',
      ['linear'],
      ['heatmap-density'],
      0, 'rgba(255,255,178,0)',
      0.2, RAMP[1],
      0.4, RAMP[2],
      0.6, RAMP[3],
      0.8, RAMP[5],
      1, RAMP[6],
    ],
  }
}

// ---------- Map style ----------

/** A style with no tiles, fonts or sprites, so the map draws with no network at all. */
export function blankStyle(background = '#111827') {
  return {
    version: 8 as const,
    sources: {},
    layers: [{ id: 'background', type: 'background' as const, paint: { 'background-color': background } }],
  }
}

/** Compact number for legends: up to three significant figures, no trailing zeros. */
export function formatLegend(n: number): string {
  if (!Number.isFinite(n)) return ''
  return String(Number(n.toPrecision(3)))
}
