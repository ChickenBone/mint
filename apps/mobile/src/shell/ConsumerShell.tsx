import type { ReactNode } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { router, usePathname } from "expo-router";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../auth";
import { PlayerSurface } from "../features/player/PlayerSurface";
import { colors, layout } from "../theme/tokens";
import { activeTab, consumerTabs } from "./navigation";

export function ConsumerShell({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const wide = width >= layout.wide;
  const path = usePathname();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const selected = activeTab(path);
  const primaryPage = ["/", "/search", "/library", "/player"].includes(path);
  const nav = <View accessibilityRole="tablist" style={wide ? s.sidebarTabs : s.tabs}>
    {consumerTabs.map((tab) => <Pressable key={tab.href} accessibilityRole="tab" accessibilityLabel={tab.title}
      accessibilityState={{ selected: selected === tab.href }} onPress={() => router.navigate(tab.href)}
      style={({ pressed }) => [s.tab, wide && s.sideTab, selected === tab.href && wide && s.selected, pressed && { opacity: .7 }]}>
      <Ionicons name={selected === tab.href ? tab.selectedIcon : tab.icon} size={24} color={selected === tab.href ? colors.text : colors.muted} />
      <Text style={[s.tabLabel, wide && { fontSize: 16 }, selected === tab.href && { color: colors.text }]}>{tab.title}</Text>
    </Pressable>)}
  </View>;
  return <View style={[s.root, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
    <View style={s.body}>
      {wide ? <View style={s.sidebar}>{nav}<Text style={s.sidebarCaption}>A place for all your music.</Text></View> : null}
      <View style={s.main}>
        {!primaryPage ? <View style={s.accountRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Go back" style={s.avatar}
            onPress={() => router.canGoBack() ? router.back() : router.replace(selected === "/search" ? "/search" : "/library")}><Ionicons name="arrow-back" color={colors.text} size={22} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Account and settings" onPress={() => router.push("/settings")} style={s.avatar}>
            <Text style={s.initial}>{user?.name?.slice(0, 1).toUpperCase() || "U"}</Text>
          </Pressable>
        </View> : null}
        <View style={s.route}>{children}</View>
      </View>
    </View>
    <PlayerSurface bottomInset={0} />
    {!wide ? <View style={[s.navigation, { paddingBottom: Math.max(insets.bottom, 8) }]}>{nav}</View> : <View style={{ height: insets.bottom }} />}
  </View>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, flexDirection: "row", minHeight: 0 },
  sidebar: { width: layout.sidebar, paddingHorizontal: 12, paddingTop: 24, backgroundColor: "#0b0e0f" },
  sidebarTabs: { gap: 8 }, sidebarCaption: { color: colors.muted, fontSize: 14, lineHeight: 22, padding: 12, marginTop: 32 },
  main: { flex: 1, minWidth: 0 }, route: { flex: 1, minHeight: 0 },
  accountRow: { height: 60, paddingHorizontal: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.elevated, alignItems: "center", justifyContent: "center" },
  initial: { color: colors.text, fontWeight: "700", fontSize: 18 },
  navigation: { backgroundColor: "#0b0e0f" },
  tabs: { flexDirection: "row", height: layout.tabBar },
  tab: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 4 },
  sideTab: { flex: 0, flexDirection: "row", justifyContent: "flex-start", paddingHorizontal: 12, paddingVertical: 14, gap: 16, borderRadius: 8 },
  selected: { backgroundColor: colors.elevated },
  tabLabel: { color: colors.muted, fontSize: 12, fontWeight: "600" },
});
