import { useColorScheme } from "react-native";

// TCB Phone design system.
// One source of truth for colour, spacing, radius and type. Screens read tokens
// through `useTheme()` so the whole app tracks the system Light/Dark setting.
// Accent is the TCB brand red; neutrals follow iOS system-colour conventions so
// the app feels native rather than like a themed website.

export type ThemeColors = {
  // Backgrounds
  bg: string; // screen background (grouped)
  bgElevated: string; // nav bar / tab bar / sheets
  card: string; // list rows, cards
  cardPressed: string; // pressed state of a row/card
  fill: string; // subtle filled controls (keypad keys, chips)
  fillPressed: string;
  // Hairlines / borders
  separator: string; // list separators, borders
  // Text
  label: string; // primary text
  labelSecondary: string; // secondary text
  labelTertiary: string; // hints / placeholders
  labelOnAccent: string; // text on the red accent
  // Accent + semantics
  accent: string; // TCB red
  accentPressed: string;
  accentSoft: string; // tinted background wash of the accent
  success: string; // connected / registered
  successSoft: string;
  warning: string; // connecting / reconnecting
  danger: string; // end call / missed / failed
  dangerSoft: string;
  // Fixed
  keypadDigit: string; // large digit glyphs on keys
};

export type Theme = {
  scheme: "light" | "dark";
  colors: ThemeColors;
  spacing: (n: number) => number; // 4pt grid: spacing(4) => 16
  radius: { sm: number; md: number; lg: number; xl: number; pill: number };
  hairline: number;
};

const RED = "#E4002B"; // TCB brand red
const RED_DARK = "#FF3B4E"; // brighter for dark backgrounds

const light: ThemeColors = {
  bg: "#F2F2F7",
  bgElevated: "#FFFFFF",
  card: "#FFFFFF",
  cardPressed: "#E9E9EE",
  fill: "#E9E9EF",
  fillPressed: "#DCDCE3",
  separator: "#D8D8DD",
  label: "#0A0A0B",
  labelSecondary: "#6C6C72",
  labelTertiary: "#A6A6AC",
  labelOnAccent: "#FFFFFF",
  accent: RED,
  accentPressed: "#C10023",
  accentSoft: "rgba(228,0,43,0.10)",
  success: "#2FA84F",
  successSoft: "rgba(47,168,79,0.14)",
  warning: "#E08600",
  danger: "#E4002B",
  dangerSoft: "rgba(228,0,43,0.10)",
  keypadDigit: "#0A0A0B",
};

const dark: ThemeColors = {
  bg: "#000000",
  bgElevated: "#121214",
  card: "#1C1C1E",
  cardPressed: "#2A2A2D",
  fill: "#1E1E20",
  fillPressed: "#2C2C2F",
  separator: "#2C2C2E",
  label: "#FFFFFF",
  labelSecondary: "#9E9EA6",
  labelTertiary: "#68686F",
  labelOnAccent: "#FFFFFF",
  accent: RED_DARK,
  accentPressed: "#D4283B",
  accentSoft: "rgba(255,59,78,0.16)",
  success: "#34C759",
  successSoft: "rgba(52,199,89,0.18)",
  warning: "#FF9F0A",
  danger: "#FF453A",
  dangerSoft: "rgba(255,69,58,0.18)",
  keypadDigit: "#FFFFFF",
};

const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 };

export function useTheme(): Theme {
  const scheme = useColorScheme() ?? "light";
  const isDark = scheme === "dark";
  return {
    scheme: isDark ? "dark" : "light",
    colors: isDark ? dark : light,
    spacing: (n: number) => n * 4,
    radius,
    hairline: 0.5,
  };
}

// Type scale — iOS-native sizes/weights. Use as `type.headline`, spread into a Text style.
export const type = {
  largeTitle: { fontSize: 34, fontWeight: "700" as const, letterSpacing: 0.2 },
  title1: { fontSize: 28, fontWeight: "700" as const },
  title2: { fontSize: 22, fontWeight: "700" as const },
  title3: { fontSize: 20, fontWeight: "600" as const },
  headline: { fontSize: 17, fontWeight: "600" as const },
  body: { fontSize: 17, fontWeight: "400" as const },
  callout: { fontSize: 16, fontWeight: "400" as const },
  subhead: { fontSize: 15, fontWeight: "400" as const },
  footnote: { fontSize: 13, fontWeight: "400" as const },
  caption: { fontSize: 12, fontWeight: "400" as const, letterSpacing: 0.2 },
};
