import { useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors } from "../../theme/tokens";

export function Button({ label, onPress, disabled, busy, quiet = false, icon }: {
  label: string; onPress: () => void; disabled?: boolean; busy?: boolean; quiet?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => [styles.button, quiet ? styles.quiet : styles.primary, (disabled || busy) && styles.disabled, pressed && styles.pressed]}>
    {busy ? <ActivityIndicator color={quiet ? colors.text : colors.actionInk} /> : icon ? <Ionicons name={icon} size={20} color={quiet ? colors.text : colors.actionInk} /> : null}
    <Text style={[styles.buttonText, { color: quiet ? colors.text : colors.actionInk }]}>{label}</Text>
  </Pressable>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} {...props} style={[styles.input, props.style]} />
  </View>;
}

export function Artwork({ uri, size = 56, round = false, liked = false }: { uri?: string | null; size?: number; round?: boolean; liked?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <View style={[styles.artwork, { width: size, height: size, borderRadius: round ? size / 2 : 0 }, liked && { backgroundColor: "#493c70" }]}>
    {uri && failed !== uri ? <Image accessibilityIgnoresInvertColors source={{ uri }} style={StyleSheet.absoluteFill} onError={() => setFailed(uri)} /> :
      <Ionicons name={liked ? "heart" : round ? "person" : "musical-notes"} size={size * .34} color={liked ? colors.text : colors.muted} />}
  </View>;
}

export function Notice({ title, message, retry, loading = false }: { title?: string; message?: string; retry?: () => void; loading?: boolean }) {
  return <View accessibilityLiveRegion="polite" style={styles.notice}>
    {loading ? <ActivityIndicator color={colors.action} /> : null}
    {title ? <Text style={styles.noticeTitle}>{title}</Text> : null}
    {message ? <Text style={styles.secondary}>{message}</Text> : null}
    {retry ? <Button label="Try again" quiet onPress={retry} /> : null}
  </View>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.section}><Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

export const styles = StyleSheet.create({
  button: { minHeight: 44, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, alignSelf: "flex-start" },
  primary: { backgroundColor: colors.action }, quiet: { backgroundColor: colors.elevated },
  disabled: { opacity: .55 }, pressed: { opacity: .75 }, buttonText: { fontSize: 14, fontWeight: "700" },
  field: { gap: 8 }, label: { color: colors.text, fontSize: 14, fontWeight: "600" },
  input: { backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.line, borderRadius: 8, color: colors.text, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  artwork: { backgroundColor: colors.elevated, overflow: "hidden", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  notice: { paddingVertical: 32, gap: 12, alignItems: "flex-start" },
  noticeTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  secondary: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  section: { gap: 16, marginTop: 32 }, sectionTitle: { color: colors.text, fontSize: 24, fontWeight: "700", letterSpacing: -.4 },
});
