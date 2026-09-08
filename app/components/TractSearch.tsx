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
    <div ref={containerRef} className="absolute top-4 left-4 z-10 w-72">
      <div className="relative">
        <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => query && results.length > 0 && setOpen(true)}
          placeholder={loading ? "Loading tracts..." : "Search tracts (A-361, T&P RR CO...)"}
          disabled={loading}
          className="
            w-full pl-9 pr-8 py-2.5
            bg-[#1a1a2e] border border-gray-700
            rounded-lg text-sm text-white placeholder-gray-500
            focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/30
            shadow-lg disabled:opacity-50
          "
        />
        {query && (
          <button
            onClick={() => { setQuery(""); setResults([]); setOpen(false); inputRef.current?.focus(); }}
            className="absolute inset-y-0 right-2.5 flex items-center text-gray-500 hover:text-gray-300"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div className="
          mt-1 w-full bg-[#1a1a2e] border border-gray-700
          rounded-lg shadow-xl overflow-hidden max-h-64 overflow-y-auto
        ">
          {results.map((tract, i) => (
            <button
              key={`${tract.abstract_l}-${i}`}
              onClick={() => handleSelect(tract)}
              className="
                w-full px-3 py-2.5 text-left
                hover:bg-gray-800 transition-colors
                border-b border-gray-800 last:border-0
                flex items-center gap-3
              "
            >
              <span className="shrink-0 text-xs font-mono font-semibold bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded">
                {tract.abstract_l}
              </span>
              <span className="text-sm text-gray-200 truncate">
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
