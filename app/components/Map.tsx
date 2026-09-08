'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { supabase } from '@/lib/supabase'
import { COUNTIES } from '@/lib/counties'
import type { County, CountyKey } from '@/lib/counties'
import TractSearch from './TractSearch'

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? ''
mapboxgl.accessToken = MAPBOX_TOKEN

// Flatten a GeoJSON polygon/multipolygon geometry into a flat array of [lng, lat]
// coordinate pairs so we can compute a rough bbox-based centroid without adding
// @turf as a dependency.
const flattenPolygonCoords = (geometry: GeoJSON.Geometry | null | undefined): number[][] => {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return (geometry.coordinates[0] ?? []) as number[][]
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as unknown as number[][][][]).flatMap(
      (poly) => (poly[0] ?? []) as number[][]
    )
  }
  return []
}

const featureBboxCenter = (
  feature: GeoJSON.Feature | undefined | null
): [number, number] | null => {
  if (!feature) return null
  const coords = flattenPolygonCoords(feature.geometry)
  if (coords.length === 0) return null
  const lngs: number[] = []
  const lats: number[] = []
  for (const c of coords) {
    const lng = Number(c[0])
    const lat = Number(c[1])
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      lngs.push(lng)
      lats.push(lat)
    }
  }
  if (lngs.length === 0) return null
  return [
    (Math.min(...lngs) + Math.max(...lngs)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  ]
}

const buildBlockLabelFeatureCollection = (
  featureCollection: GeoJSON.FeatureCollection
): GeoJSON.FeatureCollection => {
  // `Map` the identifier is the default-exported component in this file, so
  // we use a plain object keyed by block name instead of the built-in Map.
  const blockCentroids: Record<string, { lngSum: number; latSum: number; count: number }> = {}
  for (const feature of featureCollection.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>
    // Howard's Abstracts.shp exposes ``Block`` ("31 T2N"), Martin's exposes
    // ``LEVEL2_BLO`` ("35 T1N", "A", "HA"); accept either so the centroid
    // labels show up for all counties without per-county special casing.
    const blockRaw = props.Block ?? props.block ?? props.LEVEL2_BLO ?? props.level2_blo
    const blockValue = typeof blockRaw === 'string'
      ? blockRaw.trim()
      : blockRaw != null
        ? String(blockRaw).trim()
        : ''
    if (!blockValue) continue

    const center = featureBboxCenter(feature)
    if (!center) continue

    const entry = blockCentroids[blockValue] ?? { lngSum: 0, latSum: 0, count: 0 }
    entry.lngSum += center[0]
    entry.latSum += center[1]
    entry.count += 1
    blockCentroids[blockValue] = entry
  }

  const features: GeoJSON.Feature[] = []
  for (const block of Object.keys(blockCentroids)) {
    const { lngSum, latSum, count } = blockCentroids[block]
    if (count === 0) continue
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lngSum / count, latSum / count],
      },
      properties: { block },
    })
  }

  return { type: 'FeatureCollection', features }
}

export type OwnerRecord = {
  id?: number
  owner_name: string
  mailing_city?: string
  mailing_state?: string
  operator_name?: string
  propensity_score?: number
  motivated?: boolean
  out_of_state?: boolean
  acreage?: number | null
  prod_cumulative_sum_oil?: number | null
  rrc_lease_id?: string | null
  latitude?: number | null
  longitude?: number | null
  well_status?: string
  [key: string]: unknown
}

type TractLayerHandlers = {
  layerId: string
  mouseEnterHandler: () => void
  mouseLeaveHandler: () => void
}

type PermitLayerHandlers = {
  clickHandler?: (event: mapboxgl.MapLayerMouseEvent) => void
  mouseEnterHandler?: () => void
  mouseLeaveHandler?: () => void
}

type CountyOverviewHandlers = {
  moveHandler?: (event: mapboxgl.MapLayerMouseEvent) => void
  leaveHandler?: () => void
  clickHandler?: (event: mapboxgl.MapLayerMouseEvent) => void
  hoveredFips: string | null
}

