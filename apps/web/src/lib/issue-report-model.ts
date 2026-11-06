import { z } from "zod";

export const ISSUE_CATEGORIES = [
  { value: "playback", label: "A song won't play or sounds wrong" },
  { value: "lyrics", label: "Lyrics are wrong or missing" },
  { value: "music-info", label: "Wrong song, artwork or details" },
  { value: "app", label: "Something in the app isn't working" },
  { value: "other", label: "Something else" },
] as const;

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number]["value"];
export const ISSUE_MESSAGE_MAX = 2000;
export const ISSUE_CONTEXT_MAX = 300;
export const ISSUE_REQUEST_MAX_BYTES = 8 * 1024;

// Strip control and bidi-override characters but keep line breaks and tabs.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

function cleanText(max: number, { multiline = false, min = 1 } = {}) {
  return z
    .string()
    .transform((value) => {
      const cleaned = value.normalize("NFC").replace(UNSAFE_CHARS, "").replace(/\r\n?/g, "\n");
      return (multiline ? cleaned.replace(/\n{3,}/g, "\n\n") : cleaned.replace(/\s+/g, " ")).trim();
    })
    .pipe(z.string().min(min).max(max));
}

export const issueReportInput = z.object({
  category: z.enum(ISSUE_CATEGORIES.map((category) => category.value) as [IssueCategory, ...IssueCategory[]]),
  message: cleanText(ISSUE_MESSAGE_MAX, { multiline: true }),
  context: cleanText(ISSUE_CONTEXT_MAX, { min: 0 })
    .nullish()
    .transform((context) => context || null),
});

export type IssueReportInput = z.output<typeof issueReportInput>;

export function issueCategoryLabel(category: string) {
  return ISSUE_CATEGORIES.find((item) => item.value === category)?.label ?? "Something else";
}

export interface IssueReportView {
  id: string;
  category: IssueCategory;
  message: string;
  context: string | null;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  reporter: { name: string; email: string } | null;
  resolvedBy: string | null;
}
