import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Dataset } from '@/lib/chartStudio'
import {
  MapError,
  blankStyle,
  boundsOfBoundaries,
  boundsOfPoints,
  classBreaks,
  classIndex,
  colorBoundaries,
  extractPoints,
  formatLegend,
  guessCoordinateColumns,
  heatmapPaint,
  joinData,
  normalizeKey,
  parseBoundaries,
  propertyKeys,
  rampColors,
} from '@/lib/maps'

const geojson = readFileSync(resolve(__dirname, 'fixtures/sample_regions.geojson'), 'utf8')

function dataset(rows: Record<string, unknown>[]): Dataset {
  const columns = Object.keys(rows[0])
  const numericCols = columns.filter((c) => rows.every((r) => typeof r[c] === 'number'))
  return { columns, numericCols, categoricalCols: columns.filter((c) => !numericCols.includes(c)), rows }
}

describe('parseBoundaries', () => {
  it('keeps polygons and multipolygons, skips other geometry, and lists text properties', () => {
    const b = parseBoundaries(geojson)
    expect(b.features.map((f) => f.properties.name)).toEqual(['North', 'South', 'East', 'West'])
    expect(b.skipped).toBe(1)
    expect(b.vertices).toBe(5 * 5)
    expect(propertyKeys(b)).toEqual(['name', 'code'])
  })

  it('accepts a bare polygon and a single feature', () => {
    const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
    expect(parseBoundaries(JSON.stringify(polygon)).features).toHaveLength(1)
    expect(parseBoundaries(JSON.stringify({ type: 'Feature', properties: null, geometry: polygon })).features).toHaveLength(1)
  })

  it('computes bounds', () => {
    expect(boundsOfBoundaries(parseBoundaries(geojson).features)).toEqual([[35, 0], [38, 2]])
    expect(boundsOfBoundaries([])).toBeNull()
  })

  it.each([
    ['not json', 'is not valid JSON'],
    ['{"type":"Topology"}', 'not a GeoJSON'],
    ['{"type":"FeatureCollection","features":[]}', 'No polygon boundaries'],
    [
      '{"type":"Polygon","coordinates":[[[500000,4000000],[500001,4000000],[500001,4000001],[500000,4000000]]]}',
      'WGS84',
    ],
    ['{"type":"Polygon","coordinates":[[[0,0],[1,1]]]}', 'fewer than four'],
    ['{"type":"Polygon","coordinates":[[["a",0],[1,0],[1,1],[0,0]]]}', 'not a pair of numbers'],
  ])('rejects %s', (text, message) => {
    expect(() => parseBoundaries(text)).toThrow(MapError)
    expect(() => parseBoundaries(text)).toThrow(message)
  })
})

describe('joinData', () => {
  const b = parseBoundaries(geojson)
  const ds = dataset([
    { district: 'north', cases: 10 },
    { district: ' North ', cases: 20 },
    { district: 'South', cases: 4 },
    { district: 'Atlantis', cases: 99 },
    { district: '', cases: 5 },
    { district: 'East', cases: 'n/a' },
  ])

  it('matches names ignoring case and spaces and aggregates per area', () => {
    const r = joinData(b, ds, { boundaryKey: 'name', dataKey: 'district', aggregate: 'mean', valueColumn: 'cases' })
    expect(r.values).toEqual([15, 4, null, null])
    expect(r.matched).toBe(2)
    expect(r.unmatchedFeatures).toBe(2)
    expect(r.unmatchedKeys).toEqual(['Atlantis'])
    expect(r.skippedRows).toBe(2)
  })

  it('supports sum, median and row counts', () => {
    const run = (aggregate: 'sum' | 'median' | 'count') =>
      joinData(b, ds, { boundaryKey: 'name', dataKey: 'district', aggregate, valueColumn: 'cases' }).values
    expect(run('sum')).toEqual([30, 4, null, null])
    expect(run('median')).toEqual([15, 4, null, null])
    expect(run('count')[0]).toBe(2)
  })

  it('warns when nothing matches and when boundary names repeat', () => {
    const none = joinData(b, dataset([{ district: 'Mars', cases: 1 }]), {
      boundaryKey: 'name', dataKey: 'district', aggregate: 'sum', valueColumn: 'cases',
    })
    expect(none.notes[0]).toContain('No data row matched')

    const twice = parseBoundaries(geojson.replace('"South"', '"North"'))
    const dup = joinData(twice, ds, { boundaryKey: 'name', dataKey: 'district', aggregate: 'sum', valueColumn: 'cases' })
    expect(dup.notes.join(' ')).toContain('more than one area')
  })

  it('requires the choices it needs', () => {
    expect(() => joinData(b, ds, { boundaryKey: '', dataKey: 'district', aggregate: 'count' })).toThrow(MapError)
    expect(() => joinData(b, ds, { boundaryKey: 'name', dataKey: 'district', aggregate: 'mean' })).toThrow('numeric column')
  })

  it('normalizes keys', () => {
    expect(normalizeKey('  Nairobi ')).toBe('nairobi')
    expect(normalizeKey(7)).toBe('7')
    expect(normalizeKey(null)).toBe('')
  })
})

