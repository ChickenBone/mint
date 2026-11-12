ALTER TABLE connected_devices DROP CONSTRAINT connected_devices_auth_session_id_fkey;
ALTER TABLE connected_devices ALTER COLUMN auth_session_id DROP NOT NULL;
ALTER TABLE connected_devices ADD CONSTRAINT connected_devices_auth_session_id_sessions_id_fk
  FOREIGN KEY (auth_session_id) REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE connected_devices ADD COLUMN kind text NOT NULL DEFAULT 'web';
ALTER TABLE connected_devices ADD COLUMN installation_id uuid;
ALTER TABLE connected_devices ADD COLUMN last_connected_at timestamptz NOT NULL DEFAULT now();
UPDATE connected_devices SET last_connected_at = last_seen_at;
CREATE UNIQUE INDEX connected_devices_installation_idx ON connected_devices(user_id, installation_id);
ALTER TABLE device_commands ADD COLUMN source_device_id uuid REFERENCES connected_devices(id) ON DELETE SET NULL;
