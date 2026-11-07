import { StyleSheet } from "react-native";
import { colors } from "../../theme/tokens";

export const screenStyles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingBottom: 32, maxWidth: 1440, width: "100%", alignSelf: "center" },
  heading: { color: colors.text, fontSize: 32, fontWeight: "800", letterSpacing: -.7, marginTop: 8, marginBottom: 20 },
  shortcuts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
