import type { EnvironmentId, ThreadId, TurnItemId } from "@supacode/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  type McpAppHost,
  type McpAppHostContext,
} from "@supacode/client-runtime/mcp-apps";
import { scopeThreadRef } from "@supacode/client-runtime/environment";
import { makeMcpAppActions } from "@supacode/client-runtime/mcp-apps/actions";
import { resolveMcpAppDocumentUrl } from "@supacode/client-runtime/mcp-apps/document-url";
import {
  hydrateMcpAppToolCall,
  makeMcpAppImageReader,
} from "@supacode/client-runtime/mcp-apps/tool-call";
import { CommandId, MessageId } from "@supacode/contracts";
import {
  mcpAppAllowAttribute,
  mcpAppFileName,
  mcpAppReferencesEqual,
  type McpAppReference,
} from "@supacode/shared/mcpApp";
import * as Predicate from "effect/Predicate";
import Constants from "expo-constants";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { shareGeneratedAttachment } from "../../lib/attachmentDownload";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { assetEnvironment, useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { useThreadShell } from "../../state/entities";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const MCP_APP_ROW_HEIGHT = 420;
const ROW_BOTTOM_MARGIN = 8;

export function mcpAppRowHeight() {
  return MCP_APP_ROW_HEIGHT + ROW_BOTTOM_MARGIN;
}

function outerDocument(src: string, allow: string, secret: string) {
  const attribute = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="app" sandbox="allow-scripts allow-forms" allow="${attribute(allow)}"></iframe>
<script>(function(){var frame=document.getElementById("app"),secret=${JSON.stringify(secret)},loads=0,live=true;
var send=function(m){window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,message:m}));};
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;send({supacode:"navigated"});}});
window.addEventListener("message",function(e){if(live&&e.source===frame.contentWindow)send(e.data);});
window.__supacodeMcpAppReceive=function(m){live&&frame.contentWindow&&frame.contentWindow.postMessage(m,"*");};
frame.src=${JSON.stringify(src).replace(/</g, "\\u003c")};})();</script></body></html>`;
}

const confirm = (title: string, message: string, action: string) =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: action, onPress: () => resolve(true) },
      ],

      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

export function ThreadMcpApp(props: {
  readonly environmentId: EnvironmentId;

  readonly threadId: ThreadId;

  readonly conversationThreadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
  readonly app: McpAppReference;
  readonly width: number;

  readonly displayMode?: "inline" | "fullscreen";

  readonly onExitFullscreen?: () => void;

  readonly height?: number;
}) {
  const [app, setApp] = useState(props.app);
  if (!mcpAppReferencesEqual(app, props.app)) setApp(props.app);
  const fullscreen = props.displayMode === "fullscreen";
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [closed, setClosed] = useState(false);

  const [presentedFullscreen, setPresentedFullscreen] = useState(false);

  const [documentKey, setDocumentKeyState] = useState(0);

  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  const theme = useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: app.attachmentId,
      fileName: mcpAppFileName(app),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [app],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const refreshAsset = useRefreshAssetUrl(props.environmentId, resource);

  const [uri, setUri] = useState<string | null>(null);
  const [mintFailed, setMintFailed] = useState(false);
  const forceFreshUrl = useRef(false);
  const retriedLoad = useRef(false);
  const cachedUrl = asset._tag === "Success" ? asset.url : null;
  const cachedExpiresAt = asset._tag === "Success" ? asset.expiresAt : 0;
  const [loaded, setLoaded] = useState(false);
  const [navigatedAway, setNavigatedAway] = useState(false);

  const [generation, setGeneration] = useState(0);
  const [crashed, setCrashed] = useState(false);
  const renewDocumentUrl = () => {
    forceFreshUrl.current = true;
    setUri(null);
    setLoaded(false);
    setMintFailed(false);
  };
  const restart = () => {
    if (generation > 0) {
      setCrashed(true);
      return;
    }
    renewDocumentUrl();
    setGeneration(1);
  };
  const handleLoadError = () => {
    if (retriedLoad.current) {
      setCrashed(true);
      return;
    }
    retriedLoad.current = true;
    renewDocumentUrl();
    setDocumentKeyState((value) => value + 1);
  };

  const [secret] = useState(uuidv4);

  const setDocumentKey = (next: (value: number) => number) => {
    renewDocumentUrl();
    setNavigatedAway(false);
    setCrashed(false);
    setGeneration(0);
    retriedLoad.current = false;
    setDocumentKeyState(next);
  };

  useEffect(() => {
    if (uri !== null || (!forceFreshUrl.current && cachedUrl === null)) return;
    let cancelled = false;
    const forceRefresh = forceFreshUrl.current;
    forceFreshUrl.current = false;
    void resolveMcpAppDocumentUrl({
      cached: cachedUrl === null ? null : { url: cachedUrl, expiresAt: cachedExpiresAt },
      nowMs: Date.now(),
      refresh: refreshAsset,
      forceRefresh,
    }).then(
      (url) => {
        if (cancelled) return;
        if (url === null) setMintFailed(true);
        else setUri(url);
      },
      () => {
        if (!cancelled) setMintFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A reopened document must reauthorize its URL.
  }, [uri, cachedUrl, cachedExpiresAt, refreshAsset, documentKey, generation]);

  const openNewDocument = useRef(setDocumentKey);
  useEffect(() => {
    openNewDocument.current = setDocumentKey;
  });
  useEffect(() => {
    if (!presentedFullscreen) return;
    return navigation.addListener("focus", () => {
      openNewDocument.current((value) => value + 1);
      setPresentedFullscreen(false);
    });
  }, [navigation, presentedFullscreen]);

  const detail = useEnvironmentQuery(
    orchestrationEnvironment.turnItem({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId, revision: props.revision },
    }),
  );
  const storedItem = detail.data?.item;
  const preparedConnection = usePreparedConnection(props.environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  const updateModelContext = useAtomCommand(mcpAppEnvironment.updateModelContext, {
    reportFailure: false,
  });
  const canRead = useAtomValue(mcpAppEnvironment.readResource.permissionAtom(props.environmentId));
  const canOperate = useAtomValue(mcpAppEnvironment.callTool.permissionAtom(props.environmentId));

  const [toolDefinition, setToolDefinition] = useState<unknown>(undefined);

  const conversation = useThreadShell(
    scopeThreadRef(props.environmentId, props.conversationThreadId),
  );
  const awaitingUser =
    conversation?.hasPendingApprovals === true || conversation?.hasPendingUserInput === true;
  const live = {
    canRead,
    canOperate,
    awaitingUser,
    theme,
    props,
    callTool,
    toolInfo,
    readResource,
    updateModelContext,
    insets,
    toolDefinition,
    navigation,
  };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });
  useEffect(() => {
    let cancelled = false;
    void latest.current
      .toolInfo({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, itemId: props.itemId, name: app.tool },
      })
      .then((info) => {
        if (!cancelled && info._tag === "Success" && info.value.tool !== undefined) {
          setToolDefinition(info.value.tool);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.threadId, props.itemId, app.tool]);
  const webView = useRef<WebView<object>>(null);
  const hostRef = useRef<McpAppHost | null>(null);

  useEffect(() => {
    if (uri === null) return;
    const hostContext = (): McpAppHostContext => {
      const current = latest.current;
      const isFullscreen = current.props.displayMode === "fullscreen";
      return {
        theme: current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.theme.variables) },
        displayMode: isFullscreen ? "fullscreen" : "inline",
        availableDisplayModes: ["inline", "fullscreen"],

        containerDimensions: {
          width: current.props.width,
          height: isFullscreen ? (current.props.height ?? MCP_APP_ROW_HEIGHT) : MCP_APP_ROW_HEIGHT,
        },
        platform: "mobile",
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: `supacode/${Constants.expoConfig?.version ?? "0.0.0"}`,
        deviceCapabilities: { touch: true, hover: false },

        safeAreaInsets: isFullscreen
          ? { top: 0, right: current.insets.right, bottom: 0, left: current.insets.left }
          : { top: 0, right: 0, bottom: 0, left: 0 },
        ...(current.toolDefinition === undefined
          ? {}
          : { toolInfo: { tool: current.toolDefinition } }),
      };
    };
    const actions = makeMcpAppActions({
      app,
      current: () => ({
        target: latest.current.props,
        canRead: latest.current.canRead,
        canOperate: latest.current.canOperate,
        callTool: latest.current.callTool,
        toolInfo: latest.current.toolInfo,
        readResource: latest.current.readResource,
        updateModelContext: latest.current.updateModelContext,
        sendMessage: async (text) => {
          await enqueueThreadOutboxMessage({
            environmentId: latest.current.props.environmentId,
            threadId: latest.current.props.conversationThreadId,
            messageId: MessageId.make(uuidv4()),
            commandId: CommandId.make(uuidv4()),
            text,
            attachments: [],
            dispatchMode: "queue",
            createdAt: new Date().toISOString(),
          });
        },
      }),
      confirm: ({ kind, title, message, action }) =>
        confirm(kind === "download" ? `Save a file from ${app.server}?` : title, message, action),
      saveFile: async ({ bytes, mimeType, name }) => {
        const shared = await shareGeneratedAttachment({
          bytes,
          attachment: { name, mimeType },
          signal: new AbortController().signal,
        });
        if (!shared) throw new McpAppHostRefusal("Sharing is not available on this device.");
      },
    });
    const next = makeMcpAppHost({
      app,
      hostVersion: Constants.expoConfig?.version ?? "0.0.0",
      post: (message) =>
        webView.current?.injectJavaScript(
          `window.__supacodeMcpAppReceive&&window.__supacodeMcpAppReceive(${JSON.stringify(message)});true;`,
        ),
      hostContext,
      ...actions,
      openLink: async (url) => {
        if (!(await confirm(`Open a link from ${app.server}?`, url, "Open"))) {
          throw new McpAppHostRefusal("Declined by the user.");
        }
        if (!(await tryOpenExternalUrl(url, "mcp-app"))) {
          throw new McpAppHostRefusal("The link could not be opened.");
        }
      },
      requestDisplayMode: async (mode) => {
        const current = latest.current.props;

        if (
          mode === "fullscreen" &&
          (latest.current.awaitingUser || !latest.current.navigation.isFocused())
        ) {
          return current.displayMode ?? "inline";
        }
        if (mode === "fullscreen" && current.displayMode !== "fullscreen") {
          await hostRef.current?.teardown();

          if (latest.current.awaitingUser || !latest.current.navigation.isFocused()) {
            openNewDocument.current((value) => value + 1);
            return "inline";
          }
          setPresentedFullscreen(true);
          latest.current.navigation.navigate("ThreadMcpApp", {
            environmentId: String(current.environmentId),
            threadId: String(current.threadId),
            conversationThreadId: String(current.conversationThreadId),
            itemId: String(current.itemId),
            revision: current.revision,
          });
          return "fullscreen";
        }
        if (mode === "inline" && current.displayMode === "fullscreen") {
          await hostRef.current?.teardown();
          current.onExitFullscreen?.();
          return "inline";
        }
        return current.displayMode ?? "inline";
      },
      onRequestTeardown: () => {
        const current = latest.current.props;
        if (current.displayMode === "fullscreen") {
          void hostRef.current?.teardown().then(() => current.onExitFullscreen?.());
        } else {
          void hostRef.current?.teardown().then(() => setClosed(true));
        }
      },

      onSizeChanged: () => undefined,
    });
    hostRef.current = next;
    return () => {
      void next.teardown();
      hostRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A restarted view needs a new host.
  }, [uri, app, generation, documentKey]);

  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, props.width, props.height, insets, toolDefinition]);

  useEffect(() => {
    const host = hostRef.current;
    if (storedItem == null || httpBaseUrl === null || host === null) return;
    const controller = new AbortController();
    void hydrateMcpAppToolCall({
      item: storedItem,
      readImage: makeMcpAppImageReader({
        createUrl: (resource) =>
          createAssetUrl({ environmentId: props.environmentId, input: { resource } }),
        httpBaseUrl,
        fetch,
      }),
      signal: controller.signal,
    }).then((call) => {
      if (!controller.signal.aborted && hostRef.current === host && call !== undefined) {
        host.setToolCall(call);
      }
    });
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each document needs its own hydrated tool call.
  }, [storedItem, uri, generation, documentKey, httpBaseUrl, createAssetUrl, props.environmentId]);

  const source = useMemo(
    () =>
      uri === null
        ? null
        : { html: outerDocument(uri, mcpAppAllowAttribute(app.permissions), secret) },
    [uri, app.permissions, secret],
  );

  if (presentedFullscreen) {
    return (
      <View
        style={{ height: MCP_APP_ROW_HEIGHT, marginBottom: ROW_BOTTOM_MARGIN }}
        className="items-center justify-center rounded-lg border border-border"
      >
        <Text className="text-sm text-foreground-muted">
          The {app.server} app is open full screen
        </Text>
      </View>
    );
  }

  if (closed) {
    return (
      <View
        style={{ height: MCP_APP_ROW_HEIGHT, marginBottom: ROW_BOTTOM_MARGIN }}
        className="items-center justify-center gap-2 rounded-lg border border-border"
      >
        <Text className="text-sm text-foreground-muted">The {app.server} app was closed</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setDocumentKey((value) => value + 1);
            setClosed(false);
          }}
        >
          <Text className="text-sm text-foreground">Show app</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={
        fullscreen ? { flex: 1 } : { height: MCP_APP_ROW_HEIGHT, marginBottom: ROW_BOTTOM_MARGIN }
      }
    >
      {navigatedAway ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">
            The {app.server} app left its page and was stopped
          </Text>
        </View>
      ) : uri !== null && !crashed ? (
        <WebView<object>
          key={`${documentKey}:${generation}`}
          ref={webView}
          onContentProcessDidTerminate={restart}
          onRenderProcessGone={restart}
          source={source!}
          accessibilityLabel={`${app.server} app`}
          style={{ flex: 1, backgroundColor: "transparent" }}
          nestedScrollEnabled
          originWhitelist={["*"]}

          onShouldStartLoadWithRequest={(request) =>
            Platform.OS === "android" ||
            request.isTopFrame === false ||
            request.url === "about:blank"
          }
          setSupportMultipleWindows={false}
          onLoadEnd={() => setLoaded(true)}

          onError={handleLoadError}
          onHttpError={handleLoadError}
          onMessage={(event: WebViewMessageEvent) => {
            let envelope: unknown;
            try {
              envelope = JSON.parse(event.nativeEvent.data);
            } catch {
              return;
            }
            if (!Predicate.isObject(envelope) || envelope.secret !== secret) return;
            const message = envelope.message;
            if (Predicate.isObject(message) && message.supacode === "navigated") {
              hostRef.current?.dispose();
              setNavigatedAway(true);
              return;
            }
            hostRef.current?.receive(message);
          }}
        />
      ) : asset._tag === "Failure" || crashed || mintFailed ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">Unable to load the {app.server} app</Text>
        </View>
      ) : null}
      {!loaded && !crashed && !mintFailed && !navigatedAway && asset._tag !== "Failure" ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : null}
    </View>
  );
}
