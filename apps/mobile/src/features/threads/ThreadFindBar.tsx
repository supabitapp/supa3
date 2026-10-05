import type { EnvironmentId, ThreadId } from "@supacode/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, View, type TextInputInstance } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { threadFindSnippetParts, type ThreadFindTarget } from "./thread-find-target";

function FindAction(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-10 w-10 items-center justify-center rounded-xl disabled:opacity-40"
    >
      <SymbolView name={props.icon} size={16} tintColorClassName="accent-icon" />
    </Pressable>
  );
}

export function ThreadFindBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly openRequest: number;
  readonly completedAt: string | null;
  readonly topInset: number;
  readonly onHeightChange: (height: number) => void;
  readonly onTargetChange: (target: ThreadFindTarget | null) => void;
}) {
  const [closedRequest, setClosedRequest] = useState(0);
  const open = props.openRequest !== 0 && props.openRequest !== closedRequest;
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [navigation, setNavigation] = useState<{
    readonly key: string;
    readonly error: string | null;
  } | null>(null);
  const offset = Math.floor(index / 50) * 50;
  const inputRef = useRef<TextInputInstance | null>(null);
  const loadAround = useAtomCommand(threadEnvironment.loadAroundHistory, { reportFailure: false });
  const atom = useMemo(
    () =>
      open && query.length > 0
        ? orchestrationEnvironment.threadMessageSearch({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, query, offset, limit: 50 },
          })
        : null,
    [open, query, offset, props.environmentId, props.threadId],
  );
  const search = useEnvironmentQuery(atom);
  const match = search.data?.matches.find((match) => match.index === index) ?? null;
  const matchKey =
    match === null ? null : `${query}:${match.index}:${match.threadId}:${match.itemId}`;
  const navigationError = navigation?.key === matchKey ? navigation.error : null;
  const loadingTarget = matchKey !== null && navigation?.key !== matchKey;
  const knownTotal = search.data?.totalMatches;
  if (knownTotal !== undefined && index >= knownTotal && index !== 0)
    setIndex(Math.max(0, knownTotal - 1));
  const { onTargetChange, onHeightChange } = props;
  useEffect(() => () => onHeightChange(0), [onHeightChange]);
  useEffect(() => {
    if (!open) onHeightChange(0);
  }, [open, onHeightChange]);
  useEffect(() => {
    if (open && props.openRequest > 0) inputRef.current?.focus();
  }, [open, props.openRequest]);
  useEffect(() => {
    const timeout = setTimeout(() => {
      setQuery(text.trim());
      setIndex(0);
    }, 200);
    return () => clearTimeout(timeout);
  }, [text]);
  const previousCompletion = useRef(props.completedAt);
  const { refresh } = search;
  useEffect(() => {
    if (previousCompletion.current === props.completedAt) return;
    previousCompletion.current = props.completedAt;
    if (open && query.length > 0) refresh();
  }, [open, props.completedAt, query, refresh]);

  useEffect(() => {
    if (!open || (match === null && !search.isPending && text.trim() === query))
      onTargetChange(null);
    if (!open || match === null || matchKey === null || search.isPending || text.trim() !== query)
      return;
    let cancelled = false;
    void loadAround({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        target: { itemId: match.itemId, threadId: match.threadId },
      },
    }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success" && result.value._tag === "loaded") {
        setNavigation({ key: matchKey, error: null });
        onTargetChange({
          itemId: match.itemId,
          threadId: match.threadId,
          navigationKey: matchKey,
          projection: result.value.projection,
        });
      } else {
        setNavigation({
          key: matchKey,
          error:
            result._tag === "Success" && result.value._tag === "error"
              ? result.value.message
              : "Could not show this match. Refresh to try again.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    match,
    matchKey,
    query,
    text,
    search.isPending,
    props.environmentId,
    props.threadId,
    loadAround,
    onTargetChange,
  ]);

  const close = useCallback(() => {
    setClosedRequest(props.openRequest);
    onTargetChange(null);
    Keyboard.dismiss();
  }, [onTargetChange, props.openRequest]);
  const dismissFromKeyboard = useCallback(() => {
    if (!open) return false;
    close();
    return true;
  }, [close, open]);
  useHardwareKeyboardCommand("paletteDismiss", dismissFromKeyboard);
  if (!open) return null;

  const pending = search.isPending || text.trim() !== query || loadingTarget;
  const total = search.data?.totalMatches ?? 0;
  const navigate = (direction: -1 | 1) => {
    if (total === 0) return;
    setIndex((current) => (current + direction + total) % total);
  };
  const snippet = match === null ? null : threadFindSnippetParts(match);
  return (
    <View
      className="absolute left-0 right-0 z-10 gap-1 border-b border-border bg-surface px-3 pb-2 pt-1"
      style={{ top: props.topInset }}
      onLayout={(event) => onHeightChange(event.nativeEvent.layout.height)}
    >
      <View className="flex-row items-center gap-1">
        <AppTextInput
          ref={inputRef}
          autoFocus
          accessibilityLabel="Find in conversation"
          placeholder="Find in conversation"
          value={text}
          onChangeText={setText}
          maxLength={200}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => navigate(1)}
          className="min-h-10 flex-1 rounded-xl px-3 py-2 text-sm"
        />
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {query.length === 0 ? "" : pending ? "…" : `${total === 0 ? 0 : index + 1}/${total}`}
        </Text>
        <FindAction
          label="Previous match"
          icon="chevron.up"
          disabled={pending || total === 0}
          onPress={() => navigate(-1)}
        />
        <FindAction
          label="Next match"
          icon="chevron.down"
          disabled={pending || total === 0}
          onPress={() => navigate(1)}
        />
        <FindAction label="Close find" icon="xmark" onPress={close} />
      </View>
      <View className="flex-row items-center gap-1">
        <View className="flex-1 gap-0.5">
          {snippet && !pending && !navigationError ? (
            <Text className="text-2xs text-foreground-muted">
              Showing messages around this match
            </Text>
          ) : null}
          {pending ? (
            <ActivityIndicator
              accessibilityLabel="Finding matches"
              colorClassName="accent-primary"
              size="small"
            />
          ) : search.error || navigationError ? (
            <Text className="text-xs text-foreground-muted">{search.error ?? navigationError}</Text>
          ) : snippet ? (
            <Text selectable className="text-xs text-foreground-muted">
              {snippet.before}
              <Text className="bg-focus/25 font-supacode-bold text-foreground">
                {snippet.match}
              </Text>
              {snippet.after}
            </Text>
          ) : query.length > 0 ? (
            <Text className="text-xs text-foreground-muted">No matches</Text>
          ) : null}
        </View>
        <FindAction
          label="Refresh matches"
          icon="arrow.clockwise"
          disabled={pending || query.length === 0}
          onPress={search.refresh}
        />
      </View>
    </View>
  );
}
