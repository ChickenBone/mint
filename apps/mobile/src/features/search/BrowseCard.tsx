import Ionicons from "@expo/vector-icons/Ionicons";
import { Link } from "expo-router";
import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../api";
import { browseHref, cardColor, safeArtworkUrl, type BrowseCard as Card } from "./browse-model";

export function BrowseCard({ card, width }: { card: Card; width?: number }) {
  const api = useApi();
  const [failed, setFailed] = useState(false);
  const uri = safeArtworkUrl(api, card.artwork, "Browse card");
  return <Link href={browseHref(card, card.title)} asChild><Pressable accessibilityRole="link"
    accessibilityLabel={card.detail ? `${card.title}, ${card.detail}` : card.title}
    style={StyleSheet.flatten([s.card, { backgroundColor: cardColor(card.key) }, width ? { width, flexGrow: 0, flexBasis: width } : null])}>
    {({ pressed }) => <>
    <View style={s.copy}>
      <Text numberOfLines={2} style={[s.title, s.wide]}>{card.title}</Text>
      {card.detail ? <Text numberOfLines={1} style={[s.detail, s.narrow]}>{card.detail}</Text> : null}
    </View>
    {uri && !failed ? <View style={s.sleeve} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Image accessibilityIgnoresInvertColors source={{ uri }} style={StyleSheet.absoluteFill} onError={() => {
        console.warn(`Browse card artwork could not load for ${card.key}; showing its category icon.`);
        setFailed(true);
      }} />
    </View> : <View style={s.glyph} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Ionicons name={card.icon} size={60} color="rgba(255,255,255,0.28)" />
    </View>}
    {pressed ? <View pointerEvents="none" style={s.pressed} /> : null}
    </>}
  </Pressable></Link>;
}

const s = StyleSheet.create({
  card: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, height: 108, borderRadius: 8, overflow: "hidden", padding: 14 },
  copy: { gap: 4 },
  wide: { maxWidth: "84%" },
  narrow: { maxWidth: "66%" },
  title: { color: "#ffffff", fontSize: 17, fontWeight: "800", letterSpacing: -.2, lineHeight: 21 },
  detail: { color: "rgba(255,255,255,0.86)", fontSize: 12, fontWeight: "600" },
  sleeve: {
    position: "absolute", right: -12, bottom: -14, width: 66, height: 66, transform: [{ rotate: "24deg" }],
    backgroundColor: "#1b1f21", shadowColor: "#000", shadowOpacity: .45, shadowRadius: 8, shadowOffset: { width: -2, height: 4 }, elevation: 6,
  },
  pressed: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.2)" },
  glyph: { position: "absolute", right: -6, bottom: -8, transform: [{ rotate: "24deg" }] },
});
