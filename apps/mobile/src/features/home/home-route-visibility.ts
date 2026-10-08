import { RegistryContext } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Atom } from "effect/reactivity";

export function useHomeRouteVisible(): boolean {
  const navigation =
    useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList, "Home">>();

  const [visible, setVisible] = useState(() => navigation.isFocused());
  useEffect(() => {
    const show = () => setVisible(true);
    const removeTransitionStart = navigation.addListener("transitionStart", ({ data }) => {
      if (!data.closing) show();
    });
    const removeTransitionEnd = navigation.addListener("transitionEnd", ({ data }) => {
      if (data.closing) setVisible(false);
    });

    const removeFocus = navigation.addListener("focus", show);
    return () => {
      removeTransitionStart();
      removeTransitionEnd();
      removeFocus();
    };
  }, [navigation]);
  return visible;
}

export function useHomeMinuteClock(visible: boolean): string {
  const [minute, setMinute] = useState(() => new Date().toISOString().slice(0, 16));
  useEffect(() => {
    if (!visible) return;
    const refresh = () => setMinute(new Date().toISOString().slice(0, 16));
    refresh();
    const interval = setInterval(refresh, 60_000);
    return () => clearInterval(interval);
  }, [visible]);
  return minute;
}

export function useAtomValueWhileVisible<A>(atom: Atom.Atom<A>, visible: boolean): A {
  const registry = useContext(RegistryContext);
  const held = useRef<{ readonly value: A } | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => (visible ? registry.subscribe(atom, onChange) : () => undefined),
    [registry, atom, visible],
  );
  return useSyncExternalStore(subscribe, () => {
    if (visible || held.current === null) held.current = { value: registry.get(atom) };
    return held.current.value;
  });
}
