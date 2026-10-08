// @vitest-environment jsdom
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const PAIRING_URL =
  "http://192.168.1.20:3773/pair#token=token-a&env=environment-a&routes=https://machine-a.example.com";
const OTHER_PAIRING_URL = "http://192.168.1.30:3773/pair#token=token-b";

const harness = vi.hoisted(() => ({
  cameraPermission: { granted: true, canAskAgain: true },
  onBarcodeScanned: undefined as ((result: { readonly data: string }) => void) | undefined,
  requestCameraPermission: vi.fn(),
  onChangeConnectionPairingUrl: vi.fn(),
  onConnectPress: vi.fn(),
  navigation: { canGoBack: () => true, goBack: vi.fn(), dispatch: vi.fn() },
}));

vi.mock("expo-camera", () => ({
  useCameraPermissions: () => [harness.cameraPermission, harness.requestCameraPermission],
  CameraView: (props: { readonly onBarcodeScanned: typeof harness.onBarcodeScanned }) => {
    harness.onBarcodeScanned = props.onBarcodeScanned;
    return <div data-testid="camera" />;
  },
}));
vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: (name: string) => ({ name }) },
  useIsFocused: () => true,
  useNavigation: () => harness.navigation,
  useRoute: () => ({ name: "ConnectionsNew" }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: { openSettings: vi.fn() },
  StyleSheet: { absoluteFill: {} },
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    readonly children?: ReactNode;
    readonly accessibilityLabel?: string;
    readonly disabled?: boolean;
    readonly onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-svg", () => {
  const Svg = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  return { default: Svg, Defs: Svg, RadialGradient: Svg, Rect: Svg, Stop: Svg };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../components/ScreenScrollView", () => ({
  ScreenScrollView: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
  AppTextInput: (props: {
    readonly accessibilityLabel: string;
    readonly value: string;
    readonly onChangeText: (value: string) => void;
    readonly onFocus?: () => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onInput={(event) => props.onChangeText(event.currentTarget.value)}
      onFocus={props.onFocus}
    />
  ),
}));
vi.mock("../../components/FrostedCutout", () => ({ FrostedCutout: () => null }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => ({ "--color-icon": "gray" }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: {
    readonly children: ReactNode;
    readonly actions: ReadonlyArray<{
      readonly accessibilityLabel: string;
      readonly disabled?: boolean;
      readonly onPress: () => void;
    }>;
  }) => (
    <div>
      {props.actions.map((action) => (
        <button
          key={action.accessibilityLabel}
          aria-label={action.accessibilityLabel}
          disabled={action.disabled}
          onClick={action.onPress}
        />
      ))}
      {props.children}
    </div>
  ),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  setPendingConnectionError: vi.fn(),
  useRemoteConnections: () => ({
    connectionPairingUrl: PAIRING_URL,
    pairingConnectionError: null,
    onChangeConnectionPairingUrl: harness.onChangeConnectionPairingUrl,
    onConnectPress: harness.onConnectPress,
  }),
}));

import { ConnectionsNewRouteScreen } from "./ConnectionsNewRouteScreen";

let root: Root | null = null;
let container: HTMLDivElement;

function mount() {
  act(() => root!.render(<ConnectionsNewRouteScreen route={{ params: undefined }} />));
}

function input(label: string) {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (element === null) throw new Error(`Missing ${label} input`);
  return element;
}

function button(label: string) {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (element === null) throw new Error(`Missing ${label} button`);
  return element;
}

function barcodeCallback() {
  const callback = harness.onBarcodeScanned;
  if (callback === undefined) throw new Error("Camera is not mounted");
  return callback;
}

function type(label: string, value: string) {
  const field = input(label);
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  harness.cameraPermission = { granted: true, canAskAgain: true };
  harness.onBarcodeScanned = undefined;
  harness.requestCameraPermission.mockResolvedValue({ granted: true, canAskAgain: true });
  harness.onConnectPress.mockResolvedValue(AsyncResult.success("environment-a"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

describe("Add environment scanner", () => {
  it.each(["Address", "Code"])(
    "keeps the entered pairing details when %s receives focus",
    async (label) => {
      mount();
      const queuedBarcode = barcodeCallback();
      act(() => {
        input(label).focus();
        queuedBarcode({ data: OTHER_PAIRING_URL });
      });
      expect(input("Address").value).toBe("http://192.168.1.20:3773");
      expect(input("Code").value).toBe("token-a");
      await act(async () => button("Add environment").click());
      expect(harness.onConnectPress).toHaveBeenCalledWith(PAIRING_URL, undefined);
    },
  );

  it("accepts only the first successful scan before the camera is removed", () => {
    mount();
    const queuedBarcode = barcodeCallback();
    act(() => {
      queuedBarcode({ data: OTHER_PAIRING_URL });
      queuedBarcode({ data: PAIRING_URL });
    });
    expect(input("Address").value).toBe("http://192.168.1.30:3773");
    expect(input("Code").value).toBe("token-b");
  });

  it("keeps scanning paused when permission arrives after manual focus, then allows an explicit retry", async () => {
    harness.cameraPermission = { granted: false, canAskAgain: true };
    const permission = Promise.withResolvers<typeof harness.cameraPermission>();
    harness.requestCameraPermission.mockReturnValueOnce(permission.promise);
    mount();
    act(() => button("Scan QR code").click());
    act(() => input("Address").focus());
    await act(async () => {
      harness.cameraPermission = { granted: true, canAskAgain: true };
      permission.resolve(harness.cameraPermission);
      root!.render(<ConnectionsNewRouteScreen route={{ params: undefined }} />);
    });
    expect(container.querySelector('[data-testid="camera"]')).toBeNull();
    expect(input("Address").value).toBe("http://192.168.1.20:3773");
    await act(async () => button("Scan QR code").click());
    act(() => barcodeCallback()({ data: OTHER_PAIRING_URL }));
    expect(input("Address").value).toBe("http://192.168.1.30:3773");
    expect(input("Code").value).toBe("token-b");
  });

  it("blocks queued scans while pairing and leaves manual edits available", async () => {
    const connection = Promise.withResolvers<AsyncResult.AsyncResult<string, never>>();
    harness.onConnectPress.mockReturnValueOnce(connection.promise);
    mount();
    const queuedBarcode = barcodeCallback();
    act(() => input("Address").focus());
    act(() => {
      button("Add environment").click();
      button("Scan QR code").click();
      queuedBarcode({ data: OTHER_PAIRING_URL });
    });
    expect(input("Address").value).toBe("http://192.168.1.20:3773");
    expect(input("Code").value).toBe("token-a");
    act(() => {
      type("Address", "http://192.168.1.40:3773");
      type("Code", "manually-edited-code");
      queuedBarcode({ data: OTHER_PAIRING_URL });
    });
    expect(harness.onConnectPress).toHaveBeenCalledWith(PAIRING_URL, undefined);
    expect(input("Address").value).toBe("http://192.168.1.40:3773");
    expect(input("Code").value).toBe("manually-edited-code");
    expect(button("Scan QR code").disabled).toBe(true);
    await act(async () => connection.resolve(AsyncResult.success("environment-a")));
  });
});
