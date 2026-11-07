import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth";
import { Button, Field, Notice } from "../components/ui/primitives";
import { colors } from "../theme/tokens";

export function SignInScreen() {
  const auth = useAuth();
  const [serverUrl, setServerUrl] = useState(auth.serverUrl ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setError(null);
    try { await auth.signIn({ serverUrl: serverUrl.trim(), email: email.trim(), password }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Sign-in failed. Check your connection and try again."); }
    finally { setBusy(false); }
  }
  return <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
      <View style={s.form}>
        <Text accessibilityRole="header" style={s.title}>Your music.{"\n"}Your place.</Text>
        <Text style={s.description}>Connect to your music server and sign in with your listener account.</Text>
        <Field label="Server address" value={serverUrl} onChangeText={setServerUrl} placeholder="https://music.example.com"
          autoCapitalize="none" keyboardType="url" autoCorrect={false} textContentType="URL" />
        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none"
          autoCorrect={false} textContentType="emailAddress" autoComplete="email" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password"
          autoComplete="current-password" onSubmitEditing={() => void submit()} />
        {error || auth.error ? <Notice title="Couldn't sign in" message={error ?? auth.error ?? undefined} /> : null}
        <Button label="Sign in" onPress={() => void submit()} busy={busy} disabled={!serverUrl.trim() || !email.trim() || !password} />
        <Text style={s.description}>Use an approved account. Account access is managed by your server owner.</Text>
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: "center", padding: 24 },
  form: { width: "100%", maxWidth: 440, alignSelf: "center", gap: 20 },
  title: { color: colors.text, fontSize: 44, lineHeight: 48, fontWeight: "800", letterSpacing: -1 },
  description: { color: colors.muted, fontSize: 16, lineHeight: 24 },
});
