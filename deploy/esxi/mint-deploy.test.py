import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mint_deploy", Path(__file__).with_name("mint-deploy.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
A, B = "a" * 40, "b" * 40


def fixture():
    return {
        "name": "mint",
        "services": {
            "web": {"image": "fixture:web", "environment": {"MINT_DOMAIN": "mint.example.com", "SECRET": "$literal"},
                    "volumes": [{"type": "bind", "source": "/private/secrets", "target": "/secrets", "read_only": True}],
                    "networks": {"edge": {}, "data": {}}, "depends_on": {"postgres": {}}},
            "caddy": {"image": "fixture:caddy", "volumes": [], "command": ["legacy"]},
            "init": {"image": "fixture:worker", "network_mode": "none"},
            "postgres": {"image": "fixture:postgres", "volumes": [{"source": "/db", "target": "/data"}]},
            "worker": {"image": "fixture:worker"},
            "hub": {"image": "fixture:worker"},
            "realtime": {"image": "fixture:realtime"},
        },
        "networks": {"edge": {"name": "mint_edge"}, "data": {"name": "mint_data"}},
    }


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root_patch = patch.object(m, "ROOT", Path(self.temporary.name))
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def test_central_window_tracks_dst_and_has_hard_boundaries(self):
        for day, hour in (("2026-01-15", 10), ("2026-07-15", 9)):
            self.assertTrue(m.maintenance_time(dt.datetime.fromisoformat(f"{day}T{hour:02}:00:00+00:00")))
            self.assertTrue(m.maintenance_time(dt.datetime.fromisoformat(f"{day}T{hour:02}:29:59+00:00")))
            self.assertFalse(m.maintenance_time(dt.datetime.fromisoformat(f"{day}T{hour:02}:30:00+00:00")))
            self.assertFalse(m.maintenance_time(dt.datetime.fromisoformat(f"{day}T{hour-1:02}:59:59+00:00")))

    def test_template_pins_images_and_preserves_literal_dollars(self):
        source = 'x-settings:\n  TOKEN: &token ""\nimage: ghcr.io/chickenbone/mint-web:latest\n'
        output = m.render(source, 'TOKEN=\'quote"and$dollar\'', A)
        self.assertIn('quote\\"and$$dollar', output)
        self.assertIn(":sha-aaaaaaa", output)
        with self.assertRaises(ValueError):
            m.render(source, "UNKNOWN=x", A)

    def test_compose_json_escapes_resolved_values_once(self):
        path = m.ROOT / "fixture.json"
        m.save_compose(path, fixture())
        self.assertEqual(m.load(path)["services"]["web"]["environment"]["SECRET"], "$$literal")

    def test_routine_allowlist_includes_rename_source_and_compare_limit(self):
        with patch.object(m, "api", return_value={"status": "ahead", "files": [{"filename": "apps/web/src/page.tsx"}]}):
            self.assertIsNone(m.reason_for_maintenance(A, B))
        for files in (
            [{"filename": "packages/core/src/db/schema.ts"}],
            [{"filename": "apps/web/package.json"}],
            [{"filename": "apps/web/a.ts", "previous_filename": "apps/worker/a.ts"}],
            [{"filename": f"docs/{i}.md"} for i in range(300)],
        ):
            with patch.object(m, "api", return_value={"status": "ahead", "files": files}):
                self.assertIsNotNone(m.reason_for_maintenance(A, B))
        with patch.object(m, "api", return_value={"status": "behind", "files": []}):
            with self.assertRaises(RuntimeError):
                m.reason_for_maintenance(A, B)

    def test_gate_requires_exact_sha_latest_ci_and_all_images(self):
        release = {"head_sha": B, "head_branch": "main", "head_repository": {"full_name": m.REPO},
                   "status": "completed", "id": 1, "run_attempt": 1, "updated_at": "one"}
        checks = [{"head_sha": B, "conclusion": "failure"}, {"head_sha": B, "conclusion": "success"}]
        jobs = [{"name": f"image ({name})", "conclusion": "success"}
                for name in ("web", "worker", "realtime", "chart-source")]
        def api(path):
            if "release.yml" in path:
                return {"workflow_runs": [release]}
            if "ci.yml" in path:
                return {"workflow_runs": checks}
            return {"jobs": jobs}
        with patch.object(m, "api", side_effect=api):
            self.assertIsNone(m.eligible({}))
            checks.pop(0)
            cache = {}
            self.assertEqual(m.eligible(cache), B)
            release["run_attempt"] = 2
            jobs[1]["conclusion"] = "failure"
            self.assertIsNone(m.eligible(cache), "a rerun must invalidate the job cache")
            checks[0]["head_sha"] = A
            self.assertIsNone(m.eligible({}))

    def test_slots_keep_public_services_off_media_network(self):
        config = m.slot_config(fixture(), "green")
        service = config["services"]["web-green"]
        self.assertNotIn("depends_on", service)
        self.assertNotIn("media", service["networks"])
        self.assertTrue(config["networks"]["data"]["external"])
        self.assertEqual(config["networks"]["edge"]["name"], "mint_edge")
        self.assertNotIn("ports", service)

    def test_storage_and_port_changes_fail_closed(self):
        old = fixture()
        new = copy.deepcopy(old)
        new["services"]["postgres"]["volumes"][0]["source"] = "/empty-db"
        with self.assertRaises(ValueError):
            m.stable_storage(old, new)
        for service in ({"ports": [{"host_ip": "0.0.0.0"}]}, {"network_mode": "host"}):
            with self.assertRaises(ValueError):
                m.private_networks({"services": {"web": service}})

    def test_manual_maintenance_flag_cannot_bypass_window(self):
        state = {"deployed": A, "proxy_ready": True, "slot": "blue"}
        m.save(m.ROOT / "deploy-state.json", state)
        args = SimpleNamespace(status=False, maintenance=True, dry_run=False)
        with patch.object(m, "eligible", return_value=B), \
                patch.object(m, "reason_for_maintenance", return_value="worker change"), \
                patch.object(m, "maintenance_time", return_value=False), \
                patch.object(m, "prepare") as prepare:
            self.assertEqual(m.execute(args), 0)
            prepare.assert_not_called()
        self.assertEqual(m.load(m.ROOT / "deploy-state.json")["pending"]["sha"], B)

    def test_emergency_runs_full_maintenance_outside_window_and_records_authorization(self):
        state = {"deployed": A, "proxy_ready": False}
        m.save(m.ROOT / "deploy-state.json", state)
        args = SimpleNamespace(status=False, maintenance=False, dry_run=False, emergency="Urgent proxy adoption")
        commands = []
        with patch.object(m, "eligible", return_value=B), \
                patch.object(m, "reason_for_maintenance", return_value="worker change"), \
                patch.object(m, "maintenance_time", return_value=False), \
                patch.object(m, "current_config", return_value=fixture()), \
                patch.object(m, "prepare", return_value=fixture()) as prepare, \
                patch.object(m, "backup") as backup, patch.object(m, "probe"), \
                patch.object(m, "compose", side_effect=lambda *a, **k: commands.append(a)):
            self.assertEqual(m.execute(args), 0)
        prepare.assert_called_once_with(B, fixture(), False)
        backup.assert_called_once()
        saved = m.load(m.ROOT / "deploy-state.json")
        self.assertEqual(saved["deployed"], B)
        self.assertEqual(saved["last_emergency"]["reason"], args.emergency)
        self.assertEqual(saved["last_emergency"]["sha"], B)
        self.assertIn("requested_at", saved["last_emergency"])
        worker = next(i for i, command in enumerate(commands) if command[-1] == "worker")
        web = next(i for i, command in enumerate(commands) if command[0] == m.ROOT / "blue.json")
        self.assertLess(worker, web)

    def test_emergency_cli_rejects_empty_multiline_and_non_deployment_requests(self):
        for flags in (
            ["--emergency", ""], ["--emergency", "  "],
            ["--emergency", "first\nsecond"], ["--emergency", "x" * 501],
            ["--emergency", "Incident", "--status"],
            ["--emergency", "Incident", "--check-window"],
        ):
            with self.subTest(flags=flags):
                result = subprocess.run([sys.executable, "-B", str(Path(m.__file__)), *flags],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("--emergency", result.stderr)

    def test_emergency_does_not_bypass_gate_or_failure_latch(self):
        args = SimpleNamespace(status=False, maintenance=False, dry_run=False, emergency="Incident")
        for state, gate in (
            ({"deployed": A}, None),
            ({"deployed": A, "in_progress": {"sha": B}}, B),
            ({"deployed": A, "last_error": "migration failed"}, B),
        ):
            with self.subTest(state=state):
                m.save(m.ROOT / "deploy-state.json", state)
                with patch.object(m, "eligible", return_value=gate), \
                        patch.object(m, "maintenance_time", return_value=False), \
                        patch.object(m, "prepare") as prepare, patch.object(m, "compose") as command:
                    with self.assertRaises(RuntimeError):
                        m.execute(args)
                    prepare.assert_not_called()
                    command.assert_not_called()
                self.assertNotIn("last_emergency", m.load(m.ROOT / "deploy-state.json"))

    def test_emergency_dry_run_does_not_authorize_or_mutate_deployment(self):
        state = {"deployed": A}
        m.save(m.ROOT / "deploy-state.json", state)
        args = SimpleNamespace(status=False, maintenance=False, dry_run=True, emergency="Incident")
        with patch.object(m, "eligible", return_value=B), \
                patch.object(m, "reason_for_maintenance", return_value="worker change"), \
                patch.object(m, "maintenance_time", return_value=False), \
                patch.object(m, "prepare") as prepare:
            self.assertEqual(m.execute(args), 0)
            prepare.assert_not_called()
        self.assertEqual(m.load(m.ROOT / "deploy-state.json"), state)
        self.assertFalse((m.ROOT / "release-jobs.json").exists())

    def test_emergency_migration_failure_still_latches_without_starting_web(self):
        m.save(m.ROOT / "deploy-state.json", {"deployed": A})
        args = SimpleNamespace(status=False, maintenance=False, dry_run=False, emergency="Incident")
        commands = []
        def compose(*args, **kwargs):
            commands.append(args)
            if args[-1] == "worker":
                raise subprocess.CalledProcessError(1, ["migration-health"])
        with patch.object(m, "eligible", return_value=B), \
                patch.object(m, "reason_for_maintenance", return_value="worker change"), \
                patch.object(m, "maintenance_time", return_value=False), \
                patch.object(m, "current_config", return_value=fixture()), \
                patch.object(m, "prepare", return_value=fixture()), patch.object(m, "backup"), \
                patch.object(m, "compose", side_effect=compose):
            with self.assertRaises(subprocess.CalledProcessError):
                m.execute(args)
        saved = m.load(m.ROOT / "deploy-state.json")
        self.assertTrue(saved["last_error"])
        self.assertEqual(saved["in_progress"]["sha"], B)
        self.assertEqual(saved["deployed"], A)
        self.assertFalse(any(command[0] == m.ROOT / "blue.json" for command in commands))

    def test_dry_run_does_not_change_state_or_cache(self):
        args = SimpleNamespace(status=False, maintenance=True, dry_run=True)
        with patch.object(m, "eligible", return_value=B), patch.object(m, "maintenance_time", return_value=False):
            self.assertEqual(m.execute(args), 0)
        self.assertEqual(list(m.ROOT.iterdir()), [])

    def test_routine_activation_only_starts_standby_and_reloads_proxy(self):
        state = {"deployed": A, "proxy_ready": True, "slot": "blue"}
        m.write(m.ROOT / "proxy" / "Caddyfile", "previous")
        commands = []
        with patch.object(m, "current_config", return_value=fixture()), \
                patch.object(m, "compose", side_effect=lambda *a, **k: commands.append(a)), \
                patch.object(m, "probe"):
            m.activate(fixture(), state, B, False)
        self.assertEqual(state["slot"], "green")
        self.assertEqual(state["deployed"], B)
        self.assertIsNone(state["in_progress"])
        for command in commands:
            self.assertNotIn("stop", command)
            self.assertNotIn("worker", command)
            self.assertNotIn("--remove-orphans", command)
        self.assertTrue(any("reload" in command for command in commands))
        self.assertIn("web-blue:3000", (m.ROOT / "proxy" / "Caddyfile").read_text())

    def test_failed_proxy_probe_restores_old_routing_and_does_not_commit_release(self):
        state = {"deployed": A, "proxy_ready": True, "slot": "blue"}
        m.write(m.ROOT / "proxy" / "Caddyfile", "previous")
        with patch.object(m, "current_config", return_value=fixture()), patch.object(m, "compose"), \
                patch.object(m, "probe", side_effect=RuntimeError("unhealthy")):
            with self.assertRaises(RuntimeError):
                m.activate(fixture(), state, B, False)
        self.assertEqual(state["deployed"], A)
        self.assertEqual((m.ROOT / "proxy" / "Caddyfile").read_text(), "previous")

    def test_unhealthy_standby_never_switches_proxy(self):
        state = {"deployed": A, "proxy_ready": True, "slot": "blue"}
        m.write(m.ROOT / "proxy" / "Caddyfile", "previous")
        with patch.object(m, "current_config", return_value=fixture()), \
                patch.object(m, "compose", side_effect=subprocess.CalledProcessError(1, ["health"])), \
                patch.object(m, "proxy_command") as proxy:
            with self.assertRaises(subprocess.CalledProcessError):
                m.activate(fixture(), state, B, False)
            proxy.assert_not_called()
        self.assertEqual((m.ROOT / "proxy" / "Caddyfile").read_text(), "previous")

    def test_retirement_is_never_allowed_outside_maintenance(self):
        with patch.object(m, "maintenance_time", return_value=False), patch.object(m, "compose") as command:
            m.retire_retained({"proxy_ready": True})
            command.assert_not_called()

    def test_interrupted_rollout_is_not_automatically_retried(self):
        m.save(m.ROOT / "deploy-state.json", {"deployed": A, "in_progress": {"sha": B}})
        with patch.object(m, "eligible") as gate:
            with self.assertRaises(RuntimeError):
                m.execute(SimpleNamespace(status=False, maintenance=True, dry_run=False))
            gate.assert_not_called()

    def test_worker_migration_health_precedes_new_web(self):
        state = {"deployed": A, "proxy_ready": True, "slot": "blue"}
        m.write(m.ROOT / "proxy" / "Caddyfile", "previous")
        commands = []
        with patch.object(m, "current_config", return_value=fixture()), \
                patch.object(m, "maintenance_time", return_value=True), \
                patch.object(m, "backup"), patch.object(m, "probe"), \
                patch.object(m, "compose", side_effect=lambda *a, **k: commands.append(a)):
            m.activate(fixture(), state, B, True)
        worker = next(i for i, args in enumerate(commands) if args[-1] == "worker")
        web = next(i for i, args in enumerate(commands) if args[0] == m.ROOT / "green.json")
        self.assertLess(worker, web)
        self.assertIn("--wait", commands[worker])

    def test_migration_failure_never_starts_new_web(self):
        state = {"deployed": A, "proxy_ready": True, "slot": "blue"}
        commands = []
        def compose(*args, **kwargs):
            commands.append(args)
            if args[-1] == "worker":
                raise subprocess.CalledProcessError(1, ["migration-health"])
        with patch.object(m, "current_config", return_value=fixture()), \
                patch.object(m, "maintenance_time", return_value=True), \
                patch.object(m, "backup"), patch.object(m, "compose", side_effect=compose):
            with self.assertRaises(subprocess.CalledProcessError):
                m.activate(fixture(), state, B, True)
        self.assertFalse(any(args[0] == m.ROOT / "green.json" for args in commands))
        self.assertEqual(state["deployed"], A)

    def test_preparation_crossing_window_cannot_start_disruptive_work(self):
        with patch.object(m, "current_config", return_value=fixture()), \
                patch.object(m, "maintenance_time", return_value=False), \
                patch.object(m, "backup") as backup, patch.object(m, "compose") as command:
            with self.assertRaises(RuntimeError):
                m.activate(fixture(), {"deployed": A}, B, True)
            backup.assert_not_called()
            command.assert_not_called()

    def test_runtime_drift_is_queued_instead_of_restarted(self):
        m.save(m.ROOT / "deploy-state.json", {"deployed": A, "proxy_ready": True, "slot": "blue"})
        with patch.object(m, "eligible", return_value=B), \
                patch.object(m, "reason_for_maintenance", return_value=None), \
                patch.object(m, "maintenance_time", return_value=False), \
                patch.object(m, "current_config", return_value=fixture()), \
                patch.object(m, "prepare", side_effect=m.MaintenanceRequired("worker env changed")), \
                patch.object(m, "activate") as activate:
            self.assertEqual(m.execute(SimpleNamespace(status=False, maintenance=False, dry_run=False)), 0)
            activate.assert_not_called()
        self.assertTrue(m.load(m.ROOT / "deploy-state.json")["pending"]["runtime_configuration"])

    def test_runtime_maintenance_reason_survives_repeated_polls(self):
        state = {"deployed": A, "proxy_ready": True, "slot": "blue",
                 "pending": {"sha": B, "runtime_configuration": True}}
        m.save(m.ROOT / "deploy-state.json", state)
        with patch.object(m, "eligible", return_value=B), \
                patch.object(m, "reason_for_maintenance", return_value=None), \
                patch.object(m, "maintenance_time", return_value=False), \
                patch.object(m, "prepare") as prepare:
            for _ in range(3):
                m.execute(SimpleNamespace(status=False, maintenance=False, dry_run=False))
            prepare.assert_not_called()
        self.assertTrue(m.load(m.ROOT / "deploy-state.json")["pending"]["runtime_configuration"])


if __name__ == "__main__":
    unittest.main()
