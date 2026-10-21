#!/usr/bin/env python3
"""Kayıt videoları (video klip) için regresyon testi (unittest, yalnızca okur).

Görev 36: video, belirli bir müzik kaydını temsil ettiği için Recording düzeyinde, isteğe bağlı `videos`
dizisinde tutulur. Adres saklanmaz; yalnızca doğrulanmış videoId'den türetilir. İlk video: Çok Sevince İnsanı
(w-0025 / r-0026). Görev 40'ta 48 video daha eklendi; 49 videonun playlist eşleştirmesi test_playlist_videos.py
dosyasında sınanır. Tarayıcıdaki davranış (tıklamadan önce iframe yok) ayrıca Chromium ile sınanır; burada
katalog, doğrulayıcı ve kaynak kod kuralları denetlenir.

Kullanım:
    python v2/music/tools/test_video_clips.py
"""

import copy
import hashlib
import json
import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)
sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_catalog import VIDEO_PROVIDERS, schema_errors, video_problems  # noqa: E402
from verify_content_integrity import CONTENT_SHA256  # noqa: E402

MUSIC_ROOT = Path(__file__).resolve().parent.parent
CATALOG = json.loads((MUSIC_ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
SCHEMA = json.loads((MUSIC_ROOT / "data" / "schema.json").read_text(encoding="utf-8"))
WORK_JS = (MUSIC_ROOT / "work" / "work.js").read_text(encoding="utf-8")
WORK_HTML = (MUSIC_ROOT / "work" / "index.html").read_text(encoding="utf-8")
WORKS = {w["id"]: w for w in CATALOG["works"]}
RECORDINGS = {r["id"]: r for r in CATALOG["recordings"]}

FIRST_VIDEO = {"provider": "youtube", "videoId": "7c21yJVIsJc", "videoType": "official-music-video"}
INVALID_IDS = ["", "7c21yJVIsJ", "7c21yJVIsJcX", "7c21yJVIsJc\n", " 7c21yJVIsJ", "7c21yJ IsJc", "7c21yJ%IsJc",
               "<script>a</", "javascript:", "7c21yJVIsJ\"", "7c21yJVIsJ/", "7c21yJVIsJ?", "7c21yJVIsJ#",
               "7c21yJVİsJc", 123, None, ["7c21yJVIsJc"]]


def with_videos(videos, recording_id="r-0026"):
    """Tek kayıtlı küçük bir kayıt sözlüğü; videos None ise alan yazılmaz."""
    recording = {"id": recording_id, "workId": "w-0025"}
    if videos is not None:
        recording["videos"] = videos
    return {recording_id: recording}


def codes(problems):
    return sorted({re.match(r"\[([A-Z-]+)\]", p).group(1) for p in problems})


class CatalogVideoTests(unittest.TestCase):
    def test_counts_preserved(self):
        self.assertEqual((len(WORKS), len(RECORDINGS), len(CATALOG["covers"])), (68, 68, 68))

    def test_first_video_on_cok_sevince_insani_recording(self):
        work = WORKS["w-0025"]
        self.assertEqual(work["title"], "Çok Sevince İnsanı")
        recording = RECORDINGS["r-0026"]
        self.assertEqual((recording["workId"], recording["coverId"]), ("w-0025", "c-0026"))
        self.assertEqual(recording["videos"], [FIRST_VIDEO])
        self.assertNotIn("videos", work, "video eser (Work) düzeyinde değil, kayıt düzeyinde tutulur")

    def test_each_recording_has_at_most_one_video(self):
        for recording in RECORDINGS.values():
            self.assertLessEqual(len(recording.get("videos", [])), 1, recording["id"])

    def test_video_does_not_touch_listen_links_or_content(self):
        for recording in RECORDINGS.values():
            if "videos" not in recording:
                continue
            self.assertIsNone(recording["links"]["youtube"], f"{recording['id']}: video adresi dinleme bağlantılarına kopyalanmaz")
            work = WORKS[recording["workId"]]
            for asset in (work["lyrics"], work["story"]):
                data = (MUSIC_ROOT / asset["file"]).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), CONTENT_SHA256[asset["file"]], asset["file"])

    def test_catalog_matches_schema_and_validator(self):
        self.assertEqual(schema_errors(CATALOG, SCHEMA, SCHEMA), [])
        self.assertEqual(video_problems(RECORDINGS), [])


