import { ImageResponse } from "next/og";
import { site } from "~/shared/config/site";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Apple touch icon: mark C (white mark A on a coral square), opaque. */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#D85A30",
      }}
    >
      <svg
        width="120"
        height="120"
        viewBox="0 14 120 54"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="8"
        strokeLinecap="round"
        role="img"
        aria-label={site.name}
      >
        <path d="M8 42H44C52 42 55 36 57 24" />
        <path d="M63 60C65 48 68 42 76 42H112" />
      </svg>
    </div>,
    { ...size },
  );
}
