/** The one loading surface for the managed Web client. The server login
 *  handoff renders the same mark and ring; keep this text-free. */
export function LoadingSurface() {
  return (
    <div
      data-testid="loading-surface"
      data-scikeel-boot-gate="1"
      role="status"
      aria-busy="true"
      className="loading-surface fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-bg text-text"
    >
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className="h-11 w-11 text-accent">
        <path
          d="M25 6H12L6 13H22L26 20L20 26H7M12 6L7 26M25 6L20 26"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
        className="h-8 w-8 animate-spin text-muted motion-reduce:animate-none"
      >
        <circle cx="12" cy="12" r="9" opacity=".25" />
        <path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round" />
      </svg>
    </div>
  );
}
