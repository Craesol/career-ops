// Brand mark — the Elder Sign (Cthulhu mythos): five-pointed star with the
// burning eye at its heart, white on brand orange. Replaces the original "co"
// monogram per the user's request; same box, same sizing API, so every
// call-site (sidebar, mobile header, Ask button) keeps its layout.
export function CoMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-md bg-brand text-white"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        width={Math.round(size * 0.78)}
        height={Math.round(size * 0.78)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {/* five-pointed star */}
        <path d="M12 2.6 L14.35 9.35 L21.5 9.55 L15.8 13.9 L17.85 20.75 L12 16.65 L6.15 20.75 L8.2 13.9 L2.5 9.55 L9.65 9.35 Z" />
        {/* the eye */}
        <path d="M8.9 12.9 Q12 10.7 15.1 12.9 Q12 15.1 8.9 12.9 Z" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12.9" r="0.85" fill="var(--brand, #d97917)" stroke="none" />
      </svg>
    </span>
  );
}
