/** The SplitSession mark: three stacked cards in container colours, the front one with a facet highlight. Same drawing as assets/icon.svg. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <defs>
        <clipPath id="fx-logo-front">
          <rect x="50" y="50" width="68" height="68" rx="16" />
        </clipPath>
      </defs>
      <rect x="10" y="10" width="68" height="68" rx="16" fill="#37adff" stroke="#0b1020" stroke-opacity=".28" stroke-width="3" />
      <rect x="30" y="30" width="68" height="68" rx="16" fill="#00c79a" stroke="#0b1020" stroke-opacity=".28" stroke-width="3" />
      <rect x="50" y="50" width="68" height="68" rx="16" fill="#af51f5" stroke="#0b1020" stroke-opacity=".28" stroke-width="3" />
      <g clip-path="url(#fx-logo-front)">
        <polygon points="50,50 118,50 50,118" fill="#fff" fill-opacity=".26" />
      </g>
    </svg>
  );
}
