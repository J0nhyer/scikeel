import { useUiStore } from "@/lib/store";

export function EmptySessionDecoration({ bottomInset = 0 }: { bottomInset?: number }) {
  const enabled = useUiStore((s) => s.theme === "cdut" && s.campusDecoration);
  if (!enabled) return null;
  return <div data-testid="campus-empty-decoration" aria-hidden="true" style={{ bottom: bottomInset }} className="pointer-events-none absolute inset-0 flex items-center justify-center select-none overflow-hidden">
    <svg viewBox="0 0 300 300" className="absolute -right-16 -top-40 hidden h-72 w-72 text-accent opacity-[0.12] sm:block" fill="none">
      <path d="M20 155C65 90 160 150 187 99S265 65 295 5M12 173C65 108 160 168 205 111S281 89 307 13M4 191C65 126 160 186 223 123S297 113 319 21M-4 209C65 144 160 204 241 135S313 137 331 29M-12 227C65 162 160 222 259 147S329 161 343 37" stroke="currentColor" />
    </svg>
    <img data-campus-motto src="/assets/brand/cdut-motto-color.png" alt="" className="block w-[72%] max-w-[540px] opacity-[0.045]" />
  </div>;
}
