/** Small drawings of the demo items; anything else gets its initial. Keyed by `defId`, never by `marketId`. */
export function ItemGlyph({ defId, name, size = 28 }: { defId: string; name: string; size?: number }) {
  return (
    <span className="item-glyph" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.78} height={size * 0.78}>
        {glyph(defId, name)}
      </svg>
    </span>
  )
}

function glyph(defId: string, name: string) {
  switch (defId) {
    case 'iron_ore':
      return (
        <g strokeLinejoin="round">
          <path d="M3.5 15 6 7.5 11 4.5l6.5 1.5 3 5.5-2 7-7 2-5.5-1.5Z" fill="#3b404b" stroke="#a7aebb" strokeWidth="1.2" />
          <path d="m11 4.5-1.5 6 8-4.5M9.5 10.5 3.5 15m6-4.5 2 9.5m-2-9.5 11 1" stroke="#646b78" strokeWidth="0.9" fill="none" />
          <circle cx="14.5" cy="13.5" r="1.1" fill="#c88a6c" />
          <circle cx="7.3" cy="15.6" r="0.8" fill="#c88a6c" />
          <circle cx="13" cy="8.6" r="0.7" fill="#c88a6c" />
        </g>
      )
    case 'coal':
      return (
        <g strokeLinejoin="round">
          <path d="M4 14.5c-.6-4.6 3-8.6 8-8.8 5.2-.2 8.6 3.6 7.8 8.2-.7 4-4.7 6.3-9 5.9-3.7-.3-6.4-2.1-6.8-5.3Z" fill="#1f2228" stroke="#868e9c" strokeWidth="1.2" />
          <path d="M8 10.5c1.4-1.6 3.4-2.2 5.2-1.8" stroke="#c4c9d2" strokeWidth="1.1" strokeLinecap="round" fill="none" />
          <path d="m12 6 1.6 5.2 6 2.4M13.6 11.2l-4.6 8.4" stroke="#4a505c" strokeWidth="0.9" fill="none" />
        </g>
      )
    case 'crystal':
      return (
        <g strokeLinejoin="round">
          <path d="M12 2.2 18 8.4 12 21.8 6 8.4Z" fill="#2b303a" stroke="#d3d7de" strokeWidth="1.2" />
          <path d="M6 8.4h12M12 2.2 9.6 8.4 12 21.8l2.4-13.4L12 2.2" stroke="#8f97a5" strokeWidth="0.9" fill="none" />
          <path d="M12 2.2 14.4 8.4h3.6Z" fill="#e6e9ee" opacity="0.35" />
        </g>
      )
    default:
      return (
        <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="700" fill="#c4c9d2">
          {name.charAt(0).toUpperCase()}
        </text>
      )
  }
}
