import { cookies } from "next/headers";

export type Theme = "light" | "dark";

/** The theme is a cookie read on the server, so the class lands on <html> before paint. No cookie: the OS decides (CSS). */
export async function currentTheme(): Promise<Theme | null> {
  const v = (await cookies()).get("theme")?.value;
  return v === "dark" || v === "light" ? v : null;
}
