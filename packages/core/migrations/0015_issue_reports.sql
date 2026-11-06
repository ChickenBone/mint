CREATE TABLE issue_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('playback', 'lyrics', 'music-info', 'app', 'other')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  context text CHECK (char_length(context) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX issue_reports_status_idx ON issue_reports(status, created_at);
--> statement-breakpoint
CREATE INDEX issue_reports_user_idx ON issue_reports(user_id, created_at);
