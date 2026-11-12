#!/bin/sh
# Run from this directory on an existing, backed-up NAS Compose installation.
set -eu
test "$(id -u)" = 0 || { echo "Run with sudo" >&2; exit 1; }
test -f /etc/mint/settings.env
test -f /srv/mint/compose.yml
test -f /srv/mint/compose.vm.yml
python3 -c 'from zoneinfo import ZoneInfo; ZoneInfo("America/Chicago")'
systemctl stop mint-deploy.timer
# Let any existing rollout finish rather than killing a migration.
while systemctl is-active --quiet mint-deploy.service; do sleep 5; done
install -m 0755 mint-deploy.py /usr/local/sbin/mint-deploy
for unit in mint-deploy.service mint-deploy.timer mint-maintenance.service mint-maintenance.timer; do
    install -m 0644 "$unit" "/etc/systemd/system/$unit"
done
# Ubuntu's default randomized upgrade timer can restart Docker outside our window.
# Keep security updates enabled, but admit them only at 4am Central; no surprise reboots.
install -d /etc/systemd/system/apt-daily-upgrade.timer.d /etc/systemd/system/apt-daily-upgrade.service.d
cat > /etc/systemd/system/apt-daily-upgrade.timer.d/mint-window.conf <<'EOF'
[Timer]
OnCalendar=
OnCalendar=*-*-* 04:00:00 America/Chicago
RandomizedDelaySec=0
AccuracySec=1s
Persistent=false
EOF
cat > /etc/systemd/system/apt-daily-upgrade.service.d/mint-window.conf <<'EOF'
[Service]
ExecCondition=/usr/bin/python3 /usr/local/sbin/mint-deploy --check-window
EOF
cat > /etc/apt/apt.conf.d/99mint-no-surprise-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
EOF
systemctl daemon-reload
systemctl enable --now mint-deploy.timer mint-maintenance.timer
systemctl restart apt-daily-upgrade.timer
echo "Installed. Initial proxy adoption waits for the 4am Central window and a green release."
