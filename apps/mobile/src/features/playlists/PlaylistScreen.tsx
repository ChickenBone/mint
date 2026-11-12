import { useState } from "react";
import { useLocalSearchParams, router } from "expo-router";
import { Modal, Text, View } from "react-native";
import { useApi } from "../../api";
import { CollectionDetail, detailStyles as s } from "../../components/music/CollectionDetail";
import { screenStyles } from "../../components/music/screen-styles";
import { Button, Field, Notice } from "../../components/ui/primitives";
import { useResource } from "../../hooks/useResource";
import { loadPlaylistDetail, playlistControls, playlistSelection } from "./playlist-model";
import { usePlaylistActions } from "./usePlaylistActions";
import { LikedImports } from "./LikedImports";

export function PlaylistScreen() {
  const params = useLocalSearchParams<{ id: string; source?: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const api = useApi();
  const [start, setStart] = useState(0);
  const detail = useResource((signal) => loadPlaylistDetail(api, id, params.source, start, signal), [api, id, params.source, start]);
  const data = detail.data;
  const title = id === "liked" ? "Liked songs" : data?.metadata?.title ?? data?.page.title ?? "Playlist";
  const { editable, copyable, deletable } = playlistControls(id, data?.metadata);
  const actions = usePlaylistActions({ api, id, source: params.source, metadata: data?.metadata, title, reload: detail.reload,
    onCopied: (copyId) => router.replace({ pathname: "/collection/[id]", params: { id: copyId } }),
    onDeleted: () => router.replace("/library") });
  return <CollectionDetail detail={detail} selection={playlistSelection(id, params.source)} title={title}
    artwork={data?.metadata?.artworkUrl || data?.page.items[0]?.thumb} liked={id === "liked"}
    annotation={params.source === "spotify" ? " · Source-managed import" : data?.metadata?.rules ? " · Smart playlist" : ""}
    description={data?.metadata?.description} start={start} onStart={setStart}
    actions={<>
      {editable ? <Button label="Rename" quiet onPress={() => { actions.setName(title); actions.setEditing(!actions.editing); }} /> : null}
      {editable ? <Button label={actions.editingSongs ? "Done editing" : "Edit songs"} quiet onPress={() => actions.setEditingSongs(!actions.editingSongs)} /> : null}
      {copyable ? <Button label="Make a copy" quiet busy={actions.busy} onPress={() => void actions.copy()} /> : null}
      {deletable ? <Button label="Delete playlist" quiet disabled={actions.busy} onPress={() => actions.setDeleting(true)} /> : null}
    </>}
    beforeTracks={<>
      {id === "liked" ? <LikedImports onReady={detail.reload} /> : null}
      {actions.editing ? <View style={s.edit}><Field label="Playlist name" value={actions.name} maxLength={200} onChangeText={actions.setName} />
        <View style={screenStyles.shortcuts}><Button label="Save" busy={actions.busy} disabled={!actions.name.trim()} onPress={() => void actions.save()} />
          <Button label="Cancel" quiet onPress={() => actions.setEditing(false)} /></View></View> : null}
      {actions.error ? <Notice title="Couldn't update playlist" message={actions.error} /> : null}
    </>}
    emptyTitle={id === "liked" ? "Your favorites start here" : "No songs yet"}
    emptyMessage={id === "liked" ? "Use a song's options to like it." : editable
      ? "Add songs using their Add to playlist action." : "There are no playable songs in this selection."}
    removeSong={(item) => {
      const entry = data?.metadata?.entries.find((candidate) => candidate.entryId === item.occurrenceId);
      return editable && entry ? () => actions.removeEntry(entry.entryId) : undefined;
    }}
    afterSong={(item) => {
      const metadata = data?.metadata;
      const entry = metadata?.entries.find((candidate) => candidate.entryId === item.occurrenceId);
      const position = entry && metadata ? metadata.entries.indexOf(entry) : -1;
      return actions.editingSongs && editable && entry ? <View style={screenStyles.shortcuts}>
        <Button label={`Move ${item.title} up`} quiet disabled={actions.busy || position <= 0} onPress={() => void actions.moveEntry(entry.entryId, -1)} />
        <Button label={`Move ${item.title} down`} quiet disabled={actions.busy || !metadata || position >= metadata.entries.length - 1} onPress={() => void actions.moveEntry(entry.entryId, 1)} />
      </View> : null;
    }}>
    <Modal visible={actions.deleting} transparent animationType="none" onRequestClose={() => { if (!actions.busy) actions.setDeleting(false); }}>
      <View style={s.overlay}><View accessibilityViewIsModal style={s.dialog}>
        <Text accessibilityRole="header" style={s.dialogTitle}>Delete this playlist?</Text>
        <Text style={s.secondary}>This removes the playlist for you and its collaborators. Songs in your server library are not deleted.</Text>
        <View style={screenStyles.shortcuts}><Button label="Delete playlist" busy={actions.busy} onPress={() => void actions.removePlaylist()} />
          <Button label="Cancel" quiet disabled={actions.busy} onPress={() => actions.setDeleting(false)} /></View>
      </View></View>
    </Modal>
  </CollectionDetail>;
}