describe('classes and colours', () => {
  it('builds equal-interval and quantile breaks', () => {
    expect(classBreaks([0, 10], 5, 'equal')).toEqual([0, 2, 4, 6, 8, 10])
    expect(classBreaks([1, 2, 3, 4, 5], 2, 'quantile')).toEqual([1, 3, 5])
  })

  it('merges tied edges and handles constant or empty input', () => {
    expect(classBreaks([1, 1, 1, 1, 9], 4, 'quantile')).toEqual([1, 9])
    expect(classBreaks([3, 3], 5, 'equal')).toEqual([3, 3])
    expect(classBreaks([], 5, 'equal')).toEqual([])
  })

  it('assigns values to classes with inclusive upper edges', () => {
    const edges = [0, 5, 10]
    expect([0, 5, 5.1, 10].map((v) => classIndex(v, edges))).toEqual([0, 0, 1, 1])
  })

  it('uses a light-to-dark ramp of the requested size', () => {
    expect(rampColors(3)).toHaveLength(3)
    expect(rampColors(7)).toHaveLength(7)
    expect(rampColors(3)[0]).toBe('#ffffb2')
    expect(rampColors(3)[2]).toBe('#b10026')
  })

  it('colours areas, counts them per class and greys out missing data', () => {
    const b = parseBoundaries(geojson)
    const c = colorBoundaries(b, [1, 9, 5, null], 3, 'equal')
    expect(c.legend.map((l) => l.count)).toEqual([1, 1, 1])
    expect(c.features[3].properties._fill).toBe('#374151')
    expect(c.features[0].properties._fill).toBe(c.legend[0].color)
    expect(c.features[1].properties._fill).toBe(c.legend[2].color)
    expect(b.features[0].properties._fill).toBeUndefined()
  })

  it('formats legend numbers compactly', () => {
    expect(formatLegend(12.3456)).toBe('12.3')
    expect(formatLegend(1200)).toBe('1200')
    expect(formatLegend(0.5)).toBe('0.5')
  })
})

describe('points and heatmap', () => {
  const ds = dataset([
    { Latitude: 1, Longitude: 36, n: 3 },
    { Latitude: 2, Longitude: 37, n: 5 },
    { Latitude: 95, Longitude: 37, n: 1 },
    { Latitude: 2, Longitude: 37, n: -1 },
  ])

  it('guesses coordinate columns by name', () => {
    expect(guessCoordinateColumns(ds)).toEqual({ lat: 'Latitude', lon: 'Longitude' })
    expect(guessCoordinateColumns(dataset([{ a: 1, b: 2 }]))).toEqual({ lat: '', lon: '' })
  })

  it('keeps valid rows and counts skipped ones', () => {
    const r = extractPoints(ds, 'Latitude', 'Longitude', 'n')
    expect(r.points.map((p) => p.geometry.coordinates)).toEqual([[36, 1], [37, 2]])
    expect(r.skipped).toBe(2)
    expect(r.maxWeight).toBe(5)
    expect(boundsOfPoints(r.points)).toEqual([[36, 1], [37, 2]])
  })

  it('weights every row as 1 without a weight column', () => {
    expect(extractPoints(ds, 'Latitude', 'Longitude').points[0].properties.w).toBe(1)
  })

  it('explains when there is nothing to draw', () => {
    expect(() => extractPoints(ds, '', 'Longitude')).toThrow('latitude and longitude')
    expect(() => extractPoints(dataset([{ lat: 99, lon: 0 }]), 'lat', 'lon')).toThrow('valid latitude')
  })

  it('scales heat weights to the largest weight', () => {
    expect(heatmapPaint(8, 20)['heatmap-weight']).toEqual(['interpolate', ['linear'], ['get', 'w'], 0, 0, 8, 1])
    expect(heatmapPaint(0, 20)['heatmap-weight'][6]).toBe(1)
  })
})

it('uses a style with no network sources', () => {
  const style = blankStyle()
  expect(style.sources).toEqual({})
  expect(style.layers.map((l) => l.type)).toEqual(['background'])
})
