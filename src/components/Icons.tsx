/**
 * @fileoverview Small stroke icon set (16px grid) so the UI doesn't rely on emoji or
 * unicode glyphs.
 */

import type {ReactNode, SVGProps} from 'react';

type IconProps = SVGProps<SVGSVGElement> & {size?: number};

const base: SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
};

function make(children: ReactNode) {
  return function Icon({size = 14, ...props}: IconProps) {
    return (
      <svg {...base} width={size} height={size} {...props}>
        {children}
      </svg>
    );
  };
}

export const IconCheck = make(<path d="M3.5 8.5l3 3 6-7" />);
export const IconX = make(<path d="M4 4l8 8M12 4l-8 8" />);
export const IconAlert = make(
  <>
    <path d="M8 2.5l6 11H2z" />
    <path d="M8 7v3M8 12v.01" />
  </>,
);
export const IconPause = make(<path d="M5.5 3.5v9M10.5 3.5v9" />);
export const IconPlay = make(<path d="M5 3.5l7 4.5-7 4.5z" />);
export const IconChevron = make(<path d="M4.5 6.5L8 10l3.5-3.5" />);
export const IconExternal = make(
  <>
    <path d="M9 3h4v4M13 3L7.5 8.5" />
    <path d="M11 9.5V13H3V5h3.5" />
  </>,
);
export const IconSun = make(
  <>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
  </>,
);
export const IconMoon = make(
  <path d="M13 9.5A5.5 5.5 0 116.5 3a4.5 4.5 0 006.5 6.5z" />,
);
export const IconAuto = make(
  <>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5v11" />
    <path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none" />
  </>,
);
export const IconShield = make(
  <path d="M8 1.75l5 2v4c0 3.2-2.2 5.5-5 6.5-2.8-1-5-3.3-5-6.5v-4z" />,
);
export const IconShieldOff = make(
  <>
    <path d="M8 1.75l5 2v4c0 3.2-2.2 5.5-5 6.5-2.8-1-5-3.3-5-6.5v-4z" />
    <path d="M2.5 2.5l11 11" />
  </>,
);
export const IconLock = make(
  <>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </>,
);
export const IconSearch = make(
  <>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3.5 3.5" />
  </>,
);
export const IconLogout = make(
  <>
    <path d="M6.5 2.5h-3v11h3" />
    <path d="M10 5l3 3-3 3M13 8H6.5" />
  </>,
);
export const IconArrowUp = make(<path d="M8 13V3.5M4 7l4-4 4 4" />);
export function IconLogo({size = 18}: {size?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="3" fill="var(--accent)" />
      <path
        d="M6 16.5V7.5h4.2a2.8 2.8 0 010 5.6H6"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16.5" cy="15" r="2" fill="#fff" />
    </svg>
  );
}
export const IconSettings = make(
  <>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </>,
);
export const IconPlus = make(<path d="M8 3v10M3 8h10" />);
export const IconEdit = make(
  <>
    <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    <path d="M9 4l3 3" />
  </>,
);
export const IconTrash = make(
  <>
    <path d="M2.5 4.5h11M6 4.5V3h4v1.5" />
    <path d="M4 4.5l.7 9h6.6l.7-9" />
  </>,
);
