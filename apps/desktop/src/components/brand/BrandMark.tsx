export function BrandMark({ className }: { className?: string }) {
  return <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true" data-brand-mark>
    <path d="M25 6H12L6 13H22L26 20L20 26H7M12 6L7 26M25 6L20 26"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
