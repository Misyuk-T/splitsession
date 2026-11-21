/** Minimal line icons for the dashboard. No icon font, no extra dependency. */

interface IconProps {
  size?: number;
  class?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.8,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  "aria-hidden": true as const,
  focusable: "false" as const,
});

export const IconDashboard = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconSession = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 9h18" />
    <path d="M7 5V3M17 5V3" />
  </svg>
);

export const IconSessions = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 9h18M7 5V3M17 5V3" />
    <rect x="8" y="13" width="4" height="4" rx="1" fill="currentColor" />
  </svg>
);

export const IconProfiles = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M16 4.5a3.2 3.2 0 0 1 0 7M18 14.5c2 .8 3 2.9 3 5.5" />
  </svg>
);

export const IconSettings = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

export const IconSearch = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </svg>
);

export const IconBell = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
    <path d="M10 21h4" />
  </svg>
);

export const IconPlus = ({ size = 18, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconClose = ({ size = 18, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

export const IconUp = ({ size = 16, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="m6 14 6-6 6 6" />
  </svg>
);

export const IconDown = ({ size = 16, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="m6 10 6 6 6-6" />
  </svg>
);

export const IconStar = ({ size = 16, class: className, filled = false }: IconProps & { filled?: boolean }) => (
  <svg {...base(size)} class={className} fill={filled ? "currentColor" : "none"}>
    <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
  </svg>
);

export const IconCheck = ({ size = 16, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="m5 12 4.5 4.5L19 7" />
  </svg>
);

export const IconChevron = ({ size = 16, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const IconMenu = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="M3 12h18M3 6h18M3 18h18" stroke-linecap="square" />
  </svg>
);

export const IconList = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <path d="M8 3h13M8 10h13M8 17h13" stroke-linecap="square" />
    <circle cx="3" cy="3" r="1" fill="none" stroke="currentColor" stroke-width="2" />
    <circle cx="3" cy="10" r="1" fill="none" stroke="currentColor" stroke-width="2" />
    <circle cx="3" cy="17" r="1" fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
);

export const IconGrid = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
  </svg>
);

export const IconTable = ({ size = 20, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18" stroke-linecap="square" />
  </svg>
);

export const IconPanel = ({ size = 16, class: className }: IconProps) => (
  <svg {...base(size)} class={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </svg>
);
