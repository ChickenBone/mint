import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../auth";
import { colors } from "../../theme/tokens";

export function PageTitle({ title }: { title: string }) {
  const { user } = useAuth();
  return <View style={s.row}>
    <Pressable accessibilityRole="button" accessibilityLabel="Account and settings" style={s.avatar} onPress={() => router.push("/settings")}>
      <Text style={s.initial}>{user?.name?.slice(0, 1).toUpperCase() || "U"}</Text>
    </Pressable>
    <Text accessibilityRole="header" style={s.title}>{title}</Text>
  </View>;
}
const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 24 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: colors.elevated },
  initial: { color: colors.text, fontSize: 18, fontWeight: "700" },
  title: { color: colors.text, fontSize: 30, fontWeight: "800", letterSpacing: -.6, flex: 1 },
});
