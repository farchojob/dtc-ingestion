"use client";

/**
 * The one client island on the console. Two links, one visible (CSS decides which by the html
 * class or, with no cookie, by the OS scheme). A click flips the class on <html> immediately and
 * writes the cookie the server reads on the next request, so the theme persists across reloads,
 * tabs and the CLI-driven demo without a round trip. Without JavaScript the links still work
 * through /theme, which sets the same cookie and redirects back.
 */
import { useCallback } from "react";
import { cn } from "cn";

const YEAR = 60 * 60 * 24 * 365;

function apply(theme: "light" | "dark"): void {
  const root = document.documentElement;
  root.classList.add("theme-animating");
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  document.cookie = `theme=${theme}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
  window.setTimeout(() => root.classList.remove("theme-animating"), 200);
}

export function ThemeSwitch({ back }: { back: string }) {
  const cls = "theme-switch rounded-[4px] border border-hairline-2 px-[7px] py-[3px] eyebrow text-ink-2 hover:border-ink hover:text-ink";
  const onClick = useCallback((theme: "light" | "dark") => (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    apply(theme);
  }, []);
  return (
    <>
      <a href={`/theme?to=dark&back=${encodeURIComponent(back)}`} onClick={onClick("dark")} className={cn(cls, "to-dark")} title="switch to the dark theme">dark</a>
      <a href={`/theme?to=light&back=${encodeURIComponent(back)}`} onClick={onClick("light")} className={cn(cls, "to-light")} title="switch to the light theme">light</a>
    </>
  );
}
