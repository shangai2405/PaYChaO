/** Small stroke icons, inline so the strict CSP needs no font or sprite. */
const PATHS = {
  projects: 'M4 5h16v4H4zM4 12h7v7H4zM14 12h6v7h-6z',
  guides: 'M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM9 9h6M9 13h6',
  key: 'M14 4a6 6 0 1 1-4.2 10.3L4 20M7 17l2 2M15.5 8.5h.01',
  sun: 'M12 7a5 5 0 1 1 0 10a5 5 0 0 1 0-10zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  system: 'M3 5h18v11H3zM8 20h8M12 16v4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