class VideoValidatorTests(unittest.TestCase):
    def test_valid_video(self):
        self.assertEqual(video_problems(with_videos([dict(FIRST_VIDEO)])), [])
        self.assertEqual(video_problems(with_videos([dict(FIRST_VIDEO, title="Çok Sevince İnsanı")])), [])

    def test_recording_without_videos_is_unchanged(self):
        self.assertEqual(video_problems(with_videos(None)), [])

    def test_invalid_video_ids_rejected(self):
        for value in INVALID_IDS:
            with self.subTest(value=value):
                self.assertEqual(codes(video_problems(with_videos([dict(FIRST_VIDEO, videoId=value)]))), ["VID-ID"])

    def test_invalid_provider_type_and_shape_rejected(self):
        cases = {
            "VID-PROVIDER": [dict(FIRST_VIDEO, provider="vimeo"), dict(FIRST_VIDEO, provider="YouTube"),
                             dict(FIRST_VIDEO, provider=None)],
            "VID-TYPE": [dict(FIRST_VIDEO, videoType="live"), dict(FIRST_VIDEO, videoType=None)],
            "VID-TITLE": [dict(FIRST_VIDEO, title=""), dict(FIRST_VIDEO, title="   "),
                          dict(FIRST_VIDEO, title="a\nb"), dict(FIRST_VIDEO, title=5)],
        }
        for code, videos in cases.items():
            for video in videos:
                with self.subTest(code=code, video=video):
                    self.assertEqual(codes(video_problems(with_videos([video]))), [code])
        extra = dict(FIRST_VIDEO, url="https://www.youtube.com/watch?v=7c21yJVIsJc")
        self.assertIn("VID-KEYS", codes(video_problems(with_videos([extra]))))
        missing = {"provider": "youtube", "videoId": "7c21yJVIsJc"}
        self.assertIn("VID-KEYS", codes(video_problems(with_videos([missing]))))
        self.assertEqual(codes(video_problems(with_videos(["7c21yJVIsJc"]))), ["VID-KEYS"])

    def test_empty_or_non_list_rejected(self):
        for value in ([], {}, "7c21yJVIsJc", 0, False):
            with self.subTest(value=value):
                self.assertEqual(codes(video_problems(with_videos(value))), ["VID-LIST"])
        recording = {"id": "r-0026", "workId": "w-0025", "videos": None}
        self.assertEqual(codes(video_problems({"r-0026": recording})), ["VID-LIST"])

    def test_duplicate_video_rejected(self):
        recordings = {**with_videos([dict(FIRST_VIDEO)], "r-0026"), **with_videos([dict(FIRST_VIDEO)], "r-0027")}
        self.assertEqual(codes(video_problems(recordings)), ["VID-DUP"])
        self.assertEqual(codes(video_problems(with_videos([dict(FIRST_VIDEO), dict(FIRST_VIDEO)]))), ["VID-DUP"])

    def test_schema_rejects_unknown_fields_and_values(self):
        catalog = copy.deepcopy(CATALOG)
        recording = next(r for r in catalog["recordings"] if r["id"] == "r-0026")
        recording["videos"] = [dict(FIRST_VIDEO, provider="vimeo", url="x")]
        errors = schema_errors(catalog, SCHEMA, SCHEMA)
        self.assertTrue(any("provider" in e for e in errors), errors)
        self.assertTrue(any("tanımsız alan: url" in e for e in errors), errors)


class WorkPageSourceTests(unittest.TestCase):
    def test_js_and_python_id_rules_match(self):
        match = re.search(r"youtube: \{\s*id: /(.+?)/,", WORK_JS)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), "^" + VIDEO_PROVIDERS["youtube"].pattern + "$")

    def test_embed_and_watch_urls(self):
        self.assertIn('"https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0&playsinline=1"', WORK_JS)
        self.assertIn('"https://www.youtube.com/watch?v=" + id', WORK_JS)
        self.assertIn('watchLabel: "YouTube\'da İzle"', WORK_JS)

    def test_iframe_created_only_on_click(self):
        self.assertNotIn("<iframe", WORK_HTML)
        self.assertIsNone(re.search(r"youtube(-nocookie)?\.com|youtu\.be|ytimg", WORK_HTML, re.IGNORECASE))
        start = WORK_JS.index('play.addEventListener("click"')
        self.assertEqual(WORK_JS.count('el("iframe"'), 1)
        self.assertGreater(WORK_JS.index('el("iframe"'), start)
        for attribute in ('loading: "lazy"', 'allowfullscreen: true', 'referrerpolicy: "strict-origin-when-cross-origin"',
                          "title: label"):
            self.assertIn(attribute, WORK_JS)

    def test_no_html_injection_sinks(self):
        for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"):
            self.assertNotIn(sink, WORK_JS)

    def test_video_section_hidden_by_default(self):
        self.assertRegex(WORK_HTML, r'<section class="work-section" id="work-video-section" aria-labelledby="video-title" hidden>')
        self.assertIn('<h2 class="section-title" id="video-title">Video Klip</h2>', WORK_HTML)


if __name__ == "__main__":
    unittest.main(verbosity=2)