export default function Map({
  showPermits,
  onOwnerClick,
  focusTarget,
  selectedCounty,
  mapFlyToRef,
  mapLevel,
  onCountySelect,
  onCountySwitch,
}: {
  showPermits: boolean
  onOwnerClick: (owner: Record<string, unknown>) => void
  focusTarget?: Record<string, unknown> | null
  selectedCounty: CountyKey
  mapFlyToRef?: React.MutableRefObject<((center: [number, number], zoom: number) => void) | null>
  mapLevel: 'county' | 'tract'
  onCountySelect?: (countyKey: CountyKey) => void
  onCountySwitch: (countyId: string) => void
}) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const onOwnerClickRef = useRef(onOwnerClick)
  const onCountySwitchRef = useRef(onCountySwitch)
  const onCountySelectRef = useRef(onCountySelect)
  const selectedCountyRef = useRef<CountyKey>(selectedCounty)
  const lastClickTimeRef = useRef(0)
  const renderForCurrentLevelRef = useRef<() => Promise<void>>(async () => {})
  const renderTokenRef = useRef(0)
  const currentParcelsByCountyRef = useRef<Partial<Record<CountyKey, GeoJSON.FeatureCollection>>>({})
  const countyMarkersRef = useRef<mapboxgl.Marker[]>([])
  const tractHandlersRef = useRef<TractLayerHandlers[]>([])
  const tractClickHandlerRef = useRef<((event: mapboxgl.MapMouseEvent) => void) | null>(null)
  const permitHandlersRef = useRef<PermitLayerHandlers>({})
  const countyOverviewHandlersRef = useRef<CountyOverviewHandlers>({ hoveredFips: null })
  const activeCountyByFipsRef = useRef<Record<string, CountyKey>>({})
  // The county that was last visually styled as "active" by
  // applyTractCountyStyles. Used to short-circuit the all-counties pass on
  // every click so we only repaint the two counties whose styling actually
  // flipped (old active → muted, new active → bright).
  const lastStyledSelectedCountyRef = useRef<CountyKey | null>(null)
  // Cache permit GeoJSON by county id so flipping between counties doesn't
  // re-issue a Supabase round-trip every time.
  const permitsCacheRef = useRef<Partial<Record<CountyKey, GeoJSON.FeatureCollection>>>({})

  const TEXAS_OVERVIEW_CENTER: [number, number] = [-99.5, 31.0]
  const TEXAS_OVERVIEW_ZOOM = 5.5

  const countyEntries = useMemo(
    () => Object.entries(COUNTIES) as Array<[CountyKey, County]>,
    []
  )

  useEffect(() => {
    onOwnerClickRef.current = onOwnerClick
  }, [onOwnerClick])

  useEffect(() => {
    onCountySwitchRef.current = onCountySwitch
  }, [onCountySwitch])

  useEffect(() => {
    onCountySelectRef.current = onCountySelect
  }, [onCountySelect])

  useEffect(() => {
    selectedCountyRef.current = selectedCounty
  }, [selectedCounty])

  const removeLayerIfExists = (mapInstance: mapboxgl.Map, layerId: string) => {
    if (mapInstance.getLayer(layerId)) mapInstance.removeLayer(layerId)
  }

  const removeSourceIfExists = (mapInstance: mapboxgl.Map, sourceId: string) => {
    if (mapInstance.getSource(sourceId)) mapInstance.removeSource(sourceId)
  }

  const clearCountyMarkers = useCallback(() => {
    countyMarkersRef.current.forEach((marker) => marker.remove())
    countyMarkersRef.current = []
  }, [])

  const fitGeometry = (
    mapInstance: mapboxgl.Map,
    geometry: GeoJSON.Geometry,
    options?: { padding?: number; duration?: number; maxZoom?: number }
  ) => {
    const bounds = new mapboxgl.LngLatBounds()
    const addCoords = (coords: number[][]) => {
      coords.forEach((coord) => bounds.extend([coord[0], coord[1]] as [number, number]))
    }

    if (geometry.type === 'Polygon') {
      addCoords(geometry.coordinates[0] as number[][])
    } else if (geometry.type === 'MultiPolygon') {
      geometry.coordinates.forEach((polygon) => addCoords(polygon[0] as number[][]))
    }

    if (!bounds.isEmpty()) {
      mapInstance.fitBounds(bounds, {
        padding: options?.padding ?? 120,
        duration: options?.duration ?? 800,
        maxZoom: options?.maxZoom ?? 14,
      })
    }
  }

  const clearCountyOverviewLayers = useCallback((mapInstance: mapboxgl.Map) => {
    const handlers = countyOverviewHandlersRef.current
    if (handlers.moveHandler) mapInstance.off('mousemove', 'tx-counties-active-fill', handlers.moveHandler)
    if (handlers.leaveHandler) mapInstance.off('mouseleave', 'tx-counties-active-fill', handlers.leaveHandler)
    if (handlers.clickHandler) mapInstance.off('click', 'tx-counties-active-fill', handlers.clickHandler)
    countyOverviewHandlersRef.current = { hoveredFips: null }
    activeCountyByFipsRef.current = {}

    removeLayerIfExists(mapInstance, 'tx-counties-active-outline')
    removeLayerIfExists(mapInstance, 'tx-counties-active-fill')
    removeLayerIfExists(mapInstance, 'tx-counties-outline')
    removeLayerIfExists(mapInstance, 'tx-counties-fill')
    removeSourceIfExists(mapInstance, 'tx-counties')
  }, [])

  const clearTractLayers = useCallback((mapInstance: mapboxgl.Map) => {
    tractHandlersRef.current.forEach((handlers) => {
      mapInstance.off('mouseenter', handlers.layerId, handlers.mouseEnterHandler)
      mapInstance.off('mouseleave', handlers.layerId, handlers.mouseLeaveHandler)
    })
    tractHandlersRef.current = []
    if (tractClickHandlerRef.current) {
      map.current?.off('click', tractClickHandlerRef.current)
      tractClickHandlerRef.current = null
    }

    if (permitHandlersRef.current.clickHandler) {
      mapInstance.off('click', 'permits-layer', permitHandlersRef.current.clickHandler)
    }
    if (permitHandlersRef.current.mouseEnterHandler) {
      mapInstance.off('mouseenter', 'permits-layer', permitHandlersRef.current.mouseEnterHandler)
    }
    if (permitHandlersRef.current.mouseLeaveHandler) {
      mapInstance.off('mouseleave', 'permits-layer', permitHandlersRef.current.mouseLeaveHandler)
    }
    permitHandlersRef.current = {}
    // Layers are about to be removed — invalidate the cached "last styled"
    // marker so the next applyTractCountyStyles re-applies the full pass.
    lastStyledSelectedCountyRef.current = null

    removeLayerIfExists(mapInstance, 'permits-layer')
    removeSourceIfExists(mapInstance, 'permits')

    countyEntries.forEach(([, countyConfig]) => {
      removeLayerIfExists(mapInstance, `block-labels-${countyConfig.id}`)
      removeSourceIfExists(mapInstance, `block-labels-source-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-sections-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-labels-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-outline-${countyConfig.id}`)
      removeLayerIfExists(mapInstance, `parcels-fill-${countyConfig.id}`)
      removeSourceIfExists(mapInstance, `parcels-${countyConfig.id}`)
    })
    currentParcelsByCountyRef.current = {}
  }, [countyEntries])

  const selectedFillColorExpr = useMemo<mapboxgl.Expression>(
    () => [
      'step',
      ['to-number', ['coalesce', ['get', 'max_propensity_score'], 0]],
      '#9E9E9E',
      2, '#81C784',
      5, '#FF9800',
      8, '#F44336',
      10, '#B71C1C',
    ],
    []
  )

  const selectedFillOpacityExpr = useMemo<mapboxgl.Expression>(
    () => [
      'step',
      ['to-number', ['coalesce', ['get', 'max_propensity_score'], 0]],
      0.3,
      2, 0.45,
      5, 0.7,
      8, 0.88,
      10, 1.0,
    ],
    []
  )

  const selectedOutlineColorExpr = useMemo<mapboxgl.Expression>(
    () => [
      'step',
      ['to-number', ['coalesce', ['get', 'max_propensity_score'], 0]],
      '#2d6a2d',
      5, '#FFC107',
      8, '#F44336',
    ],
    []
  )

  const selectedOutlineWidthExpr = useMemo<mapboxgl.Expression>(
    () => [
      'step',
      ['to-number', ['coalesce', ['get', 'max_propensity_score'], 0]],
      1.1,
      6, 1.6,
      8, 2.2,
    ],
    []
  )

  const applyTractCountyStyles = useCallback(() => {
    const mapInstance = map.current
    if (!mapInstance) return

    const newSelected = selectedCountyRef.current
    const previouslySelected = lastStyledSelectedCountyRef.current

    const stylePair = (
      countyKey: CountyKey,
      mode: 'active' | 'muted'
    ): boolean => {
      const countyConfig = COUNTIES[countyKey]
      const fillId = `parcels-fill-${countyConfig.id}`
      const outlineId = `parcels-outline-${countyConfig.id}`
      if (!mapInstance.getLayer(fillId) || !mapInstance.getLayer(outlineId)) {
        return false
      }
      if (mode === 'active') {
        mapInstance.setPaintProperty(fillId, 'fill-color', selectedFillColorExpr)
        mapInstance.setPaintProperty(fillId, 'fill-opacity', selectedFillOpacityExpr)
        mapInstance.setPaintProperty(outlineId, 'line-color', selectedOutlineColorExpr)
        mapInstance.setPaintProperty(outlineId, 'line-width', selectedOutlineWidthExpr)
        mapInstance.setPaintProperty(outlineId, 'line-opacity', 0.92)
      } else {
        mapInstance.setPaintProperty(fillId, 'fill-color', '#9E9E9E')
        mapInstance.setPaintProperty(fillId, 'fill-opacity', 0.25)
        mapInstance.setPaintProperty(outlineId, 'line-color', '#CBD5E1')
        mapInstance.setPaintProperty(outlineId, 'line-width', 0.8)
        mapInstance.setPaintProperty(outlineId, 'line-opacity', 1)
      }
      return true
    }

    if (previouslySelected === null) {
      // First pass after layers were just (re)created — set every county to
      // its correct mode in one go.
      countyEntries.forEach(([countyKey]) => {
        stylePair(countyKey, countyKey === newSelected ? 'active' : 'muted')
      })
    } else if (previouslySelected !== newSelected) {
      // Incremental update: only the two counties whose styling actually
      // changed need new paint properties. Skipping the others avoids
      // redundant style events on every click.
      stylePair(previouslySelected, 'muted')
      stylePair(newSelected, 'active')
    } else {
      // Same county — nothing to repaint.
      return
    }

    // Move the active county's symbol layers to the top of the stack. This
    // is intentionally only done when the active county actually changed
    // (the early return above prevents it on no-op calls); back-to-back
    // moveLayer calls force a worker collision-detection pass on every
    // symbol layer below them.
    const selectedConfig = COUNTIES[newSelected]
    const ids = [
      `parcels-fill-${selectedConfig.id}`,
      `parcels-outline-${selectedConfig.id}`,
      `parcels-labels-${selectedConfig.id}`,
      `parcels-sections-${selectedConfig.id}`,
      `block-labels-${selectedConfig.id}`,
    ]
    for (const id of ids) {
      if (mapInstance.getLayer(id)) mapInstance.moveLayer(id)
    }

    lastStyledSelectedCountyRef.current = newSelected
  }, [countyEntries, selectedFillColorExpr, selectedFillOpacityExpr, selectedOutlineColorExpr, selectedOutlineWidthExpr])

  const loadSelectedCountyPermits = useCallback(async () => {
    const mapInstance = map.current
    if (!mapInstance) return

    const countyKey = selectedCountyRef.current
    const countyConfig = COUNTIES[countyKey]
    const permitsTable = `${countyConfig.id}_permits`

    // Use cached GeoJSON if we already loaded permits for this county once.
    let permitsGeoJSON = permitsCacheRef.current[countyKey] ?? null

    if (!permitsGeoJSON) {
      let permitRows: Array<Record<string, unknown>> = []
      const permitsResult = await supabase
        .from(permitsTable)
        .select(
          'permit_number,api_number,operator_name,lease_name,latitude,longitude,permit_type,status,filed_date,approved_date'
        )
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)

      if (permitsResult.error) {
        // Table may not exist for this county (e.g. howard_permits).
        // Fail soft: render an empty layer so nothing misleading shows up.
        console.warn(`[permits] ${permitsTable} unavailable:`, permitsResult.error.message)
      } else {
        permitRows = (permitsResult.data ?? []) as Array<Record<string, unknown>>
      }

      const permits = permitRows.filter((row) => {
        const lon = Number(row.longitude)
        const lat = Number(row.latitude)
        // Guard against junk values (e.g. RRC fixed-width parser artifacts where
        // lat/lon come through as multi-billion integers).
        return (
          Number.isFinite(lon) &&
          Number.isFinite(lat) &&
          lon >= -180 && lon <= 180 &&
          lat >= -90 && lat <= 90
        )
      })

      permitsGeoJSON = {
        type: 'FeatureCollection',
        features: permits.map((permit) => ({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [Number(permit.longitude), Number(permit.latitude)],
          },
          properties: {
            operator: String(permit.operator_name ?? ''),
            lease: String(permit.lease_name ?? ''),
            date: String(permit.filed_date ?? permit.approved_date ?? ''),
            type: String(permit.permit_type ?? ''),
            status: String(permit.status ?? ''),
          },
        })),
      }
      permitsCacheRef.current[countyKey] = permitsGeoJSON

      // Bail out if the user switched away from this county while the
      // network round-trip was in flight.
      if (countyKey !== selectedCountyRef.current || !map.current) return
    }

    if (!mapInstance.getSource('permits')) {
      mapInstance.addSource('permits', { type: 'geojson', data: permitsGeoJSON })
      mapInstance.addLayer({
        id: 'permits-layer',
        type: 'circle',
        source: 'permits',
        layout: { visibility: showPermits ? 'visible' : 'none' },
        paint: {
          'circle-radius': 7,
          'circle-color': '#2563eb',
          'circle-opacity': 0.85,
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': 1,
        },
      })

      const clickHandler = (event: mapboxgl.MapLayerMouseEvent) => {
        const props = event.features?.[0]?.properties
        if (!props || !map.current) return
        new mapboxgl.Popup({ closeButton: false, offset: 10 })
          .setLngLat((event.features?.[0]?.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(`<div style="font-family:Inter,sans-serif;font-size:12px;padding:6px">
            <div style="font-weight:600;color:#1d4ed8">New Permit Filed</div>
            <div style="font-weight:500;margin-top:2px">${props.lease ?? ''}</div>
            <div style="color:#6b7280">${props.operator ?? ''}</div>
            <div style="color:#6b7280;font-size:11px">Filed: ${props.date ?? ''}</div>
          </div>`)
          .addTo(map.current)
      }
      const mouseEnterHandler = () => {
        map.current?.getCanvas().style.setProperty('cursor', 'pointer')
      }
      const mouseLeaveHandler = () => {
        if (map.current) map.current.getCanvas().style.cursor = ''
      }

      permitHandlersRef.current = { clickHandler, mouseEnterHandler, mouseLeaveHandler }
      mapInstance.on('click', 'permits-layer', clickHandler)
      mapInstance.on('mouseenter', 'permits-layer', mouseEnterHandler)
      mapInstance.on('mouseleave', 'permits-layer', mouseLeaveHandler)
    } else {
      const source = mapInstance.getSource('permits') as mapboxgl.GeoJSONSource
      source.setData(permitsGeoJSON)
    }

    if (mapInstance.getLayer('permits-layer')) {
      mapInstance.setLayoutProperty('permits-layer', 'visibility', showPermits ? 'visible' : 'none')
    }
  }, [showPermits])

  const setupCountyOverview = useCallback(async () => {
    const mapInstance = map.current
    if (!mapInstance) return

    const renderToken = ++renderTokenRef.current
    clearTractLayers(mapInstance)
    clearCountyOverviewLayers(mapInstance)
    clearCountyMarkers()

    const response = await fetch('https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json')
    if (!response.ok || renderToken !== renderTokenRef.current || !map.current) return

    const geojson = await response.json() as GeoJSON.FeatureCollection
    if (renderToken !== renderTokenRef.current || !map.current) return

    const activeFipsSet = new Set<string>()
    const activeCountyByFips: Record<string, CountyKey> = {}
    countyEntries.forEach(([countyKey, countyConfig]) => {
      activeFipsSet.add(countyConfig.fips)
      activeCountyByFips[countyConfig.fips] = countyKey
    })
    activeCountyByFipsRef.current = activeCountyByFips

    const texasFeatures = (geojson.features ?? [])
      .map((feature) => {
        const properties = (feature.properties ?? {}) as Record<string, unknown>
        const fips = String(feature.id ?? properties.GEOID ?? properties.FIPS ?? '').trim()
        if (!fips.startsWith('48')) return null
        return {
          ...feature,
          id: fips,
          properties: { ...properties, __fips: fips },
        } as GeoJSON.Feature
      })
      .filter(Boolean) as GeoJSON.Feature[]

    if (!map.current) return
    map.current.addSource('tx-counties', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: texasFeatures },
    })

    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-fill',
      type: 'fill',
      source: 'tx-counties',
      paint: { 'fill-color': '#E5E7EB', 'fill-opacity': 0.35 },
    })
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-outline',
      type: 'line',
      source: 'tx-counties',
      paint: { 'line-color': '#D1D5DB', 'line-width': 0.5 },
    })
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-active-fill',
      type: 'fill',
      source: 'tx-counties',
      filter: ['in', ['get', '__fips'], ['literal', Array.from(activeFipsSet)]],
      paint: {
        'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#D97706', '#EF9F27'],
        'fill-opacity': 0.75,
      },
    })
    if (!map.current) return
    map.current.addLayer({
      id: 'tx-counties-active-outline',
      type: 'line',
      source: 'tx-counties',
      filter: ['in', ['get', '__fips'], ['literal', Array.from(activeFipsSet)]],
      paint: { 'line-color': '#D97706', 'line-width': 1.5 },
    })

    const moveHandler = (event: mapboxgl.MapLayerMouseEvent) => {
      if (!map.current) return
      map.current.getCanvas().style.cursor = 'pointer'
      const feature = event.features?.[0]
      const fips = String(feature?.id ?? ((feature?.properties ?? {}) as Record<string, unknown>).__fips ?? '').trim()
      if (!fips) return
      const previous = countyOverviewHandlersRef.current.hoveredFips
      if (previous && previous !== fips) {
        map.current.setFeatureState({ source: 'tx-counties', id: previous }, { hover: false })
      }
      countyOverviewHandlersRef.current.hoveredFips = fips
      map.current.setFeatureState({ source: 'tx-counties', id: fips }, { hover: true })
    }
    const leaveHandler = () => {
      if (!map.current) return
      map.current.getCanvas().style.cursor = ''
      const previous = countyOverviewHandlersRef.current.hoveredFips
      if (previous) map.current.setFeatureState({ source: 'tx-counties', id: previous }, { hover: false })
      countyOverviewHandlersRef.current.hoveredFips = null
    }
    const clickHandler = (event: mapboxgl.MapLayerMouseEvent) => {
      const feature = event.features?.[0]
      const fips = String(feature?.id ?? ((feature?.properties ?? {}) as Record<string, unknown>).__fips ?? '').trim()
      const countyKey = activeCountyByFipsRef.current[fips]
      if (!countyKey) return
      if (onCountySelectRef.current) {
        onCountySelectRef.current(countyKey)
      } else {
        onCountySwitchRef.current(countyKey)
      }
    }

    countyOverviewHandlersRef.current = { moveHandler, leaveHandler, clickHandler, hoveredFips: null }
    map.current.on('mousemove', 'tx-counties-active-fill', moveHandler)
    map.current.on('mouseleave', 'tx-counties-active-fill', leaveHandler)
    map.current.on('click', 'tx-counties-active-fill', clickHandler)

    countyEntries.forEach(([, countyConfig]) => {
      const markerElement = document.createElement('div')
      markerElement.style.background = '#FFFFFF'
      markerElement.style.border = '1px solid #E5E7EB'
      markerElement.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)'
      markerElement.style.fontSize = '11px'
      markerElement.style.padding = '6px 12px'
      markerElement.style.borderRadius = '999px'
      markerElement.style.pointerEvents = 'none'
      markerElement.style.fontFamily = 'Inter, sans-serif'
      markerElement.style.color = '#111827'
      markerElement.style.whiteSpace = 'nowrap'
      markerElement.style.lineHeight = '1.2'
      markerElement.innerHTML = `<div style="font-weight:700">${countyConfig.name} County</div><div style="color:#6B7280">~${(countyConfig.totalLeads / 1000).toFixed(0)},000 leads</div>`

      const marker = new mapboxgl.Marker({ element: markerElement, anchor: 'center' })
        .setLngLat(countyConfig.mapCenter)
        .addTo(map.current as mapboxgl.Map)
      countyMarkersRef.current.push(marker)
    })

    map.current.flyTo({ center: TEXAS_OVERVIEW_CENTER, zoom: TEXAS_OVERVIEW_ZOOM, duration: 800 })
  }, [clearCountyMarkers, clearCountyOverviewLayers, clearTractLayers, countyEntries])

  const setupTractLevel = useCallback(async () => {
    const mapInstance = map.current
    if (!mapInstance) return

    const renderToken = ++renderTokenRef.current
    clearCountyOverviewLayers(mapInstance)
    clearCountyMarkers()
    clearTractLayers(mapInstance)

    // Always pull the slim map-only GeoJSON (props the renderer needs, no
    // owners_json payload). The full enriched file is still fetched by the
    // side panel in app/page.tsx for owner data. Counties load in parallel
    // so adding more never serializes the cold-load latency.
    const fetchTasks = countyEntries.map(async ([countyKey, countyConfig]) => {
      const response = await fetch(countyConfig.mapGeoJsonPath ?? countyConfig.geoJsonPath)
      if (!response.ok) {
        throw new Error(`Parcels source failed for ${countyConfig.id} (${response.status})`)
      }
      const geojson = await response.json() as GeoJSON.FeatureCollection
      return [countyKey, geojson] as const
    })
    const parcelsByCounty: Array<readonly [CountyKey, GeoJSON.FeatureCollection]> = await Promise.all(fetchTasks)
    if (renderToken !== renderTokenRef.current || !map.current) return

    currentParcelsByCountyRef.current = {}
    parcelsByCounty.forEach(([countyKey, geojson]) => {
      currentParcelsByCountyRef.current[countyKey] = geojson
      const countyConfig = COUNTIES[countyKey]
      const sourceId = `parcels-${countyConfig.id}`
      const fillId = `parcels-fill-${countyConfig.id}`
      const outlineId = `parcels-outline-${countyConfig.id}`
      const labelsId = `parcels-labels-${countyConfig.id}`

      if (!map.current) return
      map.current.addSource(sourceId, {
        type: 'geojson',
        data: geojson,
        generateId: true,
        // Default tolerance is 0.375 px which aggressively simplifies small
        // polygons at low zoom — Howard's RRC abstract sections are tightly
        // clustered ~2 km wide and were collapsing out of low-zoom tiles, so
        // the fill layer had nothing to paint until you zoomed past 10. The
        // lower tolerance keeps every polygon present from the first tile
        // load while still trimming redundant vertices. The buffer bump
        // reduces edge clipping artifacts when panning at the tract level.
        tolerance: 0.05,
        buffer: 256,
      })
      if (!map.current) return
      map.current.addLayer({
        id: fillId,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': '#9E9E9E',
          'fill-opacity': 0.25,
        },
      })
      if (!map.current) return
      map.current.addLayer({
        id: outlineId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#CBD5E1',
          'line-width': 0.8,
          'line-opacity': 1,
        },
      })

      if (!map.current) return
      // Parcel labels: survey/grantee name on line 1, abstract label on
      // line 2, centered inside each tract. Fades in between zoom 9–10 and
      // scales from 8px at z10 to 13px at z14.
      map.current.addLayer({
        id: labelsId,
        type: 'symbol',
        source: sourceId,
        minzoom: 9,
        layout: {
          'text-field': [
            'format',
            [
              'coalesce',
              ['get', 'Surv_Name'],
              ['get', 'LEVEL1_SUR'],
              ['get', 'DESC_'],
              '',
            ],
            {},
            '\n',
            {},
            [
              'coalesce',
              ['get', 'ABSTRACT_L'],
              ['concat', 'A-', ['to-string', ['get', 'ABSTRACT_N']]],
              '',
            ],
            {},
          ],
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, 8,
            14, 13,
          ],
          'text-anchor': 'center',
          'text-justify': 'center',
          'text-max-width': 8,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 1,
          'text-halo-blur': 0.5,
          'text-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9, 0,
            10, 1,
          ],
        },
      })

      if (!map.current) return
      // Per-tract section number rendered from Surv_Sect. Only shown at z10+
      // so we don't clutter the overview zooms.
      const sectionsId = `parcels-sections-${countyConfig.id}`
      map.current.addLayer({
        id: sectionsId,
        type: 'symbol',
        source: sourceId,
        minzoom: 10,
        layout: {
          'text-field': ['coalesce', ['get', 'Surv_Sect'], ''],
          'text-size': 11,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'center',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#1a1a1a',
          'text-halo-width': 1.5,
        },
      })

      if (!map.current) return
      // Block labels: one point per distinct Block value, placed at the
      // averaged centroid of all tracts in that block. Visible earlier than
      // section numbers since blocks are larger aggregations.
      const blockSourceId = `block-labels-source-${countyConfig.id}`
      const blockLayerId = `block-labels-${countyConfig.id}`
      const blockFeatureCollection = buildBlockLabelFeatureCollection(geojson)
      if (blockFeatureCollection.features.length > 0) {
        map.current.addSource(blockSourceId, { type: 'geojson', data: blockFeatureCollection })
        if (!map.current) return
        map.current.addLayer({
          id: blockLayerId,
          type: 'symbol',
          source: blockSourceId,
          minzoom: 8,
          layout: {
            'text-field': ['concat', 'Block ', ['get', 'block']],
            'text-size': 13,
            'text-font': ['DIN Offc Pro Bold', 'Arial Unicode MS Bold'],
            'text-anchor': 'center',
            'text-allow-overlap': false,
            'symbol-placement': 'point',
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 2,
          },
        })
      }

      const mouseEnterHandler = () => {
        map.current?.getCanvas().style.setProperty('cursor', 'pointer')
      }
      const mouseLeaveHandler = () => {
        if (map.current) map.current.getCanvas().style.cursor = ''
      }

      tractHandlersRef.current.push({
        layerId: fillId,
        mouseEnterHandler,
        mouseLeaveHandler,
      })

      if (!map.current) return
      map.current.on('mouseenter', fillId, mouseEnterHandler)
      map.current.on('mouseleave', fillId, mouseLeaveHandler)
    })

    if (tractClickHandlerRef.current) {
      map.current?.off('click', tractClickHandlerRef.current)
      tractClickHandlerRef.current = null
    }

    const handler = (event: mapboxgl.MapMouseEvent) => {
      if (!map.current) return
      const now = Date.now()
      if (now - lastClickTimeRef.current < 1000) return
      lastClickTimeRef.current = now

      const layerIds = countyEntries
        .map(([, countyConfig]) => `parcels-fill-${countyConfig.id}`)
        .filter((id) => !!map.current?.getLayer(id))
      if (layerIds.length === 0) return

      const features = map.current.queryRenderedFeatures(event.point, { layers: layerIds })
      if (!features?.length) return

      const selectedLayerId = `parcels-fill-${COUNTIES[selectedCountyRef.current].id}`
      const topFeature = features.find((feature) => feature.layer?.id === selectedLayerId) ?? features[0]
      const topLayerId = topFeature.layer?.id
      if (!topLayerId) return
      const topCountyId = topLayerId.replace('parcels-fill-', '')
      const countyKey = countyEntries.find(([, countyConfig]) => countyConfig.id === topCountyId)?.[0]
      if (!countyKey) return

      const props = topFeature.properties as Record<string, unknown> | undefined
      if (countyKey !== selectedCountyRef.current) {
        onCountySwitchRef.current(countyKey)
        return
      }

      if (props) {
        onOwnerClickRef.current(props as Record<string, unknown>)
      }

      const clickedAbstract = props?.ABSTRACT_L ?? props?.CODE ?? props?.abstract_label
      const countyGeoJSON = currentParcelsByCountyRef.current[countyKey]
      const matchedFeature = countyGeoJSON?.features?.find((feature) => {
        const featureProps = feature.properties as Record<string, unknown>
        return featureProps?.ABSTRACT_L === clickedAbstract ||
          featureProps?.CODE === clickedAbstract ||
          String(featureProps?.CODE) === String(clickedAbstract)
      })
      const geometry = matchedFeature?.geometry ?? (topFeature.geometry as GeoJSON.Geometry | undefined)
      if (geometry) {
        setTimeout(() => {
          if (map.current) {
            try {
              fitGeometry(map.current, geometry)
            } catch (e) {
              console.error('fitGeometry error:', e)
            }
          }
        }, 200)
      }
    }

    tractClickHandlerRef.current = handler
    if (!map.current) return
    map.current.on('click', handler)

    await loadSelectedCountyPermits()
    if (renderToken !== renderTokenRef.current || !map.current) return
    applyTractCountyStyles()
  }, [applyTractCountyStyles, clearCountyMarkers, clearCountyOverviewLayers, clearTractLayers, countyEntries, loadSelectedCountyPermits])

  const renderForCurrentLevel = useCallback(async () => {
    if (!map.current) return
    if (mapLevel === 'county') {
      await setupCountyOverview()
      return
    }
    await setupTractLevel()
  }, [mapLevel, setupCountyOverview, setupTractLevel])

  useEffect(() => {
    renderForCurrentLevelRef.current = renderForCurrentLevel
  }, [renderForCurrentLevel])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (map.current || !mapContainer.current) return
    // Without a token mapbox-gl throws synchronously on construction, which
    // takes the whole workspace down. Leave the container empty and let the
    // placeholder below explain what is missing.
    if (!MAPBOX_TOKEN) return

    const mapInstance = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: TEXAS_OVERVIEW_CENTER,
      zoom: TEXAS_OVERVIEW_ZOOM,
    })
    map.current = mapInstance

    const onLoad = () => {
      setMapReady(true)
      void renderForCurrentLevelRef.current()
    }
    mapInstance.on('load', onLoad)

    return () => {
      clearCountyMarkers()
      if (map.current) {
        if (tractClickHandlerRef.current) {
          map.current.off('click', tractClickHandlerRef.current)
          tractClickHandlerRef.current = null
        }
        clearCountyOverviewLayers(map.current)
        clearTractLayers(map.current)
      }
      map.current?.remove()
      map.current = null
      setMapReady(false)
      renderTokenRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!map.current) return
    if (!map.current.isStyleLoaded()) {
      map.current.once('load', () => {
        void renderForCurrentLevelRef.current()
      })
      return
    }
    void renderForCurrentLevelRef.current()
  }, [mapLevel])

  useEffect(() => {
    if (!mapFlyToRef) return
    mapFlyToRef.current = (center, zoom) => {
      map.current?.flyTo({ center, zoom, duration: 800 })
    }
    return () => {
      mapFlyToRef.current = null
    }
  }, [mapFlyToRef])

  useEffect(() => {
    if (!map.current?.isStyleLoaded()) return
    if (mapLevel !== 'tract') return
    applyTractCountyStyles()
    void loadSelectedCountyPermits()
  }, [applyTractCountyStyles, loadSelectedCountyPermits, mapLevel, selectedCounty])

  useEffect(() => {
    if (!map.current?.isStyleLoaded()) return
    if (!map.current) return
    if (map.current.getLayer('permits-layer')) {
      map.current.setLayoutProperty('permits-layer', 'visibility', mapLevel === 'tract' && showPermits ? 'visible' : 'none')
    }
  }, [mapLevel, showPermits])

  useEffect(() => {
    if (mapLevel !== 'tract') return
    if (!focusTarget || !map.current?.isStyleLoaded()) return

    const features = currentParcelsByCountyRef.current[selectedCountyRef.current]?.features ?? []
    const selectedAbstract = String(focusTarget.abstract_label ?? focusTarget.ABSTRACT_L ?? '').trim()
    const selectedSurvey = String(focusTarget.level1_sur ?? focusTarget.LEVEL1_SUR ?? '').trim()
    if (!selectedAbstract || !selectedSurvey) return

    const matched = features.find((feature) => {
      const props = (feature.properties ?? {}) as Record<string, unknown>
      const featureAbstract = String(props.abstract_label ?? props.ABSTRACT_L ?? '').trim()
      const featureSurvey = String(props.level1_sur ?? props.LEVEL1_SUR ?? '').trim()
      return featureAbstract === selectedAbstract && featureSurvey === selectedSurvey
    })

    if (matched?.geometry) {
      fitGeometry(map.current, matched.geometry)
    }
  }, [focusTarget, mapLevel, selectedCounty])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      {!MAPBOX_TOKEN && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background:
              'linear-gradient(rgba(17,24,39,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(17,24,39,0.04) 1px, transparent 1px), #F4F5F7',
            backgroundSize: '40px 40px, 40px 40px, auto',
          }}
        >
          <div className="mm-card mm-card-pad" style={{ maxWidth: 360, textAlign: 'center' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#111827' }}>Map tiles unavailable</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 6, lineHeight: 1.5 }}>
              Set <code style={{ fontFamily: 'var(--mm-font-mono)', fontSize: 11 }}>NEXT_PUBLIC_MAPBOX_TOKEN</code> to
              render county and tract layers. Owner data and filters still work.
            </div>
          </div>
        </div>
      )}
      {mapReady && (
        <TractSearch
          map={map.current}
          geojsonUrl={COUNTIES[selectedCounty].mapGeoJsonPath ?? COUNTIES[selectedCounty].geoJsonPath}
        />
      )}
    </div>
  )
}
