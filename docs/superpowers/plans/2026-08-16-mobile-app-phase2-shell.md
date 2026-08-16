# Mobile App Phase 2 — Expo Shell + Auth + Live Calls Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an Expo app in `mobile/` that logs in against the Worker API, stores the token securely, and shows a live Live-Calls screen — a vertical slice proving the app→auth→API pipeline.

**Architecture:** Expo (dev-client/EAS, not Expo Go) + Expo Router. `lib/session.ts` (secure-store token), `lib/api.ts` (Bearer fetch wrapper + 401 handling), `lib/auth.tsx` (AuthProvider/useAuth). Screens: `login.tsx`, `(tabs)/live.tsx`. Consumes Phase-1 endpoints `POST /api/login`, `POST /api/logout`, `GET /api/calls/live`.

**Tech Stack:** Expo (latest SDK), Expo Router, TypeScript, expo-secure-store, @tanstack/react-query, jest-expo + @testing-library/react-native.

## Global Constraints

- The app lives in **`mobile/`** — a SEPARATE npm project from the Worker at repo root. All app commands run from inside `mobile/`. Do NOT add app deps to the root `package.json`.
- **Resolve dependency versions with Expo's tooling**, never hand-pick: scaffold with `npx create-expo-app@latest`, add native/Expo deps with `npx expo install <pkg>` (it picks SDK-compatible versions), add pure-JS deps with `npm install <pkg>`. Do NOT hardcode version numbers in `package.json` by hand.
- **API base URL** comes from `process.env.EXPO_PUBLIC_API_BASE_URL`, defaulting to `https://phone.tcbpestcontrolcanberra.com.au` (no trailing slash). `EXPO_PUBLIC_`-prefixed vars are inlined by Expo at build time.
- **Session token** is stored ONLY via `expo-secure-store` (Keychain/Keystore), never AsyncStorage/plain storage. One key: `tcb_session_token`.
- Auth uses the Phase-1 contract exactly: login `POST /api/login` body `{email,password}` → `{token, user:{email,role}}`; every gated call sends `Authorization: Bearer <token>`; logout `POST /api/logout`. A `401` from any gated call clears the token and drops the user to `anon`.
- **Verification:** the automated gate is `npx tsc --noEmit` (from `mobile/`) + the jest unit tests for `session`/`api`/`auth`. Running the actual app / EAS build / on-device login is Phill's step — do NOT claim the app runs; claim only what tsc + jest prove.
- Match the Worker's TCB brand in RN styles: bg `#0f1013`, surface `#1b1d24`, border `#26282f`, text `#eceef2`, dim `#a7adb8`, brand `#e4002b`, link `#ff5c78`.
- Commit from repo root; stage only files under `mobile/` (plus this plan's doc edits). Do NOT touch the pre-existing modified `src/html/pages/ivrFlow.ts` or root `package.json`.
- A `mobile/.gitignore` must exclude `node_modules/`, `.expo/`, `dist/`, build artifacts.

---

### Task 1: Scaffold the Expo app + tooling

**Files:**
- Create: everything under `mobile/` (generated), plus `mobile/.env` and jest config.

**Interfaces:**
- Produces: a working Expo Router app in `mobile/` where `npx tsc --noEmit` passes and a smoke jest test runs; `EXPO_PUBLIC_API_BASE_URL` wired.

- [ ] **Step 1: Generate the app**

Run from repo root:
```bash
npx create-expo-app@latest mobile --template default --yes
```
Expected: creates `mobile/` with Expo Router (file-based `app/`), TypeScript, and an example tabs UI. `npm install` runs automatically (may take several minutes).

- [ ] **Step 2: Inspect what was generated**

Run:
```bash
ls mobile mobile/app && cat mobile/package.json && cat mobile/app.json
```
Note the SDK version, the entry/router setup, and the example screens (you'll replace them in later tasks). This is the "existing pattern" subsequent tasks build on.

- [ ] **Step 3: Add dependencies**

```bash
cd mobile
npx expo install expo-secure-store
npm install @tanstack/react-query
npx expo install --dev jest-expo jest @testing-library/react-native @types/jest
```
Expected: added to `mobile/package.json` with SDK-compatible versions chosen by `expo install`.

- [ ] **Step 4: Configure jest + the API base URL**

Add to `mobile/package.json` a jest preset and a test script:
```json
  "scripts": { "test": "jest", "typecheck": "tsc --noEmit" },
  "jest": { "preset": "jest-expo", "setupFilesAfterEnv": ["<rootDir>/jest.setup.ts"] }
```
Create `mobile/jest.setup.ts`:
```ts
// Silence Expo's async-storage / secure-store native warnings in tests where mocked.
```
Create `mobile/.env`:
```
EXPO_PUBLIC_API_BASE_URL=https://phone.tcbpestcontrolcanberra.com.au
```
Create `mobile/.gitignore` (if create-expo-app didn't already cover these — verify, then add any missing):
```
node_modules/
.expo/
dist/
*.log
.env.local
```
(Keep `.env` committed — it holds only the public base URL, no secrets.)

- [ ] **Step 5: Add a smoke test to prove jest works**

Create `mobile/__tests__/smoke.test.ts`:
```ts
describe("jest is wired", () => {
  it("runs", () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 6: Verify tooling**

```bash
cd mobile && npx tsc --noEmit && npm test
```
Expected: tsc clean; jest runs the smoke test (1 passing). If `tsc` flags the generated example screens, that's the template's own code — leave it for now unless it blocks; note any such errors in the report.

- [ ] **Step 7: Commit**

```bash
git add mobile/.gitignore mobile/package.json mobile/package-lock.json mobile/.env mobile/jest.setup.ts mobile/__tests__/smoke.test.ts
# also add the generated app files that should be tracked:
git add mobile/app.json mobile/tsconfig.json mobile/app mobile/assets mobile/*.js mobile/*.ts 2>/dev/null
git commit -m "feat(mobile): scaffold Expo app (router, secure-store, react-query, jest)"
```
(Confirm `mobile/node_modules` is NOT staged — it must be gitignored.)

---

### Task 2: Secure token store (`lib/session.ts`)

**Files:**
- Create: `mobile/lib/session.ts`, `mobile/__tests__/session.test.ts`

**Interfaces:**
- Produces: `getToken(): Promise<string|null>`, `setToken(token: string): Promise<void>`, `clearToken(): Promise<void>`. Key constant `TOKEN_KEY = "tcb_session_token"`.

- [ ] **Step 1: Write the failing test**

```ts
// mobile/__tests__/session.test.ts
jest.mock("expo-secure-store");
import * as SecureStore from "expo-secure-store";
import { getToken, setToken, clearToken } from "../lib/session";

describe("session token store", () => {
  beforeEach(() => jest.clearAllMocks());

  it("setToken writes to secure store under the token key", async () => {
    await setToken("abc.def");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("tcb_session_token", "abc.def");
  });
  it("getToken reads from secure store", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue("abc.def");
    expect(await getToken()).toBe("abc.def");
  });
  it("clearToken deletes the key", async () => {
    await clearToken();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("tcb_session_token");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

`cd mobile && npx jest __tests__/session.test.ts`
Expected: FAIL — `../lib/session` not found.

- [ ] **Step 3: Implement**

```ts
// mobile/lib/session.ts
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "tcb_session_token";

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}
export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
```

- [ ] **Step 4: Run — expect PASS**

`cd mobile && npx jest __tests__/session.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Typecheck + commit**

```bash
cd mobile && npx tsc --noEmit
git add mobile/lib/session.ts mobile/__tests__/session.test.ts
git commit -m "feat(mobile): secure-store session token wrappers"
```

---

### Task 3: API client (`lib/api.ts`)

**Files:**
- Create: `mobile/lib/api.ts`, `mobile/__tests__/api.test.ts`

**Interfaces:**
- Consumes: `getToken`, `clearToken` (session.ts).
- Produces: `ApiError` (class with `status`), `apiFetch<T>(path, opts?): Promise<T>` (prefixes base URL, attaches `Authorization: Bearer <token>` when a token exists, JSON in/out; on 401 clears the token and throws `ApiError(401)`); typed helpers `login(email,password): Promise<{token,user}>`, `logout(): Promise<void>`, `getLiveCalls(): Promise<LiveCall[]>`. `onUnauthorized` callback hook the auth layer can register.

- [ ] **Step 1: Write the failing test**

```ts
// mobile/__tests__/api.test.ts
jest.mock("../lib/session");
import * as session from "../lib/session";
import { apiFetch, login, ApiError, setUnauthorizedHandler } from "../lib/api";

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

describe("api client", () => {
  beforeEach(() => { jest.clearAllMocks(); (session.getToken as jest.Mock).mockResolvedValue(null); });

  it("attaches a Bearer header when a token exists", async () => {
    (session.getToken as jest.Mock).mockResolvedValue("tok123");
    const fetchMock = jest.fn().mockReturnValue(okJson({ ok: true }));
    global.fetch = fetchMock as any;
    await apiFetch("/api/me");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok123");
  });

  it("omits Authorization when no token", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson({ ok: true }));
    global.fetch = fetchMock as any;
    await apiFetch("/api/me");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("on 401 clears the token, fires the unauthorized handler, and throws ApiError(401)", async () => {
    (session.getToken as jest.Mock).mockResolvedValue("tok123");
    global.fetch = jest.fn().mockReturnValue(okJson({ error: "unauthenticated" }, 401)) as any;
    const onUnauth = jest.fn();
    setUnauthorizedHandler(onUnauth);
    await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(session.clearToken).toHaveBeenCalled();
    expect(onUnauth).toHaveBeenCalled();
  });

  it("login posts credentials and returns token+user", async () => {
    global.fetch = jest.fn().mockReturnValue(okJson({ token: "t", user: { email: "a@b.com", role: "staff" } })) as any;
    const res = await login("a@b.com", "pw");
    expect(res.token).toBe("t");
    expect(res.user.email).toBe("a@b.com");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

`cd mobile && npx jest __tests__/api.test.ts`
Expected: FAIL — `../lib/api` not found.

- [ ] **Step 3: Implement**

```ts
// mobile/lib/api.ts
import { getToken, clearToken } from "./session";

const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://phone.tcbpestcontrolcanberra.com.au").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export async function apiFetch<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });

  if (res.status === 401) {
    await clearToken();
    unauthorizedHandler?.();
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export type StaffUser = { email: string; role: "admin" | "staff" };

export async function login(email: string, password: string): Promise<{ token: string; user: StaffUser }> {
  return apiFetch("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export async function logout(): Promise<void> {
  try {
    await apiFetch("/api/logout", { method: "POST" });
  } catch { /* logout is best-effort; the local token is cleared regardless by the caller */ }
}

export type LiveCall = {
  id: string;
  caller_number: string;
  called_number: string;
  started_at: number;
  status: string;
};

export async function getLiveCalls(): Promise<LiveCall[]> {
  return apiFetch<LiveCall[]>("/api/calls/live");
}
```

- [ ] **Step 4: Run — expect PASS**

`cd mobile && npx jest __tests__/api.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Typecheck + commit**

```bash
cd mobile && npx tsc --noEmit
git add mobile/lib/api.ts mobile/__tests__/api.test.ts
git commit -m "feat(mobile): API client with Bearer auth + 401 handling"
```

---

### Task 4: Auth provider (`lib/auth.tsx`)

**Files:**
- Create: `mobile/lib/auth.tsx`, `mobile/__tests__/auth.test.tsx`

**Interfaces:**
- Consumes: `getToken`, `setToken`, `clearToken` (session.ts); `login as apiLogin`, `logout as apiLogout`, `setUnauthorizedHandler`, `StaffUser` (api.ts).
- Produces: `AuthProvider` (React component) and `useAuth(): { status: "loading"|"authed"|"anon"; user: StaffUser|null; signIn(email,password): Promise<void>; signOut(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

```tsx
// mobile/__tests__/auth.test.tsx
jest.mock("../lib/session");
jest.mock("../lib/api");
import React from "react";
import { render, waitFor, act } from "@testing-library/react-native";
import { Text } from "react-native";
import * as session from "../lib/session";
import * as api from "../lib/api";
import { AuthProvider, useAuth } from "../lib/auth";

function Probe() {
  const a = useAuth();
  return <Text testID="s">{a.status}:{a.user?.email ?? "-"}</Text>;
}

describe("auth provider", () => {
  beforeEach(() => jest.clearAllMocks());

  it("boots to anon when no token stored", async () => {
    (session.getToken as jest.Mock).mockResolvedValue(null);
    const { getByTestId } = render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(getByTestId("s").props.children.join("")).toBe("anon:-"));
  });

  it("boots to authed when a token is stored", async () => {
    (session.getToken as jest.Mock).mockResolvedValue("tok");
    const { getByTestId } = render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(getByTestId("s").props.children.join("")).toBe("authed:-"));
  });

  it("signIn stores the token and sets the user", async () => {
    (session.getToken as jest.Mock).mockResolvedValue(null);
    (api.login as jest.Mock).mockResolvedValue({ token: "t", user: { email: "a@b.com", role: "staff" } });
    let auth: ReturnType<typeof useAuth>;
    function Grab() { auth = useAuth(); return null; }
    render(<AuthProvider><Grab /></AuthProvider>);
    await act(async () => { await auth!.signIn("a@b.com", "pw"); });
    expect(session.setToken).toHaveBeenCalledWith("t");
    await waitFor(() => expect(auth!.status).toBe("authed"));
    expect(auth!.user?.email).toBe("a@b.com");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

`cd mobile && npx jest __tests__/auth.test.tsx`
Expected: FAIL — `../lib/auth` not found.

- [ ] **Step 3: Implement**

```tsx
// mobile/lib/auth.tsx
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getToken, setToken, clearToken } from "./session";
import { login as apiLogin, logout as apiLogout, setUnauthorizedHandler, type StaffUser } from "./api";

type Status = "loading" | "authed" | "anon";
type AuthValue = {
  status: Status;
  user: StaffUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<StaffUser | null>(null);

  useEffect(() => {
    // A 401 anywhere drops us to anon.
    setUnauthorizedHandler(() => { setUser(null); setStatus("anon"); });
    (async () => {
      const token = await getToken();
      setStatus(token ? "authed" : "anon");
    })();
    return () => setUnauthorizedHandler(null);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    status,
    user,
    async signIn(email, password) {
      const { token, user: u } = await apiLogin(email, password);
      await setToken(token);
      setUser(u);
      setStatus("authed");
    },
    async signOut() {
      await apiLogout();
      await clearToken();
      setUser(null);
      setStatus("anon");
    },
  }), [status, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
```

- [ ] **Step 4: Run — expect PASS**

`cd mobile && npx jest __tests__/auth.test.tsx`
Expected: 3 passing.

- [ ] **Step 5: Typecheck + commit**

```bash
cd mobile && npx tsc --noEmit
git add mobile/lib/auth.tsx mobile/__tests__/auth.test.tsx
git commit -m "feat(mobile): AuthProvider (boot-load token, signIn/signOut)"
```

---

### Task 5: Login screen + root layout auth gate

**Files:**
- Create: `mobile/lib/theme.ts`, `mobile/app/login.tsx`
- Modify: `mobile/app/_layout.tsx` (wrap in providers + gate), and replace the generated example screens under `mobile/app/(tabs)/` with our own in Task 6 (here just wire the root).

**Interfaces:**
- Consumes: `AuthProvider`, `useAuth` (lib/auth). Uses Expo Router `<Redirect>`/`router` for navigation. Root wraps `QueryClientProvider` + `AuthProvider`.

**Note:** Read the generated `mobile/app/_layout.tsx` first — adapt these edits to the actual template (Expo Router root layout conventions differ slightly by SDK). The intent is fixed; the exact JSX around the generated `<Stack>` may need small adjustments.

- [ ] **Step 1: Add the theme**

```ts
// mobile/lib/theme.ts
export const colors = {
  bg: "#0f1013", surface: "#1b1d24", border: "#26282f",
  text: "#eceef2", dim: "#a7adb8", mute: "#6d7280", brand: "#e4002b", link: "#ff5c78",
};
```

- [ ] **Step 2: Write the login screen**

```tsx
// mobile/app/login.tsx
import React, { useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim().toLowerCase(), password);
    } catch (e) {
      setError("Invalid email or password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.brand}>TCB VoIP</Text>
        <Text style={styles.subtitle}>Sign in</Text>
        {error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.label}>EMAIL</Text>
        <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address"
          autoComplete="email" value={email} onChangeText={setEmail} placeholder="you@tcb…" placeholderTextColor={colors.mute} />
        <Text style={styles.label}>PASSWORD</Text>
        <TextInput style={styles.input} secureTextEntry autoComplete="password"
          value={password} onChangeText={setPassword} />
        <Pressable style={styles.button} onPress={onSubmit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 360, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 22 },
  brand: { color: colors.text, fontWeight: "700", fontSize: 16, marginBottom: 14 },
  subtitle: { color: colors.dim, fontSize: 13, marginBottom: 16 },
  error: { color: "#ff9aab", backgroundColor: "rgba(228,0,43,0.14)", borderRadius: 8, padding: 8, marginBottom: 12, fontSize: 13 },
  label: { color: colors.dim, fontSize: 11, marginBottom: 5, letterSpacing: 1 },
  input: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, padding: 11, marginBottom: 12 },
  button: { backgroundColor: colors.brand, borderRadius: 9, padding: 13, alignItems: "center", marginTop: 4 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
```

- [ ] **Step 3: Wire the root layout (adapt to the generated file)**

Read `mobile/app/_layout.tsx`, then wrap the router in the providers + gate. Target shape:

```tsx
// mobile/app/_layout.tsx
import React from "react";
import { Stack, Redirect, useSegments } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View, ActivityIndicator } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

const queryClient = new QueryClient();

function Gate() {
  const { status } = useAuth();
  const segments = useSegments();
  const onLogin = segments[0] === "login";

  if (status === "loading") {
    return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.brand} /></View>;
  }
  if (status === "anon" && !onLogin) return <Redirect href="/login" />;
  if (status === "authed" && onLogin) return <Redirect href="/(tabs)/live" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 4: Typecheck**

`cd mobile && npx tsc --noEmit`
Expected: clean. (No jest render test here — the login screen is verified on-device; keep the logic in `auth.tsx`, which IS unit-tested.) If tsc errors reference the generated example screens still present under `(tabs)`, note them — Task 6 replaces those.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/theme.ts mobile/app/login.tsx mobile/app/_layout.tsx
git commit -m "feat(mobile): login screen + root auth gate"
```

---

### Task 6: Live Calls tab + EAS config + on-device runbook

**Files:**
- Create: `mobile/app/(tabs)/live.tsx`, `mobile/eas.json`, `docs/superpowers/runbooks/mobile-eas-first-build.md`
- Modify: `mobile/app/(tabs)/_layout.tsx` (reduce to the Live Calls tab), delete generated example tab screens.

**Interfaces:**
- Consumes: `getLiveCalls`, `LiveCall` (api.ts); `useAuth` (signOut); TanStack Query `useQuery`.

- [ ] **Step 1: Replace the tabs layout with a single Live Calls tab**

Read the generated `mobile/app/(tabs)/_layout.tsx`, then reduce it to one tab (Live Calls) and delete the other generated example screen files under `(tabs)/` (e.g. the `index.tsx`/`explore.tsx` the template ships). Target:

```tsx
// mobile/app/(tabs)/_layout.tsx
import { Tabs } from "expo-router";
import { colors } from "../../lib/theme";

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text,
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
      tabBarActiveTintColor: colors.brand, tabBarInactiveTintColor: colors.dim,
    }}>
      <Tabs.Screen name="live" options={{ title: "Live Calls" }} />
    </Tabs>
  );
}
```

- [ ] **Step 2: Write the Live Calls screen**

```tsx
// mobile/app/(tabs)/live.tsx
import React from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getLiveCalls, type LiveCall } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { colors } from "../../lib/theme";

export default function LiveScreen() {
  const { signOut } = useAuth();
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["live-calls"],
    queryFn: getLiveCalls,
    refetchInterval: 5000,
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>In progress</Text>
        <Pressable onPress={() => signOut()}><Text style={styles.signout}>Sign out</Text></Pressable>
      </View>
      {isLoading ? (
        <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
      ) : isError ? (
        <Text style={styles.muted}>Couldn't load live calls. Pull to retry.</Text>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(c: LiveCall) => c.id}
          refreshing={isRefetching}
          onRefresh={refetch}
          ListEmptyComponent={<Text style={styles.muted}>No calls in progress.</Text>}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.rowMain}>{item.caller_number} → {item.called_number}</Text>
              <Text style={styles.rowSub}>{item.status}</Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  signout: { color: colors.link, fontSize: 14 },
  muted: { color: colors.mute, marginTop: 24, textAlign: "center" },
  row: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 8 },
  rowMain: { color: colors.text, fontSize: 15 },
  rowSub: { color: colors.dim, fontSize: 12, marginTop: 2 },
});
```

- [ ] **Step 3: EAS config**

```json
// mobile/eas.json
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": {}
  }
}
```

- [ ] **Step 4: Typecheck + full mobile test run**

`cd mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all jest tests (smoke + session + api + auth) pass. If the generated example screens were deleted, confirm no dangling imports to them remain.

- [ ] **Step 5: Write the on-device runbook**

Create `docs/superpowers/runbooks/mobile-eas-first-build.md` documenting Phill's steps: create a free Expo account; `cd mobile && npx eas login`; `npx eas build:configure` (writes the EAS project id into `app.json`); **deploy Phase 1** (`npm run deploy` at repo root) so prod accepts mobile login; `npx eas build --profile development --platform android`; install the APK on the Android test phone; open it, log in with the TCB credentials, confirm Live Calls shows real in-progress calls (place a test call to see one). iOS: `--platform ios` builds via EAS; a free Apple ID installs a 7-day dev build.

- [ ] **Step 6: Commit**

```bash
git add mobile/app/(tabs)/_layout.tsx mobile/app/(tabs)/live.tsx mobile/eas.json docs/superpowers/runbooks/mobile-eas-first-build.md
git add -u mobile/app/(tabs)  # stage deletions of example screens
git commit -m "feat(mobile): Live Calls tab + EAS config + first-build runbook"
```

---

## Self-Review

**Spec coverage:**
- Scaffold in `mobile/` (Expo Router, dev-client/EAS, secure-store, react-query, jest) → Task 1. ✅
- Secure token storage → Task 2. ✅
- API client (Bearer + 401) → Task 3. ✅
- Auth provider (boot-load, signIn/signOut) → Task 4. ✅
- Login screen + root gate → Task 5. ✅
- Live Calls screen (GET /api/calls/live, polling) → Task 6. ✅
- EAS config + Phase-1-deploy dependency + on-device runbook → Task 6. ✅
- Presence toggle deliberately deferred to the follow-on screens (spec "kept minimal for the slice"). ✅

**Placeholder scan:** Tasks 1, 5, 6 intentionally instruct the implementer to READ the generated scaffold and adapt wiring — this is required because the exact template output (SDK-version-dependent) can't be known ahead of generation. The intent and target code are fully specified; only minor JSX adaptation around the generated `<Stack>`/`<Tabs>` may be needed, and the report must note any such adaptation.

**Type/interface consistency:** `getToken/setToken/clearToken` (Task 2) consumed by api.ts (Task 3) + auth.tsx (Task 4). `apiFetch`/`login`/`logout`/`getLiveCalls`/`setUnauthorizedHandler`/`ApiError`/`StaffUser`/`LiveCall` (Task 3) consumed by auth.tsx (Task 4) + live.tsx (Task 6). `AuthProvider`/`useAuth` (Task 4) consumed by _layout.tsx + login.tsx (Task 5) + live.tsx (Task 6). `colors` (Task 5) consumed by all screens.

**Verification honesty:** Every task's automated gate is `tsc --noEmit` + jest on the pure logic. No task claims the app renders/runs — on-device verification is the runbook (Task 6 Step 5), owned by Phill.
