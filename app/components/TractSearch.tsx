"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";

interface TractFeature {
  abstract_l: string;
  abstract_n: string;
  level1_sur: string;
  display: string;
  center: [number, number];
  bbox: [number, number, number, number];
}

interface TractSearchProps {
  map: mapboxgl.Map | null;
  geojsonUrl: string;
  onTractSelect?: (abstractL: string) => void;
}

export default function TractSearch({ map, geojsonUrl, onTractSelect }: TractSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TractFeature[]>([]);
  const [allTracts, setAllTracts] = useState<TractFeature[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightMarkerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    fetch(geojsonUrl)
      .then((r) => r.json())
      .then((gj) => {
        const tracts: TractFeature[] = [];

        for (const feature of gj.features) {
          const props = feature.properties ?? {};
          const abstractL: string = props.ABSTRACT_L ?? props.abstract_l ?? "";
          const abstractN: string = props.ABSTRACT_N ?? props.abstract_n ?? "";
          const level1Sur: string = props.LEVEL1_SUR ?? props.level1_sur ?? "";

          if (!abstractL) continue;

          const coords = flattenCoords(feature.geometry);
          if (!coords.length) continue;

          const lngs = coords.map((c: number[]) => c[0]);
          const lats = coords.map((c: number[]) => c[1]);
          const minLng = Math.min(...lngs);
          const maxLng = Math.max(...lngs);
          const minLat = Math.min(...lats);
          const maxLat = Math.max(...lats);

          tracts.push({
            abstract_l: abstractL,
            abstract_n: abstractN,
            level1_sur: level1Sur,
            display: `${abstractN} ${abstractL}`.trim(),
            center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
            bbox: [minLng, minLat, maxLng, maxLat],
          });
        }

        tracts.sort((a, b) => {
          const numA = parseInt(a.abstract_l.replace(/\D/g, "") || "0");
          const numB = parseInt(b.abstract_l.replace(/\D/g, "") || "0");
          return numA - numB;
        });

        setAllTracts(tracts);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [geojsonUrl]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }

    const q = query.toLowerCase().trim();
    const filtered = allTracts
      .filter((t) =>
        t.abstract_l.toLowerCase().includes(q) ||
        t.abstract_n.toLowerCase().includes(q) ||
        t.level1_sur.toLowerCase().includes(q) ||
        t.display.toLowerCase().includes(q)
      )
      .slice(0, 12);

    setResults(filtered);
    setOpen(filtered.length > 0);
  }, [query, allTracts]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSelect = useCallback(
    (tract: TractFeature) => {
      setQuery(tract.display);
      setOpen(false);

      if (!map) return;

      map.fitBounds(
        [[tract.bbox[0], tract.bbox[1]], [tract.bbox[2], tract.bbox[3]]],
        { padding: 120, maxZoom: 14, duration: 800 }
      );

      if (highlightMarkerRef.current) {
        highlightMarkerRef.current.remove();
      }

      const el = document.createElement("div");
      el.style.cssText = `
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #fff;
        border: 2px solid #f97316;
        box-shadow: 0 0 0 4px rgba(249,115,22,0.3);
        pointer-events: none;
      `;

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat(tract.center)
        .addTo(map);

      highlightMarkerRef.current = marker;

      setTimeout(() => {
        marker.remove();
        if (highlightMarkerRef.current === marker) highlightMarkerRef.current = null;
      }, 4000);

      onTractSelect?.(tract.abstract_l);
    },
    [map, onTractSelect]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={containerRef} className="absolute top-3 left-3 z-10 w-72">
      <div className="mm-search-field" style={{ background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(6px)', boxShadow: 'var(--mm-shadow-2)' }}>
        <span className="mm-search-icon">
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => query && results.length > 0 && setOpen(true)}
          placeholder={loading ? "Loading tracts" : "Search tracts (A-361, T&P RR CO)"}
          disabled={loading}
          aria-label="Search tracts"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(""); setResults([]); setOpen(false); inputRef.current?.focus(); }}
            className="mm-btn mm-btn-ghost mm-btn-icon mm-btn-xs"
            aria-label="Clear tract search"
            style={{ width: 22 }}
          >
            <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div className="mm-popover" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {results.map((tract, i) => (
            <button
              type="button"
              key={`${tract.abstract_l}-${i}`}
              onClick={() => handleSelect(tract)}
              className="mm-popover-row"
              style={{ width: '100%', border: 'none', background: 'none', textAlign: 'left', justifyContent: 'flex-start', padding: '8px 12px' }}
            >
              <span className="mm-chip mm-chip-amber mm-num" style={{ flexShrink: 0 }}>
                {tract.abstract_l}
              </span>
              <span className="mm-row-title" style={{ fontWeight: 500 }}>
                {tract.abstract_n || tract.level1_sur || "-"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function flattenCoords(geometry: GeoJSON.Geometry): number[][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates[0] as number[][];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2) as unknown as number[][];
  return [];
}
