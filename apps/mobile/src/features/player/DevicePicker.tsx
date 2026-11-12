import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectableDevice } from "@mint/client";
import { useApi } from "../../api";
import { Button, Notice } from "../../components/ui/primitives";
import { usePlayer } from "../../playback/PlayerProvider";
import { colors } from "../../theme/tokens";

export function DevicePicker() {
  const api = useApi(), player = usePlayer(), insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<{ api: typeof api; rows: ConnectableDevice[] } | null>(null);
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const trigger = useRef<ComponentRef<typeof View>>(null), heading = useRef<ComponentRef<typeof Text>>(null);
  const generation = useRef(0);
  const operation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    if (!open || !api) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const rows = await api!.devices(controller.signal);
        if (version === generation.current) { setDevices({ api, rows }); setLoadError(null); }
      } catch (failure) {
        if (!controller.signal.aborted && version === generation.current) setLoadError(failure instanceof Error ? failure.message : "Devices could not load.");
      } finally { if (!controller.signal.aborted) timer = setTimeout(load, 2000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, open, retry]);
  const rows = devices?.api === api ? devices.rows : null;
  function close() {
    ++generation.current;
    ++operation.current;
    setOpen(false);
    requestAnimationFrame(() => {
      const handle = findNodeHandle(trigger.current);
      if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
    });
  }
  async function move(id: string) {
    const version = ++operation.current;
    setBusy(true); setMessage("Waiting for the destination to confirm playback."); setError(null);
    try { await player.handoffTo(id); if (version === operation.current) setMessage("Playback moved. You can close this sheet."); }
    catch (failure) { if (version === operation.current) { setMessage(null); setError(failure instanceof Error ? failure.message : "Playback could not move."); } }
    finally { if (version === operation.current) setBusy(false); }
  }
  return <>
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel="Devices" accessibilityHint="Choose where to play"
      onPress={() => { setOpen(true); setBusy(false); setDevices(null); setError(null); setLoadError(null); setMessage(null); }}
      style={({ pressed }) => [s.trigger, pressed && s.pressed]}>
      <Ionicons name="hardware-chip-outline" size={22} color={colors.text} /><Text style={s.label}>Devices</Text>
    </Pressable>
    <Modal visible={open && !!api} transparent animationType="none" onRequestClose={close}
      onShow={() => { const handle = findNodeHandle(heading.current); if (handle) AccessibilityInfo.setAccessibilityFocus(handle); }}>
      <View style={[s.overlay, { paddingTop: insets.top + 16, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
        <View accessibilityViewIsModal style={[s.sheet, { paddingBottom: Math.max(20, insets.bottom + 16) }]}>
          <View style={s.header}><Text ref={heading} accessibilityRole="header" style={s.title}>Connect to a device</Text><Button label="Close" quiet onPress={close} /></View>
          <Text style={s.secondary}>Choose an awake player for your music. Opening this sheet does not stop playback.</Text>
          <ScrollView contentContainerStyle={s.rows}>
            {!rows && !loadError ? <ActivityIndicator accessibilityLabel="Loading devices" color={colors.action} /> : null}
            {rows?.map((device) => {
              const local = device.id === player.localDeviceId();
              const selected = rows.find((row) => row.online && row.state.playing && row.state.queueLength > 0)?.id === device.id;
              return <Pressable key={device.id} accessibilityRole="button" accessibilityLabel={`${device.name}, ${local ? "this player" : device.online ? "connected" : "offline"}`}
                accessibilityState={{ disabled: busy || selected || !device.online, selected }} disabled={busy || selected || !device.online}
                onPress={() => void move(device.id)} style={({ pressed }) => [s.row, pressed && s.pressed, !device.online && s.disabled]}>
                <Ionicons name={device.kind === "web" ? "desktop-outline" : "phone-portrait-outline"} size={24} color={local ? colors.action : colors.text} />
                <View style={s.name}><Text style={s.label}>{device.name}</Text><Text style={s.secondary}>{local ? "This player" : device.online ? device.state.playing ? "Playing" : "Connected" : "Offline - open Mint to connect"}</Text></View>
              </Pressable>;
            })}
            {rows && !rows.length ? <Text style={s.secondary}>No connected players yet. Open Mint on another signed-in device, then refresh.</Text> : null}
            {error || loadError || player.deviceError ? <Notice title="Couldn't connect" message={error || loadError || player.deviceError!} retry={() => setRetry((value) => value + 1)} /> : null}
            {message ? <Text accessibilityLiveRegion="polite" style={s.secondary}>{message}</Text> : null}
            <Button label="Refresh devices" quiet disabled={busy} onPress={() => setRetry((value) => value + 1)} />
            <Text style={s.secondary}>Web players disappear when disconnected. Installed apps stay listed for 30 days after their last Mint connection.</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}
const s = StyleSheet.create({
  trigger: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 4, padding: 8 },
  pressed: { opacity: 0.65 }, disabled: { opacity: 0.55 },
  overlay: { flex: 1, backgroundColor: "#000000b3", justifyContent: Platform.OS === "web" ? "center" : "flex-end" },
  sheet: { width: "100%", maxWidth: 560, maxHeight: "90%", alignSelf: "center", backgroundColor: colors.surface, borderRadius: 20, padding: 20 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 }, title: { flex: 1, color: colors.text, fontSize: 22, fontWeight: "700" },
  label: { color: colors.text, fontSize: 14, fontWeight: "600" }, secondary: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  rows: { gap: 12, paddingTop: 16 }, row: { flexDirection: "row", alignItems: "center", gap: 16, minHeight: 64, padding: 12, borderRadius: 12, backgroundColor: colors.background },
  name: { flex: 1, gap: 4 },
});
