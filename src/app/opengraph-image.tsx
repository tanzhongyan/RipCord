import { ImageResponse } from "next/og";
import { site } from "~/shared/config/site";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const paper = "#FAF8F3";
const ink = "#1B1F2A";
const cut = "#D85A30";

/** Social card: mark A (right stroke in coral), wordmark and tagline on paper. */
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 96,
        background: paper,
        color: ink,
      }}
    >
      <svg
        width="320"
        height="144"
        viewBox="0 14 120 54"
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        role="img"
        aria-label={site.name}
      >
        <path d="M8 42H44C52 42 55 36 57 24" stroke={ink} />
        <path d="M63 60C65 48 68 42 76 42H112" stroke={cut} />
      </svg>
      <div style={{ fontSize: 112, fontWeight: 700, marginTop: 40 }}>{site.name.toLowerCase()}</div>
      <div style={{ fontSize: 40, marginTop: 16 }}>{site.tagline}</div>
    </div>,
    { ...size },
  );
}
