import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests

import server


class TestServerSecurityAndAPI(unittest.TestCase):
    def setUp(self):
        server.app.config["TESTING"] = True
        self.client = server.app.test_client()

    # ── .env ローダー ───────────────────────────────────────
    def test_load_dotenv_parses_and_respects_existing_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text(
                '# comment\n'
                'TEST_BOT_A=hello\n'
                'export TEST_BOT_B="quoted value"\n'
                "TEST_BOT_C='single'\n"
                'TEST_BOT_EXISTING=from_file\n',
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"TEST_BOT_EXISTING": "from_os"}, clear=False):
                for key in ("TEST_BOT_A", "TEST_BOT_B", "TEST_BOT_C"):
                    os.environ.pop(key, None)
                server.load_dotenv(env_file)
                self.assertEqual(os.environ.get("TEST_BOT_A"), "hello")
                self.assertEqual(os.environ.get("TEST_BOT_B"), "quoted value")
                self.assertEqual(os.environ.get("TEST_BOT_C"), "single")
                self.assertEqual(os.environ.get("TEST_BOT_EXISTING"), "from_os")

    # ── 静的ファイル許可リスト ──────────────────────────────
    def test_static_allowlist_permits_game_assets(self):
        allowed = [
            "index.html",
            "colors.js",
            "css/style.css",
            "js/game.js",
            "characters/base_01/down_1_idle.png",
            "map-assets/assets/maps/town_maps.json",
        ]
        for path in allowed:
            with self.subTest(path=path):
                self.assertTrue(server.is_allowed_static_path(path))

    def test_static_allowlist_blocks_sensitive_and_traversal_paths(self):
        blocked = [
            "server.py",
            ".env",
            ".env.example",
            ".gitignore",
            "起動.bat",
            "requirements.txt",
            "create_slides.py",
            "README.md",
            "../server.py",
            "js/../server.py",
            "map-assets/.git/HEAD",
            "map-assets/scripts/split_town_blocks.py",
            "/index.html",
            "js\\game.js",
        ]
        for path in blocked:
            with self.subTest(path=path):
                self.assertFalse(server.is_allowed_static_path(path))

    def test_http_static_routes(self):
        with self.client.get("/") as resp_index:
            self.assertEqual(resp_index.status_code, 200)
            self.assertIn(b"Bot", resp_index.data)

        with self.client.get("/js/game.js") as resp_js:
            self.assertEqual(resp_js.status_code, 200)

        for secret_path in ("/server.py", "/.env", "/.env.example", "/requirements.txt"):
            with self.subTest(path=secret_path):
                with self.client.get(secret_path) as resp:
                    self.assertEqual(resp.status_code, 404)

    # ── CORS 制限 ───────────────────────────────────────────
    def test_cors_allows_localhost_and_rejects_external_origin(self):
        ok_resp = self.client.get("/tts-check", headers={"Origin": "http://127.0.0.1:8765"})
        self.assertEqual(
            ok_resp.headers.get("Access-Control-Allow-Origin"),
            "http://127.0.0.1:8765",
        )

        evil_resp = self.client.get("/tts-check", headers={"Origin": "https://evil.example"})
        self.assertIsNone(evil_resp.headers.get("Access-Control-Allow-Origin"))

    # ── /health エンドポイント (Hugging Face AI) ────────────
    @patch("server.requests.get")
    def test_health_when_hf_api_online(self, mock_get):
        fake = MagicMock(ok=True, status_code=200)
        fake.json.return_value = {"data": [{"id": "Qwen/Qwen2.5-72B-Instruct"}]}
        mock_get.return_value = fake

        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["ok"])
        self.assertTrue(data["hf_api"]["ok"])
        self.assertEqual(data["hf_api"]["provider"], "huggingface")
        self.assertEqual(data["hf_api"]["models"], ["Qwen/Qwen2.5-72B-Instruct"])
        self.assertEqual(data["tts"]["provider"], "huggingface")
        self.assertEqual(data["tts"]["repo"], "litagin/style_bert_vits2_jvnv")

    @patch("server.requests.get", side_effect=requests.exceptions.ConnectionError("refused"))
    def test_health_when_hf_api_offline(self, _mock_get):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["ok"])
        self.assertFalse(data["hf_api"]["ok"])
        self.assertIn("error", data["hf_api"])

    # ── Hugging Face メッセージ正規化 ───────────────────────
    def test_normalize_hf_messages_handles_prefill_and_fold_system(self):
        raw = [
            {"role": "system", "content": "あなたはAliceです。"},
            {"role": "user", "content": "こんにちは"},
            {"role": "user", "content": "元気？"},
            {"role": "assistant", "content": "@Bob"},
        ]
        norm = server.normalize_hf_messages(raw, fold_system=False)
        self.assertEqual(len(norm), 2)
        self.assertEqual(norm[0]["role"], "system")
        self.assertEqual(norm[1]["role"], "user")
        self.assertIn("@Bob", norm[1]["content"])

        folded = server.normalize_hf_messages(raw, fold_system=True)
        self.assertEqual(len(folded), 1)
        self.assertEqual(folded[0]["role"], "user")
        self.assertIn("あなたはAliceです。", folded[0]["content"])

    # ── /chat プロキシ & モデル自動フォールバック ───────────
    def test_chat_rejects_invalid_payload(self):
        resp_bad = self.client.post("/chat", data="not-json", content_type="application/json")
        self.assertEqual(resp_bad.status_code, 400)

        resp_missing = self.client.post("/chat", json={"model": "x"})
        self.assertEqual(resp_missing.status_code, 400)

    @patch("server.requests.post")
    def test_chat_proxies_response_with_hf_model_used(self, mock_post):
        fake = MagicMock(status_code=200)
        fake.json.return_value = {"choices": [{"message": {"content": "@Player こんにちは！"}}]}
        mock_post.return_value = fake

        resp = self.client.post(
            "/chat",
            json={"model": "Qwen/Qwen2.5-72B-Instruct", "messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertEqual(
            payload["choices"][0]["message"]["content"],
            "@Player こんにちは！",
        )
        self.assertEqual(payload["hf_model_used"], "Qwen/Qwen2.5-72B-Instruct")

    @patch("server.requests.post")
    def test_chat_falls_back_to_next_hf_model_on_503(self, mock_post):
        fail_resp = MagicMock(status_code=503, text="Model overloaded")
        fail_resp.json.return_value = {"error": {"message": "Model overloaded"}}
        ok_resp = MagicMock(status_code=200)
        ok_resp.json.return_value = {"choices": [{"message": {"content": "@Player フォールバック成功！"}}]}
        mock_post.side_effect = [fail_resp, ok_resp]

        resp = self.client.post(
            "/chat",
            json={"model": "google/gemma-2-9b-it", "messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertEqual(payload["choices"][0]["message"]["content"], "@Player フォールバック成功！")
        self.assertNotEqual(payload["hf_model_used"], "google/gemma-2-9b-it")

    @patch("server.requests.post", side_effect=requests.exceptions.ConnectionError("down"))
    def test_chat_returns_502_when_hf_api_unreachable(self, _mock_post):
        resp = self.client.post(
            "/chat",
            json={"model": "test", "messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(resp.status_code, 502)
        self.assertIn("error", resp.get_json())

    # ── /tts-local 入力検証と速度クランプ ───────────────────
    def test_parse_tts_speed_bounds(self):
        self.assertEqual(server.parse_tts_speed(0), 1.0)
        self.assertEqual(server.parse_tts_speed(-2), 1.0)
        self.assertEqual(server.parse_tts_speed("invalid"), 1.0)
        self.assertEqual(server.parse_tts_speed(float("nan")), 1.0)
        self.assertEqual(server.parse_tts_speed(float("inf")), 1.0)
        self.assertEqual(server.parse_tts_speed(0.1), 0.5)
        self.assertEqual(server.parse_tts_speed(4.0), 2.0)
        self.assertEqual(server.parse_tts_speed(1.25), 1.25)

    def test_infer_tts_style_and_character_profile(self):
        style_a, weight_a = server.infer_tts_style("やった！最高に美味しいね！", "jvnv-F2-jp")
        self.assertEqual(style_a, "Happy")
        self.assertAlmostEqual(weight_a, 0.5)
        style_n, weight_n = server.infer_tts_style("今日は穏やかな天気だね。", "amitaro")
        self.assertEqual(style_n, "Neutral")
        self.assertAlmostEqual(weight_n, 1.0)
        style_b, _ = server.infer_tts_style("まさか！びっくりしたよ！", "jvnv-M1-jp")
        self.assertEqual(style_b, "Surprise")

        sanitized = server.sanitize_tts_text("@Player 🪵×2と🪙+5を交換！街Lv.3だよ✨")
        self.assertEqual(sanitized, "木材2個と5コインを交換！街レベル3だよ")

        prof_bob = server._detect_character_profile("unsloth/gemma-3-4b-it-GGUF#bob", [])
        self.assertEqual(prof_bob["voice"], "jvnv-M1-jp")
        prof_carol = server._detect_character_profile("unsloth/gemma-3-4b-it-GGUF#carol", [])
        self.assertEqual(prof_carol["voice"], "jvnv-F2-jp")

    def test_tts_local_rejects_empty_text(self):
        resp = self.client.post("/tts-local", json={"text": "   "})
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
