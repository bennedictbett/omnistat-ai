'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Upload } from 'lucide-react'
import type { Map as MapLibreMap, Popup } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { toDataset } from '@/lib/chartStudio'
import {
  AGGREGATES,
  Aggregate,
  BoundaryFeature,
  Boundaries,
  ClassMethod,
  MAX_BOUNDARY_BYTES,
  MAX_CLASSES,
  MapError,
  NO_DATA_COLOR,
  PointFeature,
  blankStyle,
  boundsOfBoundaries,
  boundsOfPoints,
  colorBoundaries,
  extractPoints,
  formatLegend,
  guessCoordinateColumns,
  heatmapPaint,
  joinData,
  parseBoundaries,
  propertyKeys,
} from '@/lib/maps'
import { segClass, selectClass } from '@/components/charts/chartStyles'

type MapMode = 'choropleth' | 'heatmap'
type MapLibreApi = typeof import('maplibre-gl')

interface Props {
  /** The object the Upload tab saved (columns, numeric_cols, categorical_cols, full_data) */
  data: unknown
}

const labelClass = 'block text-xs text-gray-400'

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new MapError('The file could not be read.'))
    reader.readAsText(file)
  })
}

/** Maps drawn from the uploaded data: choropleth over uploaded boundaries, or a point-density heatmap. */
export default function MapStudio({ data }: Props) {
  const ds = useMemo(() => toDataset(data), [data])
  const [mode, setMode] = useState<MapMode>('choropleth')
  const [boundaries, setBoundaries] = useState<Boundaries | null>(null)
  const [boundaryName, setBoundaryName] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)

  const [boundaryKey, setBoundaryKey] = useState('')
  const [dataKey, setDataKey] = useState('')
  const [aggregate, setAggregate] = useState<Aggregate>('mean')
  const [valueColumn, setValueColumn] = useState('')
  const [classes, setClasses] = useState(5)
  const [method, setMethod] = useState<ClassMethod>('quantile')

  const [latCol, setLatCol] = useState('')
  const [lonCol, setLonCol] = useState('')
  const [weightCol, setWeightCol] = useState('')
  const [radius, setRadius] = useState(20)

  const [maplibre, setMaplibre] = useState<MapLibreApi | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const popupRef = useRef<Popup | null>(null)
  const boundaryKeyRef = useRef('')
  boundaryKeyRef.current = boundaryKey

  const keys = useMemo(() => (boundaries ? propertyKeys(boundaries) : []), [boundaries])
  const datasetKey = ds ? ds.columns.join('|') : ''

  // Load MapLibre only when this tab is opened (it is a large library).
  useEffect(() => {
    let cancelled = false
    import('maplibre-gl').then((mod) => {
      if (!cancelled) setMaplibre(((mod as unknown as { default?: MapLibreApi }).default ?? mod) as MapLibreApi)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // New dataset: start from sensible columns.
  useEffect(() => {
    if (!ds) return
    const guess = guessCoordinateColumns(ds)
    setLatCol(guess.lat)
    setLonCol(guess.lon)
    setWeightCol('')
    setDataKey(ds.categoricalCols[0] ?? ds.columns[0] ?? '')
    setValueColumn(ds.numericCols[0] ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey])

  // New boundaries: start from the first property that looks like a name.
  useEffect(() => {
    setBoundaryKey(keys.find((k) => /name|nom|district|county|region|admin|code|id/i.test(k)) ?? keys[0] ?? '')
  }, [keys])

  const choropleth = useMemo(() => {
    if (!boundaries) return { error: null as string | null, result: null }
    if (!ds || !boundaryKey || !dataKey || (aggregate !== 'count' && !valueColumn)) {
      return { error: null, result: null }
    }
    try {
      const join = joinData(boundaries, ds, { boundaryKey, dataKey, aggregate, valueColumn })
      return { error: null, result: { join, ...colorBoundaries(boundaries, join.values, classes, method) } }
    } catch (e) {
      return { error: e instanceof MapError ? e.message : 'The map could not be built.', result: null }
    }
  }, [boundaries, ds, boundaryKey, dataKey, aggregate, valueColumn, classes, method])

  const heat = useMemo(() => {
    if (mode !== 'heatmap' || !ds || !latCol || !lonCol) return { error: null as string | null, result: null }
    try {
      return { error: null, result: extractPoints(ds, latCol, lonCol, weightCol || undefined) }
    } catch (e) {
      return { error: e instanceof MapError ? e.message : 'The map could not be built.', result: null }
    }
  }, [mode, ds, latCol, lonCol, weightCol])

  // Create the map once MapLibre has loaded.
  useEffect(() => {
    if (!maplibre || !containerRef.current) return
    let map: MapLibreMap
    try {
      map = new maplibre.Map({
        container: containerRef.current,
        style: blankStyle() as never,
        center: [0, 20],
        zoom: 1,
        attributionControl: false,
      })
    } catch {
      setFileError('This browser could not start the map (WebGL is required).')
      return
    }
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
    const popup = new maplibre.Popup({ closeButton: false, closeOnClick: false })
    popupRef.current = popup
    mapRef.current = map

    map.on('load', () => setMapReady(true))
    map.on('mousemove', 'areas-fill', (e) => {
      const props = e.features?.[0]?.properties
      if (!props) return
      const value = typeof props._value === 'number' ? formatLegend(props._value) : 'no data'
      popup.setLngLat(e.lngLat).setText(`${props[boundaryKeyRef.current] ?? 'Area'}: ${value}`).addTo(map)
    })
    map.on('mouseleave', 'areas-fill', () => popup.remove())

    return () => {
      popup.remove()
      map.remove()
      mapRef.current = null
      setMapReady(false)
    }
  }, [maplibre])

  // Draw whatever the current settings describe.
  const areas = useMemo<BoundaryFeature[] | null>(() => {
    if (!boundaries) return null
    if (choropleth.result && mode === 'choropleth') return choropleth.result.features
    return boundaries.features.map((f) => ({ ...f, properties: { ...f.properties, _value: null, _fill: NO_DATA_COLOR } }))
  }, [boundaries, choropleth.result, mode])
  const points: PointFeature[] | null = mode === 'heatmap' && heat.result ? heat.result.points : null
  const maxWeight = heat.result?.maxWeight ?? 1

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    for (const id of ['heat', 'areas-line', 'areas-fill']) if (map.getLayer(id)) map.removeLayer(id)
    for (const id of ['points', 'areas']) if (map.getSource(id)) map.removeSource(id)

    if (areas) {
      map.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: areas } as never })
      if (mode === 'choropleth') {
        map.addLayer({
          id: 'areas-fill',
          type: 'fill',
          source: 'areas',
          paint: { 'fill-color': ['get', '_fill'], 'fill-opacity': 0.85 },
        })
      }
      map.addLayer({
        id: 'areas-line',
        type: 'line',
        source: 'areas',
        paint: { 'line-color': '#9ca3af', 'line-width': 0.8 },
      })
    }
    if (points) {
      map.addSource('points', { type: 'geojson', data: { type: 'FeatureCollection', features: points } as never })
      map.addLayer({ id: 'heat', type: 'heatmap', source: 'points', paint: heatmapPaint(maxWeight, radius) as never })
    }
  }, [mapReady, areas, points, mode, maxWeight, radius])

  // Zoom to the data when it changes (not on every setting tweak).
  const fitKey = mode === 'heatmap' ? `p:${points?.length ?? 0}:${latCol}:${lonCol}` : `b:${boundaryName}`
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const bounds = mode === 'heatmap' ? (points ? boundsOfPoints(points) : null) : areas ? boundsOfBoundaries(areas) : null
    if (bounds) map.fitBounds(bounds, { padding: 40, maxZoom: 12, duration: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, fitKey])

  async function onBoundaryFile(file: File | undefined) {
    if (!file) return
    setFileError(null)
    if (file.size > MAX_BOUNDARY_BYTES) {
      setFileError(`This file is ${(file.size / 1e6).toFixed(1)} MB; the limit is ${MAX_BOUNDARY_BYTES / 1e6} MB.`)
      return
    }
    try {
      setBoundaries(parseBoundaries(await readText(file)))
      setBoundaryName(file.name)
    } catch (e) {
      setFileError(e instanceof MapError ? e.message : 'The boundary file could not be read.')
    }
  }

  const error = fileError ?? choropleth.error ?? (mode === 'heatmap' ? heat.error : null)
  const legend = mode === 'choropleth' ? choropleth.result?.legend : undefined

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Maps</h2>
        <p className="text-sm text-gray-400">
          Colour areas by your data, or show where points cluster. Maps draw offline with no background tiles.
        </p>
      </div>

      <div className="flex gap-2">
        <button className={segClass(mode === 'choropleth')} onClick={() => setMode('choropleth')}>
          Choropleth
        </button>
        <button className={segClass(mode === 'heatmap')} onClick={() => setMode('heatmap')}>
          Heatmap
        </button>
      </div>

      {!ds && <p className="text-sm text-gray-400">Upload a dataset first, then come back to map it.</p>}

      {mode === 'choropleth' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-3">
            <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm border border-gray-700 text-gray-300 hover:bg-gray-800 cursor-pointer">
              <Upload size={16} />
              {boundaries ? 'Replace boundaries' : 'Upload boundaries (GeoJSON)'}
              <input
                type="file"
                accept=".geojson,.json,application/geo+json,application/json"
                className="sr-only"
                onChange={(e) => {
                  void onBoundaryFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>
            {boundaries && (
              <span className="ml-3 text-xs text-gray-400">
                {boundaryName}: {boundaries.features.length} areas
                {boundaries.skipped > 0 && ` (${boundaries.skipped} non-polygon features skipped)`}
              </span>
            )}
          </div>
          {boundaries && ds && (
            <>
              <label className={labelClass}>
                Boundary name or code
                <select className={selectClass} value={boundaryKey} onChange={(e) => setBoundaryKey(e.target.value)}>
                  {keys.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Matching data column
                <select className={selectClass} value={dataKey} onChange={(e) => setDataKey(e.target.value)}>
                  {ds.columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Show
                <select
                  className={selectClass}
                  value={aggregate}
                  onChange={(e) => setAggregate(e.target.value as Aggregate)}
                >
                  {AGGREGATES.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
              {aggregate !== 'count' && (
                <label className={labelClass}>
                  Value column
                  <select className={selectClass} value={valueColumn} onChange={(e) => setValueColumn(e.target.value)}>
                    {ds.numericCols.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className={labelClass}>
                Classes
                <select className={selectClass} value={classes} onChange={(e) => setClasses(Number(e.target.value))}>
                  {Array.from({ length: MAX_CLASSES - 2 }, (_, i) => i + 3).map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Class breaks
                <select
                  className={selectClass}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as ClassMethod)}
                >
                  <option value="quantile">Quantile (equal counts)</option>
                  <option value="equal">Equal interval</option>
                </select>
              </label>
            </>
          )}
        </div>
      )}

      {mode === 'heatmap' && ds && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className={labelClass}>
            Latitude column
            <select className={selectClass} value={latCol} onChange={(e) => setLatCol(e.target.value)}>
              <option value="">Choose…</option>
              {ds.numericCols.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Longitude column
            <select className={selectClass} value={lonCol} onChange={(e) => setLonCol(e.target.value)}>
              <option value="">Choose…</option>
              {ds.numericCols.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Weight (optional)
            <select className={selectClass} value={weightCol} onChange={(e) => setWeightCol(e.target.value)}>
              <option value="">Every row counts as 1</option>
              {ds.numericCols.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Radius: {radius}px
            <input
              type="range"
              min={5}
              max={60}
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              className="mt-3 w-full"
            />
          </label>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-red-400">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <div ref={containerRef} className="h-[560px] w-full rounded-lg border border-gray-800 overflow-hidden" />

      {legend && legend.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-300">
          {legend.map((l) => (
            <span key={l.color} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded-sm" style={{ background: l.color }} />
              {formatLegend(l.from)} to {formatLegend(l.to)} ({l.count})
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-5 rounded-sm" style={{ background: NO_DATA_COLOR }} />
            No data
          </span>
        </div>
      )}

      {mode === 'choropleth' && choropleth.result && (
        <div className="text-xs text-gray-400 space-y-1">
          <p>
            {choropleth.result.join.matched} of {boundaries?.features.length} areas matched your data.
            {choropleth.result.join.unmatchedKeyCount > 0 &&
              ` ${choropleth.result.join.unmatchedKeyCount} data name(s) matched no area: ${choropleth.result.join.unmatchedKeys.join(', ')}${
                choropleth.result.join.unmatchedKeyCount > choropleth.result.join.unmatchedKeys.length ? ', …' : ''
              }.`}
          </p>
          {choropleth.result.join.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
          <p>Names match ignoring capital letters and surrounding spaces. Boundaries are kept in this tab only.</p>
        </div>
      )}

      {mode === 'heatmap' && heat.result && (
        <p className="text-xs text-gray-400">
          {heat.result.points.length} points mapped
          {heat.result.skipped > 0 && `, ${heat.result.skipped} rows skipped (missing or out-of-range coordinates or weight)`}.
        </p>
      )}
    </div>
  )
}
