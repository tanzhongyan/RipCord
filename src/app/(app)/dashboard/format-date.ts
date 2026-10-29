const sgDate = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Dates on the dashboard are shown in Singapore time. */
export function formatSgDate(date: Date): string {
  return sgDate.format(date);
}
