import type { ReactNode } from "react";

// Inline stroke icons so buttons render the same on every OS (unicode glyphs vary by font).
const Svg = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconClose = () => (
  <Svg>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconMore = () => (
  <Svg>
    <circle cx="5" cy="12" r="1.3" fill="currentColor" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    <circle cx="19" cy="12" r="1.3" fill="currentColor" />
  </Svg>
);

export const IconDownload = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);

export const IconHelp = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7" />
    <circle cx="12" cy="17.2" r="0.6" fill="currentColor" />
  </Svg>
);

/** Chat bubble with a sound wave: "make it a chat sticker" (generic, not a brand logo). */
export const IconChatSound = () => (
  <Svg>
    <path d="M4 12a8 8 0 1 1 3.2 6.4L4 19.5l1.1-3.1A7.9 7.9 0 0 1 4 12z" />
    <path d="M9 10.5v3M12 9v6M15 10.5v3" />
  </Svg>
);

export const IconArrow = () => (
  <Svg>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

export const IconSpinner = () => (
  <span className="stik-spin">
    <Svg>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Svg>
  </span>
);

export const IconPlay = () => (
  <Svg size={14}>
    <path d="M7 5l12 7-12 7z" fill="currentColor" />
  </Svg>
);

export const IconStop = () => (
  <Svg size={14}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </Svg>
);
