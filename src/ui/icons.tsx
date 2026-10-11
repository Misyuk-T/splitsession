import type { ComponentChildren } from 'preact';

/** The icon set of the popup: simple outlines, 1.5px stroke, 24-unit grid, drawn in the text colour. Decorative: the button carries the name. */
function Icon({ size = 20, children }: { size?: number; children: ComponentChildren }) {
  return (
    <svg class="fx-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const IconSettings = () => (
  <Icon>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const IconMore = () => (
  <Icon>
    <circle cx="5.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconSwap = () => (
  <Icon>
    <path d="M5 8.5h13.5M15 5l3.5 3.5L15 12" />
    <path d="M19 15.5H5.5M9 12l-3.5 3.5L9 19" />
  </Icon>
);

export const IconPlus = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconChevron = () => (
  <Icon size={16}>
    <path d="M7 9.5l5 5 5-5" />
  </Icon>
);
